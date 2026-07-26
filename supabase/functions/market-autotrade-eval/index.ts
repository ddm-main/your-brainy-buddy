// market-autotrade-eval — 1-min cron during IST market hours. Per user who
// has ever configured AutoTrade: reconciles the order ledger against the
// broker's real position book, evaluates exit conditions for open AutoTrade
// positions (always — even if the account is disabled, see below), then
// entry conditions for armed rules (gated on `enabled`), and places real
// orders against the user's connected Kotak Neo account. Every tick/skip/
// fire/error is written to market_autotrade_log — this function spends real
// money unattended, so nothing here fails silent.
//
// Scope (v1): long-only. Rules BUY to enter and SELL to exit; there is no
// short-selling path. This halves the risk surface (no margin/short-product
// handling) for the first version of a feature that places live orders.
import { preflight, jsonResponse, errorResponse, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret, istTradeDate, isTradingHoliday } from "../_shared/market/cron.ts";
import { getActiveProvider, type PlaceOrderInput } from "../_shared/market/provider.ts";
import { evaluateGroups, type ScreenerGroup } from "../_shared/market/conditions.ts";
import { reconcileOpenPositions, type OpenPosition } from "../_shared/market/autotradeReconcile.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

function marketOpenNow(): boolean {
  const d = new Date();
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  const day = ist.getUTCDay(); if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  // Skip the first 90 s after open — opening-auction crossover has bad LTPs
  // and huge spreads that produce false entries and slippage. Industry
  // practice (Streak/Tradetron) is to hold algo entries out of 9:15 sharp.
  return mins >= 9 * 60 + 16 && mins <= 15 * 60 + 30;
}


// A tick slow enough to still be running when the next cron fire starts
// (broker latency, many rules/users) must not let two ticks act on the same
// stale "no open position yet" snapshot and double-fire an entry. This lease
// is a plain conditional UPDATE (atomic in Postgres regardless of the
// stateless REST connection each call uses) — not a session-level advisory
// lock, which wouldn't survive across separate supabase-js calls anyway.
// Stale-lease recovery after LEASE_MS so a crashed invocation can't wedge a
// user out of evaluation forever.
const LEASE_MS = 3 * 60_000;

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
  trail_stop_pct: number | null;
  product: "MIS" | "CNC"; order_type: "MARKET" | "LIMIT"; limit_offset_pct: number | null;
  sizing_mode: "fixed_qty" | "fixed_capital"; sizing_value: number;
  is_armed: boolean;
  exit_order_type: "MARKET" | "LIMIT" | "SL" | "SL-M";
}
interface OrderRow {
  id: string; rule_id: string | null; symbol: string; exchange: string;
  side: "BUY" | "SELL"; leg: "entry" | "exit"; quantity: number;
  status: string; filled_price: number | null; requested_price: number | null;
  filled_at: string | null; created_at: string;
}

async function log(svc: SupabaseClient, userId: string, level: "info" | "skip" | "error" | "fired", message: string, ruleId?: string, meta?: unknown) {
  await svc.from("market_autotrade_log").insert({ user_id: userId, rule_id: ruleId ?? null, level, message, meta: meta ?? null });
}

// Throttled: a symbol whose data is stale keeps being stale tick after
// tick, and without throttling this would write a log row every minute for
// as long as it stays stale — spam that would drown out real signal. One
// distinguishing note per rule+symbol per hour is enough to debug "why does
// this rule never fire" without flooding the log.
async function logStaleOnce(svc: SupabaseClient, userId: string, ruleId: string, symbol: string, tradeDate: unknown, today: string) {
  const marker = `stale:${ruleId}:${symbol}`;
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
  const { data: recent } = await svc.from("market_autotrade_log")
    .select("id").eq("user_id", userId).eq("rule_id", ruleId)
    .ilike("message", `%${marker}%`).gte("created_at", oneHourAgo).limit(1);
  if (recent?.length) return;
  await log(svc, userId, "skip", `[${marker}] ${symbol}: skipped — market data is stale (last synced ${tradeDate ?? "never"}, expected ${today})`, ruleId);
}

