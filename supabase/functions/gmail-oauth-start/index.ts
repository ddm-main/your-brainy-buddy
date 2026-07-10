import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { signState } from "../_shared/oauth-state.ts";

const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
];

function googleAuthorizeUrl(params: Record<string, string>): string {
  const qs = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `https://accounts.google.com/o/oauth2/v2/auth?${qs}`;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);

  const auth = await requireUserId(req);
  if ("error" in auth) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

  const clientId = (Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") ?? "").trim();
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").trim();
  if (!clientId) return new Response(JSON.stringify({ error: "GOOGLE_OAUTH_CLIENT_ID not configured", hint: "Add the secret in Supabase → Edge Functions → Secrets, then redeploy." }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  if (!clientId.endsWith(".apps.googleusercontent.com")) {
    return new Response(JSON.stringify({ error: "GOOGLE_OAUTH_CLIENT_ID looks malformed", hint: "The value must end in .apps.googleusercontent.com and contain no whitespace. Re-paste it in Supabase secrets." }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }

  try {
    const { account_id } = await req.json();
    if (!account_id) return new Response(JSON.stringify({ error: "account_id required" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

    // Confirm account belongs to caller.
    const svc = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: acct, error } = await svc.from("email_accounts").select("id, user_id, email_address").eq("id", account_id).maybeSingle();
    if (error) throw error;
    if (!acct || acct.user_id !== auth.userId) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });

    const origin = req.headers.get("Origin") ?? "";
    const state = await signState({ uid: auth.userId, aid: account_id, origin });
    const redirectUri = `${supabaseUrl}/functions/v1/gmail-oauth-callback`;

    const url = googleAuthorizeUrl({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
      ...(acct.email_address ? { login_hint: acct.email_address } : {}),
    });

    const masked = clientId.length > 16 ? `…${clientId.slice(-24)}` : clientId;
    console.log("gmail-oauth-start authorize url:", url.replace(clientId, masked));


    return new Response(JSON.stringify({ url }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("gmail-oauth-start:", msg);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
