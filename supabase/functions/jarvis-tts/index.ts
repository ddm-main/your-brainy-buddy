// JARVIS text-to-speech. Streams PCM audio via SSE from Lovable AI Gateway.
// Client (see src/lib/tts.ts) decodes deltas and schedules them on AudioContext.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/audio/speech";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) {
    return new Response(
      JSON.stringify({ error: "LOVABLE_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const { text, voice = "onyx", instructions } = (await req.json()) as {
      text: string;
      voice?: string;
      instructions?: string;
    };
    if (!text || typeof text !== "string") {
      return new Response(
        JSON.stringify({ error: "text required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

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
      return new Response(
        JSON.stringify({ error: `TTS upstream ${upstream.status}: ${detail.slice(0, 200)}` }),
        { status: upstream.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(upstream.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (err) {
    if ((req as any).signal?.aborted) return new Response(null, { status: 499 });
    const msg = err instanceof Error ? err.message : String(err);
    console.error("jarvis-tts error:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});