// market-test-connection — live probe of the active provider.
// Kotak: user limits call (validates session). Yahoo: index quote.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const svc = svcClient();
    const { provider, settings } = await getActiveProvider(svc, auth.userId);
    const result = await provider.testAuth().catch((e) => ({
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    }));
    if (settings && result.ok) {
      await svc.from("market_api_settings")
        .update({ connection_status: "connected", last_error: null })
        .eq("id", settings.id);
    }
    return jsonResponse(req, { ok: result.ok, provider: provider.name, detail: result.detail ?? null });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
