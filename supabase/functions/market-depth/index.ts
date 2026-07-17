// market-depth — 5-level bid/ask ladder from the active provider (Kotak-only).
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const b = await req.json().catch(() => ({}));
    const symbol = String(b?.symbol ?? "").toUpperCase();
    const exchange = String(b?.exchange ?? "NSE").toUpperCase();
    if (!symbol) return errorResponse(req, "symbol required");
    const svc = svcClient();
    const { provider } = await getActiveProvider(svc, auth.userId);
    const ladder = await provider.getDepth(symbol, exchange);
    return jsonResponse(req, ladder);
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
