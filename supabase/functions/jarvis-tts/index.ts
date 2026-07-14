// JARVIS text-to-speech. Streams PCM audio via SSE from Lovable AI Gateway.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter, checkAndBumpDailyQuota } from "../_shared/rate-limit.ts";
import { z } from "npm:zod";

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/audio/speech";
const Body = z.object({
  text: z.string().min(1).max(4000),
  voice: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer", "coral", "sage", "ash", "verse"]).optional(),
  instructions: z.string().max(1000).optional(),
});
const ttsLimiter = createSlidingWindowLimiter(30, 60_000);
const TTS_DAILY_REQUEST_CAP = 800;

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

  const rl = ttsLimiter.check(auth.userId);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }), {
      status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
    });
  }
  const quota = await checkAndBumpDailyQuota(auth.userId, { endpoint: "tts", requestCap: TTS_DAILY_REQUEST_CAP, svc: admin() });
  if (!quota.ok) {
    return new Response(JSON.stringify({ error: "quota_exhausted", reason: quota.reason, requests: quota.requests }), {
      status: 429, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) {
    return new Response(
      JSON.stringify({ error: "LOVABLE_API_KEY not configured" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  try {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return new Response(JSON.stringify({ error: "invalid_input", details: parsed.error.flatten() }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const { text, voice = "onyx", instructions } = parsed.data;

    const upstream = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini-tts",
        input: text.slice(0, 4000),
        voice,
        instructions:
          instructions ??
          "Speak with the calm, precise, lightly witty confidence of Iron Man's JARVIS. British accent, low and warm.",
        stream_format: "sse",
        response_format: "pcm",
      }),
      signal: req.signal,
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      console.error(`jarvis-tts: upstream ${upstream.status}:`, detail);
      return new Response(
        JSON.stringify({ error: `Speech service unavailable (upstream ${upstream.status}).` }),
        { status: upstream.status, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    return new Response(upstream.body, {
      headers: { ...cors, "Content-Type": "text/event-stream" },
    });
  } catch (err) {
    if ((req as any).signal?.aborted) return new Response(null, { status: 499 });
    return sanitizedErrorResponse(err, "Speech synthesis failed", "jarvis-tts", cors);
  }
});
