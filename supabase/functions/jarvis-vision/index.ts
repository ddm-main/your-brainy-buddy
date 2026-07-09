import { generateText } from "npm:ai";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createLovableAiGatewayProvider } from "../_shared/ai-gateway.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) {
    return new Response(JSON.stringify({ error: "LOVABLE_API_KEY not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { image_url, kind, question } = await req.json();
    if (!image_url || typeof image_url !== "string") {
      return new Response(JSON.stringify({ error: "image_url required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
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
            { type: "image", image: new URL(image_url) },
          ],
        },
      ],
    });

    return new Response(JSON.stringify({ description: text }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("jarvis-vision error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});