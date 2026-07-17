// Stub Kotak endpoints — return informative "not yet implemented" so UI doesn't 404.
// Real Kotak Neo two-step OTP login will be wired in Phase 1.5.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const svc = svcClient();
    const { data, error } = await svc.from("market_api_settings")
      .select("consumer_key,mobile_number_enc,password_enc").eq("user_id", auth.userId).eq("active_provider", "kotak_neo").maybeSingle();
    if (error) return errorResponse(req, error.message);
    if (!data?.consumer_key || !data?.mobile_number_enc || !data?.password_enc) {
      return errorResponse(req, "Save Kotak credentials (consumer key, mobile, password, MPIN) before starting login.");
    }
    await svc.from("market_api_settings").update({ connection_status: "pending_otp", last_error: null })
      .eq("user_id", auth.userId).eq("active_provider", "kotak_neo");
    return jsonResponse(req, { ok: true, message: "OTP flow pending real Kotak integration — enter any 6-digit OTP for now to complete the pending_otp state." });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
