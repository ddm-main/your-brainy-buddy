// market-config-save — save/activate provider config; encrypts secrets.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { encryptStatementPassword } from "../_shared/crypto.ts";

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
    if (b?.consumer_secret) patch.consumer_secret_enc = await enc(b.consumer_secret);
    if (b?.mobile_number) patch.mobile_number_enc = await enc(b.mobile_number);
    if (b?.password) patch.password_enc = await enc(b.password);
    if (b?.mpin) patch.mpin_enc = await enc(b.mpin);
    if (b?.base_url !== undefined) patch.base_url = b.base_url;
    if (b?.ws_url !== undefined) patch.ws_url = b.ws_url;

    const { error } = await svc.from("market_api_settings").upsert(patch, { onConflict: "user_id,active_provider" });
    if (error) return errorResponse(req, error.message, 400);
    return jsonResponse(req, { ok: true });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
