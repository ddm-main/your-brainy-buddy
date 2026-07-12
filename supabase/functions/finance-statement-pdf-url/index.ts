// Issues a short-lived signed URL for a statement's original PDF. The
// statement-pdfs bucket is private (no anon/public read) — this is the only
// path a browser can use to view/download the original file.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";

const BUCKET = "statement-pdfs";
const EXPIRY_SECONDS = 300;

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

  try {
    const { statement_id } = await req.json();
    if (!statement_id) {
      return new Response(JSON.stringify({ error: "statement_id required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(url, svc, { auth: { persistSession: false } });

    const { data: statement, error: findErr } = await supabase
      .from("statements")
      .select("id, user_id, file_path")
      .eq("id", statement_id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!statement || statement.user_id !== uid || !statement.file_path) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const { data: signed, error: signErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(statement.file_path, EXPIRY_SECONDS);
    if (signErr) throw signErr;

    return new Response(JSON.stringify({ url: signed.signedUrl }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return sanitizedErrorResponse(err, "Could not open that statement", "finance-statement-pdf-url", cors);
  }
});
