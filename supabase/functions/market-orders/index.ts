// market-orders — today's order book from Kotak (read-only).
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";
import { BROKER_PROVIDERS } from "../_shared/market/provider.ts";
import { KOTAK_SETTINGS_COLS, type KotakSettings, isUnreadableKotakCredentialsError, kotakOrders, withKotakSession } from "../_shared/market/kotakClient.ts";
import { encryptValue } from "../_shared/market/provider.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const svc = svcClient();
    const { provider, settings } = await getActiveProvider(svc, auth.userId);
    if (!BROKER_PROVIDERS.includes(provider.name) || !settings) {
      return jsonResponse(req, { orders: [], source: "unavailable" });
    }
    const raw = await withKotakSession(svc, settings, encryptValue, (ss) => kotakOrders(ss));
    const orders = (raw ?? []).map((o: any) => ({
      order_id: String(o.nOrdNo ?? o.orderId ?? o.norenordno ?? ""),
      symbol: String(o.trdSym ?? o.sym ?? "").replace(/-EQ$/, ""),
      exchange: String(o.exSeg ?? "nse_cm").startsWith("bse") ? "BSE" : "NSE",
      side: String(o.trnsTp ?? o.transactionType ?? "").toUpperCase() === "S" ? "SELL" : "BUY",
      quantity: Number(o.qty ?? o.quantity ?? 0),
      filled_qty: Number(o.fldQty ?? o.filledQuantity ?? 0),
      price: Number(o.prc ?? o.price ?? 0),
      status: String(o.ordSt ?? o.orderStatus ?? o.status ?? ""),
      order_time: String(o.ordDtTm ?? o.orderTime ?? ""),
      product: String(o.prod ?? o.product ?? ""),
    })).filter((o: any) => o.symbol);
    return jsonResponse(req, { orders, source: "kotak" });
  } catch (e) {
    if (isUnreadableKotakCredentialsError(e)) {
      // This is an expected recovery state, not an Edge Function crash. A 200
      // lets the Orders screen render its reconnect action without the runtime
      // error overlay while the shared client has already retired stale data.
      return jsonResponse(req, {
        orders: [],
        source: "reconnect_required",
        reconnect_required: true,
        reason: "Saved Kotak credentials are no longer readable. Re-enter them in Market Config → Providers.",
      });
    }
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
