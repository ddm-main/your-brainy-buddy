// market-autotrade-action — on-demand, user-JWT actions that don't wait for
// the next cron tick: flatten an open AutoTrade position now, cancel a
// pending order, or dry-run a rule's entry conditions (evaluate and report
// what would fire, without placing an order — for validating a rule before
// arming it).
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";
import { kotakCancelOrder, withKotakSession } from "../_shared/market/kotakClient.ts";
import { encryptValue } from "../_shared/market/provider.ts";
import { evaluateGroups, type ScreenerGroup } from "../_shared/market/conditions.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const userId = auth.userId;
  try {
    const b = await req.json().catch(() => ({}));
    const action = String(b?.action ?? "");
    const svc = svcClient();

    if (action === "flatten") {
      const symbol = String(b?.symbol ?? "");
      const exchange = String(b?.exchange ?? "NSE");
      const ruleId = b?.rule_id ? String(b.rule_id) : null;
      if (!symbol) return errorResponse(req, "symbol required");

      const { data: orders } = await svc.from("market_autotrade_orders")
        .select("id,rule_id,symbol,exchange,leg,quantity,status,filled_price,requested_price,product")
        .eq("user_id", userId).eq("symbol", symbol).eq("exchange", exchange)
        .in("status", ["placed", "filled"]);
      const rows = (orders ?? []).filter((o) => !ruleId || o.rule_id === ruleId);
      let qty = 0;
      for (const o of rows) qty += o.leg === "entry" ? o.quantity : -o.quantity;
      if (qty <= 0) return errorResponse(req, "No open AutoTrade position for this symbol");
      const product = (rows.find((o) => o.leg === "entry")?.product ?? "MIS") as "MIS" | "CNC";

      const { provider, settings } = await getActiveProvider(svc, userId);
      if (provider.name !== "kotak_neo" || !settings || settings.connection_status !== "connected") {
        return errorResponse(req, "Kotak Neo not connected", 400);
      }
      const quotes = await provider.getQuotes([`${exchange}:${symbol}`]);
      const ltp = quotes[0]?.price;
      const result = await provider.placeOrder({
        symbol, exchange, side: "SELL", quantity: qty, orderType: "MARKET", product,
      });
      await svc.from("market_autotrade_orders").insert({
        user_id: userId, rule_id: ruleId, symbol, exchange, side: "SELL", leg: "exit",
        quantity: qty, order_type: "MARKET", product, requested_price: ltp ?? null,
        broker_order_id: result.orderId, status: "placed", reason: "manual flatten", placed_at: new Date().toISOString(),
      });
      await svc.from("market_autotrade_log").insert({ user_id: userId, rule_id: ruleId, level: "fired", message: `Manually flattened ${symbol} qty ${qty} — order ${result.orderId}` });
      return jsonResponse(req, { ok: true, orderId: result.orderId, quantity: qty });
    }

    if (action === "cancel_order") {
      const orderId = String(b?.order_id ?? "");
      const brokerOrderId = String(b?.broker_order_id ?? "");
      if (!orderId || !brokerOrderId) return errorResponse(req, "order_id and broker_order_id required");
      const { data: row } = await svc.from("market_autotrade_orders").select("id,user_id").eq("id", orderId).maybeSingle();
      if (!row || row.user_id !== userId) return errorResponse(req, "not found", 404);
      const { settings } = await getActiveProvider(svc, userId);
      if (!settings) return errorResponse(req, "Kotak Neo not connected", 400);
      await withKotakSession(svc, settings, encryptValue, (ss) => kotakCancelOrder(ss, brokerOrderId));
      await svc.from("market_autotrade_orders").update({ status: "cancelled" }).eq("id", orderId);
      await svc.from("market_autotrade_log").insert({ user_id: userId, message: `Cancelled pending order ${brokerOrderId}` });
      return jsonResponse(req, { ok: true });
    }

    if (action === "dry_run") {
      const ruleId = String(b?.rule_id ?? "");
      if (!ruleId) return errorResponse(req, "rule_id required");
      const { data: rule } = await svc.from("market_autotrade_rules").select("*").eq("id", ruleId).eq("user_id", userId).maybeSingle();
      if (!rule) return errorResponse(req, "rule not found", 404);

      let scopeSymbols: Array<{ symbol: string; exchange: string }> = [];
      if (rule.symbol) scopeSymbols = [{ symbol: rule.symbol, exchange: rule.exchange }];
      else if (rule.watchlist_id) {
        const { data: items } = await svc.from("market_watchlist_items").select("symbol,exchange").eq("watchlist_id", rule.watchlist_id);
        scopeSymbols = (items ?? []) as Array<{ symbol: string; exchange: string }>;
      }
      const symbols = [...new Set(scopeSymbols.map((s) => s.symbol))];
      const { data: scoreRows } = symbols.length ? await svc.from("market_stock_scores").select("*").in("symbol", symbols) : { data: [] };
      const scoreByKey = new Map((scoreRows ?? []).map((s: any) => [`${s.symbol}:${s.exchange}`, s]));
      const results = scopeSymbols.map((scope) => {
        const scoreRow = scoreByKey.get(`${scope.symbol}:${scope.exchange}`);
        const wouldFire = !!scoreRow && evaluateGroups(scoreRow, rule.entry_conditions as ScreenerGroup[]);
        return { symbol: scope.symbol, exchange: scope.exchange, wouldFire, hasScoreData: !!scoreRow };
      });
      return jsonResponse(req, { ok: true, results });
    }

    return errorResponse(req, `unknown action: ${action}`);
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
