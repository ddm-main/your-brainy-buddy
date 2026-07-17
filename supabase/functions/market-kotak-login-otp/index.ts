import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const b = await req.json().catch(() => ({}));
    if (!b?.otp || String(b.otp).length < 4) return errorResponse(req, "Enter a valid OTP");
    const svc = svcClient();
    await svc.from("market_api_settings").update({
      connection_status: "connected",
      token_expires_at: new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(),
      last_sync_at: new Date().toISOString(),
      greeting_name: "Kotak user",
      last_error: null,
    }).eq("user_id", auth.userId).eq("active_provider", "kotak_neo");
    return jsonResponse(req, { ok: true, greeting_name: "Kotak user", note: "Kotak session marked as connected. Real API token exchange ships in Phase 1.5." });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
