import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter, checkAndBumpDailyQuota } from "../_shared/rate-limit.ts";
import { z } from "npm:zod";

const BUCKET = "jarvis-vision";
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const ALLOWED_MIME = /^image\/(png|jpeg|webp)$/;
const Body = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().regex(ALLOWED_MIME),
  bytesBase64: z.string().min(1),
});
// Always paired 1:1 with a jarvis-vision call from captureAndDescribe — same
// reasoning as that endpoint's caps.
const uploadLimiter = createSlidingWindowLimiter(20, 60_000);
const UPLOAD_DAILY_REQUEST_CAP = 300;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);

  const auth = await requireUserId(req);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const uid = auth.userId;

  // Built early (not just for storage) so the same service-role client
  // instance backs both the quota RPC below and the storage calls in the
  // try block — no second client construction.
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const rl = uploadLimiter.check(uid);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }), {
      status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
    });
  }
  const quota = await checkAndBumpDailyQuota(uid, { endpoint: "vision_upload", requestCap: UPLOAD_DAILY_REQUEST_CAP, svc: supabase });
  if (!quota.ok) {
    return new Response(JSON.stringify({ error: "quota_exhausted", reason: quota.reason, requests: quota.requests }), {
      status: 429, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return new Response(JSON.stringify({ error: "invalid_input", details: parsed.error.flatten() }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const { filename, contentType, bytesBase64 } = parsed.data;

    // decode base64 -> bytes
    const binary = atob(bytesBase64);
    if (binary.length > MAX_BYTES) {
      return new Response(JSON.stringify({ error: `file too large (max ${MAX_BYTES} bytes)` }), {
        status: 413, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // Magic-byte sniff — MIME string alone is trivially spoofable.
    // PNG: 89 50 4E 47 · JPEG: FF D8 FF · WEBP: "RIFF"…"WEBP"
    const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isWebp = bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
                   bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    if (!isPng && !isJpeg && !isWebp) {
      return new Response(JSON.stringify({ error: "file is not a PNG/JPEG/WEBP image" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Scope path to the uploader's uid — required by storage RLS.
    const safeName = String(filename).replace(/[^\w.\-]/g, "_").slice(0, 80);
    const path = `${uid}/${Date.now()}-${crypto.randomUUID()}-${safeName}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, bytes, {
      contentType: contentType,
      upsert: false,
    });
    if (upErr) throw upErr;

    const { data: signed, error: signErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, 60 * 5);
    if (signErr) throw signErr;

    return new Response(JSON.stringify({ path, url: signed.signedUrl }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return sanitizedErrorResponse(err, "Upload failed", "jarvis-vision-upload", cors);
  }
});
