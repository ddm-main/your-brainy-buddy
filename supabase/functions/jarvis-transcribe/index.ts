// JARVIS speech-to-text. Accepts multipart audio, forwards to Lovable AI Gateway.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter, checkAndBumpDailyQuota } from "../_shared/rate-limit.ts";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/audio/transcriptions";
// Must tolerate continuous-mode dictation, which polls roughly every 2.5s
// (src/lib/stt.ts) — that alone can approach ~24 calls/min in one session.
const transcribeLimiter = createSlidingWindowLimiter(60, 60_000);
const TRANSCRIBE_DAILY_REQUEST_CAP = 1500;

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
}

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

  const rl = transcribeLimiter.check(auth.userId);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }), {
      status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
    });
  }
  const quota = await checkAndBumpDailyQuota(auth.userId, { endpoint: "transcribe", requestCap: TRANSCRIBE_DAILY_REQUEST_CAP, svc: admin() });
  if (!quota.ok) {
    return new Response(JSON.stringify({ error: "quota_exhausted", reason: quota.reason, requests: quota.requests }), {
      status: 429, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) {
    return new Response(JSON.stringify({ error: "LOVABLE_API_KEY not configured" }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const inbound = await req.formData();
    const file = inbound.get("file");
    if (!(file instanceof File) || file.size < 1024) {
      return new Response(JSON.stringify({ error: "audio file required (min 1KB)" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (file.size > 24 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: "audio too large (max 24MB)" }), {
        status: 413, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const model = (inbound.get("model") as string) || "openai/gpt-4o-mini-transcribe";
    const stream = ((inbound.get("stream") as string) ?? "true") === "true";
    const language = inbound.get("language") as string | null;

    const upstream = new FormData();
    upstream.append("model", model);
    upstream.append("file", file, file.name || "recording.wav");
    if (stream) upstream.append("stream", "true");
    if (language) upstream.append("language", language);

    const res = await fetch(GATEWAY, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: upstream,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`jarvis-transcribe: upstream ${res.status}:`, detail);
      return new Response(
        JSON.stringify({ error: `Transcription service unavailable (upstream ${res.status}).` }),
        { status: res.status, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    if (!stream) {
      const json = await res.json();
      return new Response(JSON.stringify(json), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response(res.body, {
      headers: {
        ...cors,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
      },
    });
  } catch (err) {
    return sanitizedErrorResponse(err, "Transcription failed", "jarvis-transcribe", cors);
  }
});
