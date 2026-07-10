import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyState } from "../_shared/oauth-state.ts";

// Public endpoint (no JWT). Google redirects the browser here with ?code&state.
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  const errDescription = url.searchParams.get("error_description");

  let payload: { uid: string; aid: string; origin?: string } | null = null;
  if (state) payload = await verifyState<{ uid: string; aid: string; origin?: string }>(state);

  const destinationUrl = (params: Record<string, string>) => {
    const origin = payload?.origin || "https://simply-helpful-bot.lovable.app";
    const to = new URL("/config/email", origin);
    if (payload?.aid) to.searchParams.set("aid", payload.aid);
    for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
    return to;
  };

  const finishOAuth = (params: Record<string, string>) => {
    const to = destinationUrl(params);
    // Redirect the popup back to the app. The app's /config/email page reads
    // ?connected / ?gmail_error / ?aid, posts the result to window.opener, and
    // closes itself. A 302 avoids the Functions runtime stripping our
    // Content-Type and rendering inline HTML as plain text.
    return new Response(null, { status: 302, headers: { Location: to.toString() } });
  };


  if (err) return finishOAuth({ gmail_error: errDescription || err });
  if (!code || !payload) return finishOAuth({ gmail_error: "invalid_state" });

  try {
    const clientId = (Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") ?? "").trim();
    const clientSecret = (Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") ?? "").trim();
    const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").trim();
    const redirectUri = `${supabaseUrl}/functions/v1/gmail-oauth-callback`;

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    });
    const tok = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error("google token exchange failed:", tok);
      return finishOAuth({ gmail_error: tok.error_description || tok.error || "token_exchange_failed" });
    }

    // Fetch userinfo to get email + sub.
    const uiRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    const ui = await uiRes.json();
    if (!uiRes.ok) return finishOAuth({ gmail_error: "userinfo_failed" });

    const svc = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    const expiresAt = new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000).toISOString();
    const patch: Record<string, unknown> = {
      google_sub: ui.sub,
      email_address: ui.email,
      provider: "gmail",
      access_token: tok.access_token,
      token_expires_at: expiresAt,
      scopes: tok.scope,
      connected_at: new Date().toISOString(),
      sync_status: "pending",
      last_error: null,
    };
    if (tok.refresh_token) patch.refresh_token = tok.refresh_token;

    // Update the row the user started from.
    const { error: updErr } = await svc.from("email_accounts").update(patch).eq("id", payload.aid).eq("user_id", payload.uid);
    if (updErr) {
      console.error("update failed:", updErr);
      return finishOAuth({ gmail_error: updErr.message });
    }

    return finishOAuth({ connected: ui.email || "1" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("gmail-oauth-callback:", msg);
    return finishOAuth({ gmail_error: msg });
  }
});
