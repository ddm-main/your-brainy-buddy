// market-trades — today's executed trades from Kotak (read-only).
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider, encryptValue } from "../_shared/market/provider.ts";
import { BROKER_PROVIDERS } from "../_shared/market/provider.ts";
import { isUnreadableKotakCredentialsError, kotakTrades, withKotakSession } from "../_shared/market/kotakClient.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const svc = svcClient();
    const { provider, settings } = await getActiveProvider(svc, auth.userId);
    if (!BROKER_PROVIDERS.includes(provider.name) || !settings) {
      return jsonResponse(req, { trades: [], source: "unavailable" });
    }
    const raw = await withKotakSession(svc, settings, encryptValue, (ss) => kotakTrades(ss));
    const trades = (raw ?? []).map((t: any) => ({
      trade_id: String(t.flId ?? t.fillId ?? t.tradeId ?? ""),
      order_id: String(t.nOrdNo ?? t.orderId ?? ""),
      symbol: String(t.trdSym ?? t.sym ?? "").replace(/-EQ$/, ""),
      exchange: String(t.exSeg ?? "nse_cm").startsWith("bse") ? "BSE" : "NSE",
      side: String(t.trnsTp ?? "").toUpperCase() === "S" ? "SELL" : "BUY",
      quantity: Number(t.fldQty ?? t.filledQuantity ?? t.qty ?? 0),
      price: Number(t.avgPrc ?? t.averagePrice ?? t.prc ?? 0),
      trade_time: String(t.flDtTm ?? t.fillTime ?? t.tradeTime ?? ""),
      product: String(t.prod ?? t.product ?? ""),
    })).filter((t: any) => t.symbol);
    return jsonResponse(req, { trades, source: "kotak" });
  } catch (e) {
    if (isUnreadableKotakCredentialsError(e)) {
      return jsonResponse(req, {
        trades: [],
        source: "reconnect_required",
        reconnect_required: true,
        reason: "Saved Kotak credentials are no longer readable. Re-enter them in Market Config → Providers.",
      });
    }
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
