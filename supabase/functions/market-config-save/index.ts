// market-config-save — save/activate provider config; encrypts secrets.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { encryptStatementPassword } from "../_shared/crypto.ts";
import { base32Decode } from "../_shared/market/totp.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const auth = await requireUserId(req);
    if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
    const b = await req.json().catch(() => ({}));
    const provider = String(b?.provider ?? "kotak_neo");
    const svc = svcClient();

    const enc = async (v: unknown) => {
      if (typeof v !== "string" || !v) return null;
      return JSON.stringify(await encryptStatementPassword(v));
    };

    const patch: Record<string, unknown> = { user_id: auth.userId, active_provider: provider, updated_at: new Date().toISOString() };
    if (b?.consumer_key !== undefined) patch.consumer_key = b.consumer_key;
    if (b?.mobile_number) patch.mobile_number_enc = await enc(b.mobile_number);
    if (b?.mpin) patch.mpin_enc = await enc(b.mpin);
    if (b?.totp_secret) {
      // Authenticator apps commonly display the secret grouped for
      // readability ("JBSW-Y3DP-EHPK-3PXP" or with spaces) — strip both,
      // not just whitespace, before validating. Reject anything that still
      // isn't valid base32 right here instead of silently storing it: a bad
      // secret otherwise only surfaces as a cryptic decode error at the
      // worst possible time (mid-login, or on the unattended nightly cron),
      // and once stored it gets retried and fails identically forever.
      const cleaned = String(b.totp_secret).replace(/[\s-]+/g, "").toUpperCase();
      try {
        base32Decode(cleaned);
      } catch {
        return errorResponse(req, "That TOTP secret isn't valid base32 (letters A-Z and digits 2-7 only) — check for typos or extra characters copied from your broker.", 400);
      }
      patch.totp_secret_enc = await enc(cleaned);
    }
    if (b?.ucc !== undefined) patch.ucc = String(b.ucc).trim().toUpperCase() || null;
    // Shoonya OAuth credentials. `ucc` is the Noren uid/actid; Client ID and
    // Secret Code come from Shoonya's API key generation screen.
    if (provider === "shoonya") {
      if (b?.vendor_code !== undefined) patch.vendor_code = String(b.vendor_code).trim() || null;
      if (b?.api_secret) patch.api_secret_enc = await enc(String(b.api_secret).trim());
      if (b?.imei !== undefined) patch.imei = String(b.imei).trim() || null;
      // A credential change invalidates any session minted from the old ones.
      if (b?.api_secret || b?.vendor_code !== undefined || b?.ucc !== undefined) {
        patch.session_token_enc = null;
        patch.connection_status = "disconnected";
        patch.token_expires_at = null;
      }
    }
    if (b?.base_url !== undefined) patch.base_url = b.base_url;
    if (b?.ws_url !== undefined) patch.ws_url = b.ws_url;

    const { error } = await svc.from("market_api_settings").upsert(patch, { onConflict: "user_id,active_provider" });
    if (error) return errorResponse(req, error.message, 400);
    return jsonResponse(req, { ok: true });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
