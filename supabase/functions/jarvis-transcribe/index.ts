// JARVIS speech-to-text. Accepts multipart audio, forwards to Lovable AI
// Gateway `openai/gpt-4o-mini-transcribe`, streams SSE (transcript.text.delta
// + transcript.text.done) back to the client.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/audio/transcriptions";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) {
    return new Response(JSON.stringify({ error: "LOVABLE_API_KEY not configured" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const inbound = await req.formData();
    const file = inbound.get("file");
    if (!(file instanceof File) || file.size < 1024) {
      return new Response(JSON.stringify({ error: "audio file required (min 1KB)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (file.size > 24 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: "audio too large (max 24MB)" }), {
        status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
      return new Response(
        JSON.stringify({ error: `transcription failed (${res.status})`, detail: detail.slice(0, 400) }),
        { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!stream) {
      const json = await res.json();
      return new Response(JSON.stringify(json), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(res.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("jarvis-transcribe:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
