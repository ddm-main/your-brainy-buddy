// AutoTrade position reconciliation — market_autotrade_orders is a ledger of
// orders WE placed, but nothing previously checked whether the broker still
// agrees a position is open. An order we recorded as "placed" could since
// have been rejected by the broker, or (very commonly for the default MIS
// product) force-squared-off near session close — either way our ledger
// would keep believing the position is open forever, which corrupts the
// duplicate-fire guard, the daily-loss circuit breaker's P&L, the
// max_open_positions count, and risks a later exit trying to SELL shares
// that were never actually held.
//
// Deliberately scoped to the unambiguous case only: if the broker's live
// position book shows ZERO quantity for a symbol we believe is open, treat
// it as closed and net our ledger to match. A broker qty that's merely
// SMALLER (not zero) than what we expect is left alone — that's ambiguous
// whenever the same symbol is also held outside AutoTrade (manual holdings,
// another rule), and this file has no way to tell "partially closed" from
// "someone else's shares in the mix" apart. v1 only claims the case it can
// prove.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { MarketProvider } from "./provider.ts";

export interface OpenPosition {
  ruleId: string;
  symbol: string;
  exchange: string;
  qty: number;
  entryPrice: number;
}

export async function reconcileOpenPositions(
  svc: SupabaseClient,
  provider: MarketProvider,
  userId: string,
  openPositions: OpenPosition[],
): Promise<OpenPosition[]> {
  if (provider.name !== "kotak_neo" || openPositions.length === 0) return openPositions;

  let brokerPositions;
  try {
    brokerPositions = await provider.getPositions();
  } catch {
    // Can't verify this tick (session hiccup, rate limit) — trust the
    // existing ledger rather than false-positive-closing real positions.
    return openPositions;
  }
  const brokerQty = new Map(brokerPositions.map((p) => [`${p.exchange}:${p.symbol}`, p.quantity]));

  const stillOpen: OpenPosition[] = [];
  for (const pos of openPositions) {
    const key = `${pos.exchange}:${pos.symbol}`;
    if ((brokerQty.get(key) ?? 0) > 0) {
      stillOpen.push(pos);
      continue;
    }

    // Broker shows flat but our ledger thinks qty is open — synthesize a
    // reconciling exit so downstream logic (circuit breaker, position
    // count, duplicate-fire guard) sees the true, current state. Best-effort
    // exit price: current LTP if quotable, else the recorded entry price
    // (zero P&L) rather than guessing.
    let exitPrice = pos.entryPrice;
    try {
      const quotes = await provider.getQuotes([key]);
      if (quotes[0]?.price) exitPrice = quotes[0].price;
    } catch { /* fall back to entryPrice */ }

    const ruleId = pos.ruleId || null;
    await svc.from("market_autotrade_orders").insert({
      user_id: userId, rule_id: ruleId, symbol: pos.symbol, exchange: pos.exchange,
      side: "SELL", leg: "exit", quantity: pos.qty, order_type: "MARKET", product: "MIS",
      status: "filled", filled_price: exitPrice, filled_at: new Date().toISOString(),
      reason: "reconciliation: broker shows no open position (rejected order, MIS square-off, or closed outside AutoTrade)",
    });
    await svc.from("market_autotrade_log").insert({
      user_id: userId, rule_id: ruleId, level: "info",
      message: `Reconciled ${pos.symbol}: broker shows no position, ledger believed qty ${pos.qty} open — marked closed at ₹${exitPrice}`,
    });
  }
  return stillOpen;
}
