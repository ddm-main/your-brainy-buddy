// market-autotrade-eval — 1-min cron during IST market hours. Per user with
// AutoTrade enabled: checks the daily-loss circuit breaker, evaluates exit
// conditions for open AutoTrade positions, then entry conditions for armed
// rules, and places real orders against the user's connected Kotak Neo
// account. Every tick/skip/fire/error is written to market_autotrade_log —
// this function spends real money unattended, so nothing here fails silent.
//
// Scope (v1): long-only. Rules BUY to enter and SELL to exit; there is no
// short-selling path. This halves the risk surface (no margin/short-product
// handling) for the first version of a feature that places live orders.
import { corsFor, preflight, jsonResponse, errorResponse, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret, istTradeDate, isTradingHoliday } from "../_shared/market/cron.ts";
import { getActiveProvider, type PlaceOrderInput } from "../_shared/market/provider.ts";
import { evaluateGroups, type ScreenerGroup } from "../_shared/market/conditions.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

function marketOpenNow(): boolean {
  const d = new Date();
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  const day = ist.getUTCDay(); if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

interface Settings {
  user_id: string;
  enabled: boolean;
  max_capital_per_rule: number;
  max_open_positions: number;
  daily_loss_limit: number;
}
interface Rule {
  id: string; user_id: string; name: string;
  symbol: string | null; exchange: string; watchlist_id: string | null;
  entry_conditions: ScreenerGroup[]; exit_conditions: ScreenerGroup[];
  stop_loss_pct: number | null; target_pct: number | null;
  product: "MIS" | "CNC"; order_type: "MARKET" | "LIMIT"; limit_offset_pct: number | null;
  sizing_mode: "fixed_qty" | "fixed_capital"; sizing_value: number;
  is_armed: boolean;
}
interface OrderRow {
  id: string; rule_id: string | null; symbol: string; exchange: string;
  side: "BUY" | "SELL"; leg: "entry" | "exit"; quantity: number;
  status: string; filled_price: number | null; requested_price: number | null;
  filled_at: string | null; created_at: string;
}
interface OpenPosition { ruleId: string; symbol: string; exchange: string; qty: number; entryPrice: number }

async function log(svc: SupabaseClient, userId: string, level: "info" | "skip" | "error" | "fired", message: string, ruleId?: string, meta?: unknown) {
  await svc.from("market_autotrade_log").insert({ user_id: userId, rule_id: ruleId ?? null, level, message, meta: meta ?? null });
}

// Net open AutoTrade positions from the order ledger — market_autotrade_orders
// is the source of truth, not a separate positions table. Entry avg price is
// a simple weighted average across all filled entry legs for that
// rule+symbol+exchange combo (v1 doesn't do lot-level FIFO accounting, same
// simplification src/lib/market/pnl.ts already accepts elsewhere).
function computeOpenPositions(orders: OrderRow[]): OpenPosition[] {
  const map = new Map<string, OpenPosition & { entryCost: number }>();
  for (const o of orders) {
    if (o.status !== "filled" && o.status !== "placed") continue;
    const key = `${o.rule_id}:${o.symbol}:${o.exchange}`;
    const cur = map.get(key) ?? { ruleId: o.rule_id ?? "", symbol: o.symbol, exchange: o.exchange, qty: 0, entryPrice: 0, entryCost: 0 };
    const px = o.filled_price ?? o.requested_price ?? 0;
    if (o.leg === "entry") { cur.qty += o.quantity; cur.entryCost += o.quantity * px; }
    else { cur.qty -= o.quantity; }
    if (cur.qty > 0) cur.entryPrice = cur.entryCost / cur.qty;
    map.set(key, cur);
  }
  return [...map.values()].filter((p) => p.qty > 0).map(({ entryCost: _entryCost, ...rest }) => rest);
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const gate = await requireCronSecret(req); if (gate) return gate;
  try {
    if (!marketOpenNow()) return jsonResponse(req, { ok: true, note: "market_closed" });
    const svc = svcClient();
    if (await isTradingHoliday(svc, istTradeDate())) return jsonResponse(req, { ok: true, note: "market_closed_holiday" });

    const { data: settingsRows } = await svc.from("market_autotrade_settings")
      .select("user_id,enabled,max_capital_per_rule,max_open_positions,daily_loss_limit")
      .eq("enabled", true);
    if (!settingsRows?.length) return jsonResponse(req, { ok: true, users: 0 });

    let totalFired = 0;
    for (const settings of settingsRows as Settings[]) {
      const userId = settings.user_id;
      try {
        const { data: rules } = await svc.from("market_autotrade_rules")
          .select("*").eq("user_id", userId).eq("is_armed", true);
        if (!rules?.length) continue;

        const { provider, settings: kotakSettings } = await getActiveProvider(svc, userId);
        if (provider.name !== "kotak_neo" || !kotakSettings || kotakSettings.connection_status !== "connected") {
          await log(svc, userId, "skip", "Kotak not connected — AutoTrade paused for this tick");
          continue;
        }

        const { data: allOrders } = await svc.from("market_autotrade_orders")
          .select("id,rule_id,symbol,exchange,side,leg,quantity,status,filled_price,requested_price,filled_at,created_at")
          .eq("user_id", userId).order("created_at", { ascending: true });
        const orders = (allOrders ?? []) as OrderRow[];
        let openPositions = computeOpenPositions(orders);

        // Daily-loss circuit breaker: realized P&L from today's filled exits
        // (weighted-avg entry price per rule+symbol+exchange) plus unrealized
        // P&L on currently-open positions at the latest live quote.
        const today = istTradeDate();
        const todaysExits = orders.filter((o) => o.leg === "exit" && o.status === "filled" && o.filled_at && istTradeDate(new Date(o.filled_at)) === today);
        const entryAvgByKey = new Map<string, number>();
        for (const p of computeOpenPositions(orders.filter((o) => o.leg === "entry"))) entryAvgByKey.set(`${p.ruleId}:${p.symbol}:${p.exchange}`, p.entryPrice);
        // Positions that are now fully closed still need an entry avg for
        // realized P&L — recompute across the whole ledger per key, not just
        // the still-open ones.
        const allEntryAvg = new Map<string, number>();
        {
          const byKey = new Map<string, { qty: number; cost: number }>();
          for (const o of orders) {
            if (o.leg !== "entry" || o.status !== "filled") continue;
            const key = `${o.rule_id}:${o.symbol}:${o.exchange}`;
            const cur = byKey.get(key) ?? { qty: 0, cost: 0 };
            const px = o.filled_price ?? o.requested_price ?? 0;
            cur.qty += o.quantity; cur.cost += o.quantity * px;
            byKey.set(key, cur);
          }
          for (const [key, v] of byKey) if (v.qty > 0) allEntryAvg.set(key, v.cost / v.qty);
        }
        let realized = 0;
        for (const ex of todaysExits) {
          const key = `${ex.rule_id}:${ex.symbol}:${ex.exchange}`;
          const entryPx = allEntryAvg.get(key);
          const exitPx = ex.filled_price ?? ex.requested_price ?? 0;
          if (entryPx != null) realized += ex.quantity * (exitPx - entryPx);
        }
        let unrealized = 0;
        if (openPositions.length > 0) {
          try {
            const keys = openPositions.map((p) => `${p.exchange}:${p.symbol}`);
            const quotes = await provider.getQuotes(keys);
            const qByKey = new Map(quotes.map((q) => [q.key, q.price]));
            for (const p of openPositions) {
              const ltp = qByKey.get(`${p.exchange}:${p.symbol}`);
              if (ltp != null) unrealized += p.qty * (ltp - p.entryPrice);
            }
          } catch { /* unrealized stays partial if quotes fail — realized still governs */ }
        }
        const todayPnl = realized + unrealized;
        if (todayPnl <= -Math.abs(settings.daily_loss_limit)) {
          await svc.from("market_autotrade_settings").update({
            enabled: false,
            disabled_reason: `Daily loss limit breached: ₹${todayPnl.toFixed(0)} (limit ₹${settings.daily_loss_limit})`,
            disabled_at: new Date().toISOString(),
          }).eq("user_id", userId);
          await log(svc, userId, "fired", `Circuit breaker tripped — AutoTrade disabled. Today's P&L ₹${todayPnl.toFixed(0)} breached limit ₹${settings.daily_loss_limit}`);
          continue;
        }

        const ruleById = new Map(rules.map((r: Rule) => [r.id, r as Rule]));

        // ---- Exits first: free up position slots before considering entries ----
        for (const pos of openPositions) {
          const rule = ruleById.get(pos.ruleId);
          if (!rule) continue;
          try {
            const quotes = await provider.getQuotes([`${pos.exchange}:${pos.symbol}`]);
            const ltp = quotes[0]?.price;
            if (ltp == null) continue;
            const { data: scoreRow } = await svc.from("market_data").select("*")
              .eq("symbol", pos.symbol).eq("exchange", pos.exchange).maybeSingle();
            const changePct = ((ltp - pos.entryPrice) / pos.entryPrice) * 100;
            let exitReason: string | null = null;
            if (rule.stop_loss_pct != null && changePct <= -Math.abs(rule.stop_loss_pct)) exitReason = `stop-loss ${rule.stop_loss_pct}%`;
            else if (rule.target_pct != null && changePct >= Math.abs(rule.target_pct)) exitReason = `target ${rule.target_pct}%`;
            else if (rule.exit_conditions?.length && scoreRow && evaluateGroups(scoreRow, rule.exit_conditions)) exitReason = "exit condition met";
            if (!exitReason) continue;

            const orderInput: PlaceOrderInput = {
              symbol: pos.symbol, exchange: pos.exchange, side: "SELL",
              quantity: pos.qty, orderType: rule.order_type, product: rule.product,
              price: rule.order_type === "LIMIT" ? ltp * (1 - (rule.limit_offset_pct ?? 0) / 100) : undefined,
            };
            const result = await provider.placeOrder(orderInput);
            await svc.from("market_autotrade_orders").insert({
              user_id: userId, rule_id: rule.id, symbol: pos.symbol, exchange: pos.exchange,
              side: "SELL", leg: "exit", quantity: pos.qty, order_type: rule.order_type, product: rule.product,
              requested_price: orderInput.price ?? ltp, broker_order_id: result.orderId, status: "placed",
              reason: exitReason, placed_at: new Date().toISOString(),
            });
            await log(svc, userId, "fired", `Exit fired for ${pos.symbol} (${exitReason}) — order ${result.orderId}`, rule.id);
            totalFired++;
            openPositions = openPositions.filter((p) => p !== pos);
          } catch (e) {
            await log(svc, userId, "error", `Exit attempt failed for ${pos.symbol}: ${e instanceof Error ? e.message : String(e)}`, rule.id);
          }
        }

        // ---- Entries ----
        for (const rule of rules as Rule[]) {
          if (!rule.entry_conditions?.length) continue;
          if (openPositions.some((p) => p.ruleId === rule.id)) continue; // duplicate-fire guard
          if (openPositions.length >= settings.max_open_positions) {
            await log(svc, userId, "skip", `Max open positions (${settings.max_open_positions}) reached — skipping entry checks for ${rule.name}`, rule.id);
            continue;
          }
          try {
            let scopeSymbols: Array<{ symbol: string; exchange: string }> = [];
            if (rule.symbol) {
              scopeSymbols = [{ symbol: rule.symbol, exchange: rule.exchange }];
            } else if (rule.watchlist_id) {
              const { data: items } = await svc.from("market_watchlist_items")
                .select("symbol,exchange").eq("watchlist_id", rule.watchlist_id);
              scopeSymbols = (items ?? []) as Array<{ symbol: string; exchange: string }>;
            }
            if (scopeSymbols.length === 0) continue;

            const symbols = [...new Set(scopeSymbols.map((s) => s.symbol))];
            const { data: scoreRows } = await svc.from("market_data").select("*").in("symbol", symbols);
            const scoreByKey = new Map((scoreRows ?? []).map((s: any) => [`${s.symbol}:${s.exchange}`, s]));

            for (const scope of scopeSymbols) {
              const scoreRow = scoreByKey.get(`${scope.symbol}:${scope.exchange}`);
              if (!scoreRow || !evaluateGroups(scoreRow, rule.entry_conditions)) continue;

              const quotes = await provider.getQuotes([`${scope.exchange}:${scope.symbol}`]);
              const ltp = quotes[0]?.price;
              if (!ltp) { await log(svc, userId, "skip", `No live price for ${scope.symbol} — skipping entry`, rule.id); continue; }

              const capCeiling = Math.min(settings.max_capital_per_rule, rule.sizing_mode === "fixed_capital" ? rule.sizing_value : Infinity);
              const qty = rule.sizing_mode === "fixed_qty"
                ? Math.min(rule.sizing_value, Math.floor(settings.max_capital_per_rule / ltp))
                : Math.floor(capCeiling / ltp);
              if (qty < 1) { await log(svc, userId, "skip", `${scope.symbol}: position size rounds to 0 at ₹${ltp} under the capital cap`, rule.id); continue; }

              const orderInput: PlaceOrderInput = {
                symbol: scope.symbol, exchange: scope.exchange, side: "BUY",
                quantity: qty, orderType: rule.order_type, product: rule.product,
                price: rule.order_type === "LIMIT" ? ltp * (1 + (rule.limit_offset_pct ?? 0) / 100) : undefined,
              };
              const result = await provider.placeOrder(orderInput);
              await svc.from("market_autotrade_orders").insert({
                user_id: userId, rule_id: rule.id, symbol: scope.symbol, exchange: scope.exchange,
                side: "BUY", leg: "entry", quantity: qty, order_type: rule.order_type, product: rule.product,
                requested_price: orderInput.price ?? ltp, broker_order_id: result.orderId, status: "placed",
                reason: "entry conditions met", placed_at: new Date().toISOString(),
              });
              await log(svc, userId, "fired", `Entry fired for ${scope.symbol} qty ${qty} — order ${result.orderId}`, rule.id);
              totalFired++;
              openPositions.push({ ruleId: rule.id, symbol: scope.symbol, exchange: scope.exchange, qty, entryPrice: ltp });
              if (openPositions.length >= settings.max_open_positions) break;
            }
          } catch (e) {
            await log(svc, userId, "error", `Entry evaluation failed for rule ${rule.name}: ${e instanceof Error ? e.message : String(e)}`, rule.id);
          }
        }
      } catch (e) {
        // one user's failure shouldn't block everyone else's evaluation
        await log(svc, userId, "error", `AutoTrade tick failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return jsonResponse(req, { ok: true, users: settingsRows.length, fired: totalFired });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
