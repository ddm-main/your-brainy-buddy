// NSE-preferred exchange resolution. Single source of truth so the rule
// doesn't get re-implemented as scattered ternaries across quotes, charts,
// symbol search, screener defaults, and order routing.
//
// Rule: when a symbol lists on both NSE and BSE, prefer NSE. BSE is a
// fallback only when the symbol has no NSE listing/token. Yahoo/FMP are
// technicals-path fallbacks handled separately by resolver.ts.

export type Exchange = "NSE" | "BSE";

export interface ExchangeAvailability {
  hasNse: boolean;
  hasBse: boolean;
}

/** Resolve to the preferred exchange given what's available. */
export function preferNseExchange(avail: ExchangeAvailability): Exchange | null {
  if (avail.hasNse) return "NSE";
  if (avail.hasBse) return "BSE";
  return null;
}

/** Kotak neo segment token for an exchange. */
export function kotakSegmentFor(exchange: Exchange): "nse_cm" | "bse_cm" {
  return exchange === "BSE" ? "bse_cm" : "nse_cm";
}

/** Yahoo suffix for an exchange. */
export function yahooSuffixFor(exchange: Exchange): ".NS" | ".BO" {
  return exchange === "BSE" ? ".BO" : ".NS";
}

/**
 * Given a list of listings (rows keyed by exchange), return the NSE one when
 * present, otherwise the BSE one. `null` if neither.
 */
export function pickNsePreferredListing<T extends { exchange: string }>(rows: T[]): T | null {
  if (!rows?.length) return null;
  const nse = rows.find((r) => (r.exchange ?? "").toUpperCase() === "NSE");
  if (nse) return nse;
  const bse = rows.find((r) => (r.exchange ?? "").toUpperCase() === "BSE");
  return bse ?? rows[0] ?? null;
}