// market_autotrade_orders stays the internal source of truth for AutoTrade's
// own P&L/circuit-breaker logic (computeOpenPositions above) — this is a
// best-effort mirror into market_positions so a bot-opened position is also
// visible on the Positions page, Holdings/Dashboard portfolio totals, etc.,
// which previously excluded AutoTrade exposure entirely (it only showed up
// in AutoTrade's own panel, or after a manual "sync from Kotak" click).
// market_positions has no rule_id column — journal_notes carries an
// `AutoTrade:<rule.id>` tag so exit can find the right open row even if two
// different rules happen to hold the same symbol at once. v1 is long-only
// (see file header), so side is always "long" here.
const AUTOTRADE_TAG = (ruleId: string) => `AutoTrade:${ruleId}`;

async function mirrorAutotradeEntry(
  svc: SupabaseClient, userId: string, ruleId: string,
  symbol: string, exchange: string, quantity: number, entryPrice: number,
) {
  await svc.from("market_positions").insert({
    user_id: userId, symbol, exchange, side: "long",
    quantity, entry_price: entryPrice,
    journal_notes: AUTOTRADE_TAG(ruleId), is_broker_synced: true,
  });
}

async function mirrorAutotradeExit(
  svc: SupabaseClient, userId: string, ruleId: string,
  symbol: string, exchange: string, exitPrice: number,
) {
  const { data: openRow } = await svc.from("market_positions")
    .select("id,quantity,entry_price")
    .eq("user_id", userId).eq("symbol", symbol).eq("exchange", exchange)
    .eq("journal_notes", AUTOTRADE_TAG(ruleId)).is("closed_at", null)
    .order("opened_at", { ascending: true }).limit(1).maybeSingle();
  if (!openRow) return; // no mirrored row (e.g. entry mirror failed) — don't fail the real exit over it
  const pnl = (exitPrice - Number(openRow.entry_price)) * Number(openRow.quantity);
  await svc.from("market_positions").update({
    closed_at: new Date().toISOString(), exit_price: exitPrice, pnl,
  }).eq("id", openRow.id);
}

