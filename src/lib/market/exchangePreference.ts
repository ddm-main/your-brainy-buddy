// Client mirror of supabase/functions/_shared/market/exchangePreference.ts —
// keep in sync. See that file for the rule; this exists so client code
// (SymbolSearchInput, OrderTicket defaults, Screener default exchange) can
// share the same logic without duplicating ternaries.

export type Exchange = "NSE" | "BSE";

export interface ExchangeAvailability {
  hasNse: boolean;
  hasBse: boolean;
}

export function preferNseExchange(avail: ExchangeAvailability): Exchange | null {
  if (avail.hasNse) return "NSE";
  if (avail.hasBse) return "BSE";
  return null;
}

export function kotakSegmentFor(exchange: Exchange): "nse_cm" | "bse_cm" {
  return exchange === "BSE" ? "bse_cm" : "nse_cm";
}

export function yahooSuffixFor(exchange: Exchange): ".NS" | ".BO" {
  return exchange === "BSE" ? ".BO" : ".NS";
}

export function pickNsePreferredListing<T extends { exchange: string }>(rows: T[]): T | null {
  if (!rows?.length) return null;
  const nse = rows.find((r) => (r.exchange ?? "").toUpperCase() === "NSE");
  if (nse) return nse;
  const bse = rows.find((r) => (r.exchange ?? "").toUpperCase() === "BSE");
  return bse ?? rows[0] ?? null;
}
