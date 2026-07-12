import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter, checkAndBumpDailyQuota } from "../_shared/rate-limit.ts";

const BUCKET = "jarvis-vision";
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const ALLOWED_MIME = /^image\/(png|jpeg|webp)$/;
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
    const { filename, contentType, bytesBase64 } = await req.json();
    if (!filename || !bytesBase64) {
      return new Response(JSON.stringify({ error: "filename + bytesBase64 required" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (!ALLOWED_MIME.test(String(contentType || ""))) {
      return new Response(JSON.stringify({ error: "contentType must be image/png|jpeg|webp" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // decode base64 -> bytes
    const binary = atob(bytesBase64);
    if (binary.length > MAX_BYTES) {
      return new Response(JSON.stringify({ error: `file too large (max ${MAX_BYTES} bytes)` }), {
        status: 413, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

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
