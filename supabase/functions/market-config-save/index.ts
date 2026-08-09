// market-config-save — save/activate provider config; encrypts secrets.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { encryptStatementPassword } from "../_shared/crypto.ts";
import { base32Decode } from "../_shared/market/totp.ts";
import { invalidateSystemFeedCache } from "../_shared/market/provider.ts";


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

    // A connection is either the caller's own trading account ('account') or
    // an app-wide market-data feed ('data', admin-only).
    const purpose = String(b?.purpose ?? "account") === "data" ? "data" : "account";
    if (purpose === "data") {
      const isAdmin = await svc
        .from("user_roles").select("role").eq("user_id", auth.userId).eq("role", "admin").maybeSingle()
        .then((r) => !!r.data, () => false);
      if (!isAdmin) return errorResponse(req, "admin_only", 403);
    }

    const patch: Record<string, unknown> = { user_id: auth.userId, active_provider: provider, purpose, updated_at: new Date().toISOString() };

    if (b?.consumer_key !== undefined) patch.consumer_key = b.consumer_key;
    if (b?.mobile_number) patch.mobile_number_enc = await enc(b.mobile_number);
    if (b?.mpin) {
      // Kotak enforces max length 6 on Mpin — reject bad input at save time
      // instead of failing mid-login with a cryptic broker 400.
      const mpin = String(b.mpin).replace(/\D/g, "");
      if (mpin.length < 4 || mpin.length > 6) {
        return errorResponse(req, "MPIN must be 4–6 digits.");
      }
      patch.mpin_enc = await enc(mpin);
    }
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
    // Any broker credential change invalidates sessions encrypted with the
    // previous values/key. Mark the provider disconnected and clear the stale
    // error so the next login always starts from the newly saved credentials.
    if (provider === "kotak_neo" && (b?.mobile_number || b?.mpin || b?.totp_secret)) {
      patch.view_token_enc = null;
      patch.session_token_enc = null;
      patch.sid = null;
      patch.hs_server_id = null;
      patch.token_expires_at = null;
      patch.connection_status = "disconnected";
      patch.last_error = null;
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

    // Upsert by hand: the unique index is (user_id, active_provider, purpose),
    // but relying on ON CONFLICT inference breaks whenever the index/schema
    // cache is out of step. Look the row up, then update or insert.
    const { data: existing } = await svc.from("market_api_settings")
      .select("id").eq("user_id", auth.userId).eq("active_provider", provider)
      .eq("purpose", purpose).maybeSingle();
    const { error } = existing
      ? await svc.from("market_api_settings").update(patch).eq("id", existing.id)
      : await svc.from("market_api_settings").insert(patch);
    if (error) return errorResponse(req, error.message, 400);

    // Credentials for the data feed change what serves every user's prices.
    if (purpose === "data") invalidateSystemFeedCache();
    return jsonResponse(req, { ok: true });

  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
