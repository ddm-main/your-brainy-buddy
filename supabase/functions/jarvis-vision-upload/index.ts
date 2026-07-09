import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const BUCKET = "jarvis-vision";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { filename, contentType, bytesBase64 } = await req.json();
    if (!filename || !bytesBase64) {
      return new Response(JSON.stringify({ error: "filename + bytesBase64 required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(url, svc, { auth: { persistSession: false } });

    // decode base64 -> bytes
    const binary = atob(bytesBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const path = `${Date.now()}-${crypto.randomUUID()}-${filename}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, bytes, {
      contentType: contentType || "application/octet-stream",
      upsert: false,
    });
    if (upErr) throw upErr;

    const { data: signed, error: signErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, 60 * 5);
    if (signErr) throw signErr;

    return new Response(JSON.stringify({ path, url: signed.signedUrl }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("jarvis-vision-upload error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});