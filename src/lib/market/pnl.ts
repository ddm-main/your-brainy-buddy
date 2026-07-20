import type { Quote } from "./types";

const finite = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function quoteKey(exchange: string, symbol: string): string {
  return `${exchange.trim().toUpperCase()}:${symbol.trim().toUpperCase()}`;
}

export function getQuoteLtp(quote: Quote | undefined, fallback: number): number {
  const ltp = finite(quote?.ltp);
  return ltp != null && ltp > 0 ? ltp : fallback;
}

export function getTrustedDayChange(quote: Quote | undefined): number | null {
  if (!quote || quote.stale) return null;
  const ltp = finite(quote.ltp);
  const previousClose = finite(quote.previous_close);
  if (ltp != null && ltp > 0 && previousClose != null && previousClose > 0) {
    return ltp - previousClose;
  }
  return finite(quote.day_change);
}

export function holdingPnl(input: { quantity: number; avgPrice: number; quote?: Quote }) {
  const quantity = finite(input.quantity) ?? 0;
  const avgPrice = finite(input.avgPrice) ?? 0;
  const ltp = getQuoteLtp(input.quote, avgPrice);
  const invested = avgPrice * quantity;
  const current = ltp * quantity;
  const totalPnl = current - invested;
  const totalPnlPct = invested ? (totalPnl / invested) * 100 : 0;
  const dayChange = getTrustedDayChange(input.quote);
  const todayPnl = dayChange == null ? null : dayChange * quantity;
  // % against yesterday's closing value (current minus today's move), not
  // against invested — matches how Kite/Groww pair ₹ with % for "today".
  const prevValue = todayPnl == null ? null : current - todayPnl;
  const todayPnlPct = todayPnl == null || !prevValue ? null : (todayPnl / prevValue) * 100;
  return { ltp, invested, current, totalPnl, totalPnlPct, todayPnl, todayPnlPct };
}

// Approximate annualized return since buy date — a single-cash-flow stand-in
// for a real XIRR. The current holdings model has no lot-level buy history
// (one avg_price/quantity per symbol), so a true money-weighted return isn't
// possible without a schema change; always label this as "approx." in the UI.
export function approxAnnualizedReturnPct(totalPnlPct: number, buyDate: string | null | undefined): number | null {
  if (!buyDate) return null;
  const days = (Date.now() - new Date(buyDate).getTime()) / 86_400_000;
  if (!Number.isFinite(days) || days < 1) return null;
  const growth = 1 + totalPnlPct / 100;
  if (growth <= 0) return null; // a >100% loss has no meaningful annualized rate
  const years = days / 365.25;
  return (Math.pow(growth, 1 / years) - 1) * 100;
}

export function positionPnl(input: { quantity: number; entryPrice: number; side: "long" | "short"; quote?: Quote }) {
  const quantity = finite(input.quantity) ?? 0;
  const entryPrice = finite(input.entryPrice) ?? 0;
  const quoteLtp = finite(input.quote?.ltp);
  if (quoteLtp == null || quoteLtp <= 0) {
    return { ltp: null, unrealized: null, unrealizedPct: null, todayPnl: null };
  }
  const direction = input.side === "short" ? -1 : 1;
  const unrealized = direction * (quoteLtp - entryPrice) * quantity;
  const unrealizedPct = entryPrice ? direction * ((quoteLtp - entryPrice) / entryPrice) * 100 : null;
  const dayChange = getTrustedDayChange(input.quote);
  const todayPnl = dayChange == null ? null : direction * dayChange * quantity;
  return { ltp: quoteLtp, unrealized, unrealizedPct, todayPnl };
}

export function sumNullable(values: Array<number | null>): number | null {
  const usable = values.filter((v): v is number => v != null && Number.isFinite(v));
  return usable.length ? usable.reduce((a, b) => a + b, 0) : null;
}