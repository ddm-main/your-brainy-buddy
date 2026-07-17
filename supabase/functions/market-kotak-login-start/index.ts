// market-kotak-login-start — real Kotak Neo v2 login.
// If a TOTP secret is stored we log in unattended (auto: true).
// Otherwise we mark pending_otp and the UI collects the app's TOTP code.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { KOTAK_SETTINGS_COLS, type KotakSettings, kotakAutoLogin, persistSession } from "../_shared/market/kotakClient.ts";
import { encryptValue } from "../_shared/market/provider.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const svc = svcClient();
    const { data, error } = await svc.from("market_api_settings")
      .select(KOTAK_SETTINGS_COLS)
      .eq("user_id", auth.userId).eq("active_provider", "kotak_neo").maybeSingle();
    if (error) return errorResponse(req, error.message);
    const s = data as KotakSettings | null;
    const missing = [
      !s?.consumer_key && "consumer key",
      !s?.mobile_number_enc && "mobile number",
      !s?.mpin_enc && "MPIN",
      !s?.ucc && "UCC",
    ].filter(Boolean);
    if (missing.length) {
      return errorResponse(req, `Save Kotak credentials first — missing: ${missing.join(", ")}.`);
    }

    if (s.totp_secret_enc) {
      try {
        const sess = await kotakAutoLogin(s);
        await persistSession(svc, s, sess, encryptValue);
        return jsonResponse(req, { ok: true, auto: true, greeting_name: sess.greetingName });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await svc.from("market_api_settings")
          .update({ connection_status: "error", last_error: msg })
          .eq("id", s.id);
        return errorResponse(req, `Auto-login failed: ${msg}`, 502);
      }
    }

    await svc.from("market_api_settings")
      .update({ connection_status: "pending_otp", last_error: null })
      .eq("id", s.id);
    return jsonResponse(req, { ok: true, needs_totp: true, message: "Enter the 6-digit TOTP from your authenticator app." });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
