// Renamed / re-listed NSE tickers.
//
// External screeners (Economic Times, Tickertape, Screener.in) keep publishing
// a company under its former ticker for months after NSE renames it, so a
// search for the old name returns nothing here and the two lists look like
// they disagree about the universe when they don't. This map resolves a legacy
// ticker (or a common alternative spelling) to the symbol we actually carry.
export const SYMBOL_ALIASES: Record<string, string> = {
  GLS: "ALIVUS",              // Glenmark Life Sciences → Alivus Life Sciences
  GLENMARKLIFE: "ALIVUS",
  UJAASENERGY: "UEL",         // Ujaas Energy
  UJAAS: "UEL",
  HINDMEDIA: "HMVL",          // Hindustan Media Ventures
  MANYAVAR: "MANYAVAR",       // Vedant Fashions trades as MANYAVAR
  VEDANTFASHIONS: "MANYAVAR",
  PAUSHAK: "PAUSHAKLTD",
  RASHI: "RPTECH",            // Rashi Peripherals trades as RPTECH
  RASHIPERIPHERALS: "RPTECH",
  VMARC: "VMARCIND",          // V-Marc India (NSE SME)
  VMARCINDIA: "VMARCIND",
};

/** Canonical NSE symbol for a user-typed ticker. Returns the input unchanged
 *  when there is no known alias. */
export function resolveSymbolAlias(input: string): string {
  const key = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return SYMBOL_ALIASES[key] ?? input.trim().toUpperCase();
}