// Net open AutoTrade positions from the order ledger — market_autotrade_orders
// is the source of truth, not a separate positions table. Entry avg price is
// a simple weighted average across all filled entry legs for that
// rule+symbol+exchange combo (v1 doesn't do lot-level FIFO accounting, same
// simplification src/lib/market/pnl.ts already accepts elsewhere).
function computeOpenPositions(orders: OrderRow[]): OpenPosition[] {
  const map = new Map<string, OpenPosition & { entryCost: number }>();
  for (const o of orders) {
    // "pending" = a claim row written before the broker call resolves (see
    // the entry-fire block below). Counting it as open here is what stops a
    // second tick from re-firing the same entry if the post-placeOrder
    // ledger update itself fails — the row exists either way.
    if (o.status !== "filled" && o.status !== "placed" && o.status !== "pending") continue;
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

    // Every user who's ever configured AutoTrade — not just enabled=true.
    // A disabled account (manually, or via circuit breaker) can still hold
    // real open positions that need exit/stop-loss protection and broker
    // reconciliation; only NEW entries are gated on `enabled`. Previously
    // this query filtered to enabled=true, so once the circuit breaker (or
    // the user) disabled AutoTrade, any still-open position was excluded
    // from every future tick forever — zero automated protection until the
    // account was manually re-enabled.
    const { data: settingsRows } = await svc.from("market_autotrade_settings")
      .select("user_id,enabled,max_capital_per_rule,max_open_positions,daily_loss_limit");
    if (!settingsRows?.length) return jsonResponse(req, { ok: true, users: 0 });

    let totalFired = 0;
    let usersProcessed = 0;
    for (const settings of settingsRows as Settings[]) {
      const userId = settings.user_id;

      const now = new Date();
      const staleBefore = new Date(now.getTime() - LEASE_MS).toISOString();
      const { data: leased } = await svc.from("market_autotrade_settings")
        .update({ eval_lock_at: now.toISOString() })
        .eq("user_id", userId)
        .or(`eval_lock_at.is.null,eval_lock_at.lt.${staleBefore}`)
        .select("user_id");
      if (!leased?.length) continue; // another tick already holds this user's lease

      try {
        usersProcessed++;
        // BOTH armed and disarmed rules — disarmed rules must still supply
        // stop-loss/target/exit logic for positions they opened while armed
        // (previously an open position from a since-disarmed rule got zero
        // exit protection until manual flatten). Entry loop below re-filters
        // to is_armed so disarming still blocks NEW entries.
        const { data: rules } = await svc.from("market_autotrade_rules")
          .select("*").eq("user_id", userId).order("created_at", { ascending: true });

        const { provider, settings: kotakSettings } = await getActiveProvider(svc, userId);
        if (provider.name !== "kotak_neo" || !kotakSettings || kotakSettings.connection_status !== "connected") {
          if (rules?.length) await log(svc, userId, "skip", "Kotak not connected — AutoTrade paused for this tick");
          continue;
        }


        const { data: allOrders } = await svc.from("market_autotrade_orders")
          .select("id,rule_id,symbol,exchange,side,leg,quantity,status,filled_price,requested_price,filled_at,created_at")
          .eq("user_id", userId).order("created_at", { ascending: true });
        const orders = (allOrders ?? []) as OrderRow[];
        let openPositions = computeOpenPositions(orders);

        // Reconcile against the broker's real position book BEFORE anything
        // else uses openPositions — closes the gap where an order we think
        // is "placed" was actually rejected, or Kotak force-squared-off an
        // MIS position near close, both of which previously left a phantom
        // open position in our ledger forever.
        if (openPositions.length > 0) {
          openPositions = await reconcileOpenPositions(svc, provider, userId, openPositions);
        }

        if (!rules?.length && openPositions.length === 0) continue; // nothing to do for this user this tick

        // Daily-loss circuit breaker: realized P&L from today's filled exits
        // (weighted-avg entry price per rule+symbol+exchange) plus unrealized
        // P&L on currently-open (now reconciled) positions at the latest live quote.
        const today = istTradeDate();
        const todaysExits = orders.filter((o) => o.leg === "exit" && o.status === "filled" && o.filled_at && istTradeDate(new Date(o.filled_at)) === today);
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

        // Circuit breaker blocks NEW entries only. It does not skip exits —
        // a real open position still needs its stop-loss/target/exit-condition
        // protection precisely when something has gone wrong enough to trip
        // the breaker; leaving it completely unmanaged until the user
        // notices and manually re-enables AutoTrade was the opposite of
        // what a circuit breaker is for.
        let entriesBlocked = !settings.enabled;
        if (settings.enabled && todayPnl <= -Math.abs(settings.daily_loss_limit)) {
          await svc.from("market_autotrade_settings").update({
            enabled: false,
            disabled_reason: `Daily loss limit breached: ₹${todayPnl.toFixed(0)} (limit ₹${settings.daily_loss_limit})`,
            disabled_at: new Date().toISOString(),
          }).eq("user_id", userId);
          await log(svc, userId, "fired", `Circuit breaker tripped — new entries blocked. Open positions still get stop-loss/target/exit protection this and future ticks. Today's P&L ₹${todayPnl.toFixed(0)} breached limit ₹${settings.daily_loss_limit}`);
          entriesBlocked = true;
        }

        const ruleById = new Map((rules ?? []).map((r: Rule) => [r.id, r as Rule]));

        // ---- Exits first: free up position slots before considering entries.
        // Runs regardless of entriesBlocked — see comment above. ----
        for (const pos of openPositions) {
          const rule = ruleById.get(pos.ruleId);
          if (!rule) continue; // rule deleted/unarmed since the position opened — nothing to evaluate against; flatten manually from the UI
          try {
            const quotes = await provider.getQuotes([`${pos.exchange}:${pos.symbol}`]);
            const ltp = quotes[0]?.price;
            if (ltp == null) continue;
            const { data: scoreRow } = await svc.from("market_stock_scores").select("*")
              .eq("symbol", pos.symbol).eq("exchange", pos.exchange).maybeSingle();
            const changePct = ((ltp - pos.entryPrice) / pos.entryPrice) * 100;

            // Trailing-stop ratchet: track high-water mark of LTP since entry
            // on the latest entry order row for this rule+symbol; exit when
            // LTP drops trail_stop_pct% from that high. Only meaningful once
            // the position is in profit (high >= entryPrice), so the trail
            // doesn't stack with (and dominate) the fixed stop_loss_pct.
            let trailExit: string | null = null;
            if (rule.trail_stop_pct && rule.trail_stop_pct > 0) {
              const { data: entryRow } = await svc.from("market_autotrade_orders")
                .select("id,high_water_ltp")
                .eq("user_id", userId).eq("rule_id", rule.id)
                .eq("symbol", pos.symbol).eq("exchange", pos.exchange)
                .eq("leg", "entry").in("status", ["placed", "filled"])
                .order("created_at", { ascending: false }).limit(1).maybeSingle();
              if (entryRow) {
                const prevHigh = Number(entryRow.high_water_ltp ?? pos.entryPrice);
                const newHigh = Math.max(prevHigh, ltp);
                if (newHigh > prevHigh) {
                  await svc.from("market_autotrade_orders").update({ high_water_ltp: newHigh }).eq("id", entryRow.id);
                }
                if (newHigh > pos.entryPrice) {
                  const dropPct = ((newHigh - ltp) / newHigh) * 100;
                  if (dropPct >= Math.abs(rule.trail_stop_pct)) {
                    trailExit = `trail-stop ${rule.trail_stop_pct}% (high ₹${newHigh.toFixed(2)} → ₹${ltp.toFixed(2)})`;
                  }
                }
              }
            }

            let exitReason: string | null = null;
            if (rule.stop_loss_pct != null && changePct <= -Math.abs(rule.stop_loss_pct)) exitReason = `stop-loss ${rule.stop_loss_pct}%`;
            else if (rule.target_pct != null && changePct >= Math.abs(rule.target_pct)) exitReason = `target ${rule.target_pct}%`;
            else if (trailExit) exitReason = trailExit;
            else if (rule.exit_conditions?.length && scoreRow && evaluateGroups(scoreRow, rule.exit_conditions, today)) exitReason = "exit condition met";
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
            // Cancel any linked broker-side protective SL — otherwise it
            // would still be resting on the book after this exit fills and
            // could later fire a SELL against a position we no longer hold.
            const { data: entryRow } = await svc.from("market_autotrade_orders")
              .select("id,broker_sl_order_id")
              .eq("user_id", userId).eq("rule_id", rule.id).eq("leg", "entry")
              .not("broker_sl_order_id", "is", null)
              .order("created_at", { ascending: false }).limit(1).maybeSingle();
            if (entryRow?.broker_sl_order_id) {
              try {
                await provider.cancelOrder(entryRow.broker_sl_order_id);
                await svc.from("market_autotrade_orders")
                  .update({ broker_sl_order_id: null })
                  .eq("id", entryRow.id);
              } catch (e) {
                await log(svc, userId, "error", `Failed to cancel linked broker SL ${entryRow.broker_sl_order_id} after ${pos.symbol} exit: ${e instanceof Error ? e.message : String(e)}`, rule.id);
              }
            }
            try {
              await mirrorAutotradeExit(svc, userId, rule.id, pos.symbol, pos.exchange, orderInput.price ?? ltp);
            } catch { /* best-effort mirror — the real exit already fired, don't let this look like a failure */ }
            await log(svc, userId, "fired", `Exit fired for ${pos.symbol} (${exitReason}) — order ${result.orderId}`, rule.id);
            totalFired++;
            openPositions = openPositions.filter((p) => p !== pos);
          } catch (e) {
            await log(svc, userId, "error", `Exit attempt failed for ${pos.symbol}: ${e instanceof Error ? e.message : String(e)}`, rule.id);
          }
        }

        if (entriesBlocked) continue;

        // Funds guardrail — fetch once per user, decrement locally as entries fire.
        // A missing/zero snapshot is not fatal: the broker will reject any oversized
        // order at place time. This just prevents obviously insufficient entries.
        let remainingMargin: number | null = null;
        try {
          const fundsSnap = await provider.getFunds();
          remainingMargin = fundsSnap.available_margin;
        } catch { /* fall through — broker rejection is the backstop */ }

        // ---- Entries ---- (armed rules only — disarmed rules still ran
        // exits above so open positions stay protected).
        for (const rule of (rules as Rule[]).filter((r) => r.is_armed)) {
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
              // Watchlist rows can legally omit exchange — fall back to the
              // rule's declared exchange (or NSE) so the quote key isn't
              // `undefined:SYMBOL` and silently miss every push.
              scopeSymbols = (items ?? []).map((it: any) => ({
                symbol: it.symbol,
                exchange: it.exchange || rule.exchange || "NSE",
              }));

            }

            if (scopeSymbols.length === 0) continue;

            const symbols = [...new Set(scopeSymbols.map((s) => s.symbol))];
            const { data: scoreRows } = await svc.from("market_stock_scores").select("*").in("symbol", symbols);
            const scoreByKey = new Map((scoreRows ?? []).map((s: any) => [`${s.symbol}:${s.exchange}`, s]));

            for (const scope of scopeSymbols) {
              // Per-symbol dedup across ALL rules, not just this one — v1
              // caps exposure to a single instrument at at most one
              // AutoTrade-opened position at a time, regardless of how many
              // armed rules target it, so max_capital_per_rule can't be
              // silently multiplied by stacking overlapping rules on the
              // same symbol.
              if (openPositions.some((p) => p.symbol === scope.symbol && p.exchange === scope.exchange)) continue;

              const scoreRow = scoreByKey.get(`${scope.symbol}:${scope.exchange}`);
              if (!scoreRow) continue;
              if (scoreRow.trade_date !== today) {
                await logStaleOnce(svc, userId, rule.id, scope.symbol, scoreRow.trade_date, today);
                continue;
              }
              if (!evaluateGroups(scoreRow, rule.entry_conditions, today)) continue;

              const quotes = await provider.getQuotes([`${scope.exchange}:${scope.symbol}`]);
              const ltp = quotes[0]?.price;
              if (!ltp) { await log(svc, userId, "skip", `No live price for ${scope.symbol} — skipping entry`, rule.id); continue; }

              const capCeiling = Math.min(settings.max_capital_per_rule, rule.sizing_mode === "fixed_capital" ? rule.sizing_value : Infinity);
              const qty = rule.sizing_mode === "fixed_qty"
                ? Math.min(rule.sizing_value, Math.floor(settings.max_capital_per_rule / ltp))
                : Math.floor(capCeiling / ltp);
              if (qty < 1) { await log(svc, userId, "skip", `${scope.symbol}: position size rounds to 0 at ₹${ltp} under the capital cap`, rule.id); continue; }

              const notional = qty * ltp;
              if (remainingMargin != null && remainingMargin > 0 && notional > remainingMargin) {
                await log(svc, userId, "skip", `${scope.symbol}: notional ₹${notional.toFixed(0)} exceeds remaining margin ₹${remainingMargin.toFixed(0)}`, rule.id);
                continue;
              }

              const orderInput: PlaceOrderInput = {
                symbol: scope.symbol, exchange: scope.exchange, side: "BUY",
                quantity: qty, orderType: rule.order_type, product: rule.product,
                price: rule.order_type === "LIMIT" ? ltp * (1 + (rule.limit_offset_pct ?? 0) / 100) : undefined,
              };

              // Claim the entry BEFORE calling the broker. computeOpenPositions
              // treats "pending" as open, so if the broker call succeeds but
              // this process dies (or a later update below fails) before the
              // row is marked "placed", the position still reads as open on
              // the next tick and the duplicate-fire guard still holds —
              // instead of the ledger showing nothing and the rule re-firing
              // another live BUY every tick until conditions clear.
              const { data: claimRow, error: claimErr } = await svc.from("market_autotrade_orders")
                .insert({
                  user_id: userId, rule_id: rule.id, symbol: scope.symbol, exchange: scope.exchange,
                  side: "BUY", leg: "entry", quantity: qty, order_type: rule.order_type, product: rule.product,
                  requested_price: orderInput.price ?? ltp, status: "pending",
                  reason: "entry conditions met", placed_at: new Date().toISOString(),
                })
                .select("id").single();
              if (claimErr || !claimRow) {
                await log(svc, userId, "error", `Could not claim entry for ${scope.symbol} — skipping this tick to avoid an unrecorded order`, rule.id);
                continue;
              }

              let result: { orderId: string; status: string };
              try {
                result = await provider.placeOrder(orderInput);
              } catch (e) {
                await svc.from("market_autotrade_orders")
                  .update({ status: "rejected", reason: `broker call failed: ${e instanceof Error ? e.message : String(e)}` })
                  .eq("id", claimRow.id);
                throw e;
              }

              // Optional broker-side protective SL — placed immediately
              // after the entry so a stop still fires even if the eval cron
              // misses a tick. Only when the rule opted in via
              // exit_order_type and a stop_loss_pct is set.
              let brokerSlOrderId: string | null = null;
              if ((rule.exit_order_type === "SL" || rule.exit_order_type === "SL-M") && rule.stop_loss_pct) {
                try {
                  const stopPrice = +(ltp * (1 - Math.abs(rule.stop_loss_pct) / 100)).toFixed(2);
                  const slInput: PlaceOrderInput = {
                    symbol: scope.symbol, exchange: scope.exchange, side: "SELL",
                    quantity: qty, orderType: rule.exit_order_type, product: rule.product,
                    triggerPrice: stopPrice,
                    // SL (limit variant) also needs a limit price — a hair below the trigger to make it marketable.
                    ...(rule.exit_order_type === "SL" ? { price: +(stopPrice * 0.995).toFixed(2) } : {}),
                  };
                  const slResult = await provider.placeOrder(slInput);
                  brokerSlOrderId = slResult.orderId;
                  await log(svc, userId, "info", `Placed broker SL for ${scope.symbol} @ ₹${stopPrice} — order ${slResult.orderId}`, rule.id);
                } catch (e) {
                  await log(svc, userId, "error", `Failed to place broker SL for ${scope.symbol}: ${e instanceof Error ? e.message : String(e)} — soft in-app trigger still active`, rule.id);
                }
              }

              await svc.from("market_autotrade_orders")
                .update({ broker_order_id: result.orderId, status: "placed", broker_sl_order_id: brokerSlOrderId })
                .eq("id", claimRow.id);
              try {
                await mirrorAutotradeEntry(svc, userId, rule.id, scope.symbol, scope.exchange, qty, orderInput.price ?? ltp);
              } catch { /* best-effort mirror — the real entry already fired, don't let this look like a failure */ }
              await log(svc, userId, "fired", `Entry fired for ${scope.symbol} qty ${qty} — order ${result.orderId}`, rule.id);
              totalFired++;
              openPositions.push({ ruleId: rule.id, symbol: scope.symbol, exchange: scope.exchange, qty, entryPrice: ltp });
              if (remainingMargin != null) remainingMargin = Math.max(0, remainingMargin - qty * ltp);
              if (openPositions.length >= settings.max_open_positions) break;
            }
          } catch (e) {
            await log(svc, userId, "error", `Entry evaluation failed for rule ${rule.name}: ${e instanceof Error ? e.message : String(e)}`, rule.id);
          }
        }
      } catch (e) {
        // one user's failure shouldn't block everyone else's evaluation
        await log(svc, userId, "error", `AutoTrade tick failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        await svc.from("market_autotrade_settings").update({ eval_lock_at: null }).eq("user_id", userId);
      }
    }
    return jsonResponse(req, { ok: true, users: usersProcessed, fired: totalFired });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
