import { generateText } from "npm:ai";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { createLovableAiGatewayProvider } from "../_shared/ai-gateway.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter, checkAndBumpDailyQuota } from "../_shared/rate-limit.ts";

// Natural ceiling is already ~15/min from the client's 4s debounce
// (jarvisChat.ts: Date.now() - lastVisionAt < 4000) — this backstops it
// server-side.
const visionLimiter = createSlidingWindowLimiter(20, 60_000);
const VISION_DAILY_REQUEST_CAP = 300;

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);

  const auth = await requireUserId(req);
  if ("error" in auth) {
    return new Response(await auth.error.text(), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const rl = visionLimiter.check(auth.userId);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }), {
      status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
    });
  }
  const quota = await checkAndBumpDailyQuota(auth.userId, { endpoint: "vision", requestCap: VISION_DAILY_REQUEST_CAP, svc: admin() });
  if (!quota.ok) {
    return new Response(JSON.stringify({ error: "quota_exhausted", reason: quota.reason, requests: quota.requests }), {
      status: 429, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) {
    return new Response(JSON.stringify({ error: "LOVABLE_API_KEY not configured" }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const { image_url, kind, question } = await req.json();
    if (!image_url || typeof image_url !== "string") {
      return new Response(JSON.stringify({ error: "image_url required" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // SSRF guard: allow only https URLs on our Supabase project's storage host.
    const supabaseHost = new URL(Deno.env.get("SUPABASE_URL")!).host;
    let parsed: URL;
    try { parsed = new URL(image_url); } catch {
      return new Response(JSON.stringify({ error: "invalid image_url" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (parsed.protocol !== "https:" || parsed.host !== supabaseHost) {
      return new Response(JSON.stringify({ error: "image_url must be a signed URL on this project's storage" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const gateway = createLovableAiGatewayProvider(key);
    const prompt = question || (kind === "camera"
      ? "What do you see through the camera? One or two sentences, JARVIS voice."
      : "Describe what is on the user's screen. One or two sentences, JARVIS voice, focused on what matters.");

    const { text } = await generateText({
      model: gateway("google/gemini-3-flash-preview"),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image", image: parsed },
          ],
        },
      ],
    });

    return new Response(JSON.stringify({ description: text }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return sanitizedErrorResponse(err, "Vision request failed", "jarvis-vision", cors);
  }
});
