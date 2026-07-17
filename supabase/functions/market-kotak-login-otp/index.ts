// market-kotak-login-otp — complete Kotak Neo login with a manual TOTP code.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { KOTAK_SETTINGS_COLS, type KotakSettings, kotakLogin, persistSession, KotakError } from "../_shared/market/kotakClient.ts";
import { encryptValue } from "../_shared/market/provider.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const b = await req.json().catch(() => ({}));
    const code = String(b?.otp ?? "").trim();
    if (!/^\d{4,8}$/.test(code)) return errorResponse(req, "Enter the numeric TOTP code from your authenticator app.");

    const svc = svcClient();
    const { data, error } = await svc.from("market_api_settings")
      .select(KOTAK_SETTINGS_COLS)
      .eq("user_id", auth.userId).eq("active_provider", "kotak_neo").maybeSingle();
    if (error) return errorResponse(req, error.message);
    const s = data as KotakSettings | null;
    if (!s) return errorResponse(req, "No Kotak configuration found. Save credentials first.");

    try {
      const sess = await kotakLogin(s, code);
      await persistSession(svc, s, sess, encryptValue);
      return jsonResponse(req, { ok: true, greeting_name: sess.greetingName, ucc: sess.ucc });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = e instanceof KotakError ? (e.status >= 500 ? 502 : 400) : 502;
      await svc.from("market_api_settings")
        .update({ connection_status: "error", last_error: msg })
        .eq("id", s.id);
      return errorResponse(req, `Kotak login failed: ${msg}`, status);
    }
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
