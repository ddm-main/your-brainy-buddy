// Static registry of preset indices for the add-index picker + TradingView
// symbol mapping used by the detail page's TradingView chart.
export interface IndexPreset {
  symbol: string;       // Yahoo symbol (row key)
  name: string;
  region: "IN" | "GLOBAL";
  nse_symbol?: string | null;
  fno_enabled?: boolean;
  constituents_slug?: string | null;
  tv?: string;          // TradingView symbol (exchange:ticker)
}

export const INDIAN_PRESETS: IndexPreset[] = [
  { symbol: "^NSEI",               name: "Nifty 50",         region: "IN", nse_symbol: "NIFTY",      fno_enabled: true,  constituents_slug: "nifty50",         tv: "NSE:NIFTY" },
  { symbol: "^BSESN",              name: "Sensex",           region: "IN", fno_enabled: false,                                                                    tv: "BSE:SENSEX" },
  { symbol: "^NSEBANK",            name: "Bank Nifty",       region: "IN", nse_symbol: "BANKNIFTY",  fno_enabled: true,  constituents_slug: "niftybank",       tv: "NSE:BANKNIFTY" },
  
  { symbol: "NIFTY_MID_SELECT.NS", name: "Midcap Select",    region: "IN", nse_symbol: "MIDCPNIFTY", fno_enabled: true,                                            tv: "NSE:NIFTY_MID_SELECT" },
  { symbol: "NIFTY_MIDCAP_100.NS", name: "Midcap 100",       region: "IN",                                             constituents_slug: "niftymidcap100",  tv: "NSE:CNXMIDCAP" },
  { symbol: "^CNXSC",              name: "Smallcap",         region: "IN",                                             constituents_slug: "niftysmallcap100", tv: "NSE:CNXSMALLCAP" },
  { symbol: "^CNXIT",              name: "Nifty IT",         region: "IN",                                             constituents_slug: "niftyit",         tv: "NSE:CNXIT" },
  { symbol: "^CNXAUTO",            name: "Nifty Auto",       region: "IN",                                             constituents_slug: "niftyauto",       tv: "NSE:CNXAUTO" },
  { symbol: "^CNXPHARMA",          name: "Nifty Pharma",     region: "IN",                                             constituents_slug: "niftypharma",     tv: "NSE:CNXPHARMA" },
  { symbol: "^CNXFMCG",            name: "Nifty FMCG",       region: "IN",                                             constituents_slug: "niftyfmcg",       tv: "NSE:CNXFMCG" },
  { symbol: "^CNXMETAL",           name: "Nifty Metal",      region: "IN",                                             constituents_slug: "niftymetal",      tv: "NSE:CNXMETAL" },
  { symbol: "^CNXREALTY",          name: "Nifty Realty",     region: "IN",                                             constituents_slug: "niftyrealty",     tv: "NSE:CNXREALTY" },
  { symbol: "^CNXENERGY",          name: "Nifty Energy",     region: "IN",                                             constituents_slug: "niftyenergy",     tv: "NSE:CNXENERGY" },
  { symbol: "^INDIAVIX",           name: "India VIX",        region: "IN",                                                                                     tv: "NSE:INDIAVIX" },
];

export const GLOBAL_PRESETS: IndexPreset[] = [
  { symbol: "^GSPC",   name: "S&P 500",     region: "GLOBAL", tv: "TVC:SPX" },
  { symbol: "^IXIC",   name: "Nasdaq",      region: "GLOBAL", tv: "TVC:NDX" },
  { symbol: "^DJI",    name: "Dow Jones",   region: "GLOBAL", tv: "TVC:DJI" },
  { symbol: "^FTSE",   name: "FTSE 100",    region: "GLOBAL", tv: "TVC:UKX" },
  { symbol: "^GDAXI",  name: "DAX",         region: "GLOBAL", tv: "XETR:DAX" },
  { symbol: "^FCHI",   name: "CAC 40",      region: "GLOBAL", tv: "EURONEXT:PX1" },
  { symbol: "^N225",   name: "Nikkei 225",  region: "GLOBAL", tv: "INDEX:NKY" },
  { symbol: "^HSI",    name: "Hang Seng",   region: "GLOBAL", tv: "TVC:HSI" },
  { symbol: "^AXJO",   name: "ASX 200",     region: "GLOBAL", tv: "ASX:XJO" },
  { symbol: "000001.SS", name: "Shanghai",  region: "GLOBAL", tv: "SSE:000001" },
];

export const ALL_PRESETS = [...INDIAN_PRESETS, ...GLOBAL_PRESETS];

export function findPreset(symbol: string): IndexPreset | undefined {
  return ALL_PRESETS.find((p) => p.symbol === symbol);
}

// Best-effort TradingView symbol mapping. Falls back to NSE:<sym> stripped of `^`/`.NS`.
export function tvSymbolFor(yahooSymbol: string, region?: "IN" | "GLOBAL"): string {
  const preset = findPreset(yahooSymbol);
  if (preset?.tv) return preset.tv;
  const clean = yahooSymbol.replace(/^\^/, "").replace(/\.NS$|\.BO$/i, "");
  return region === "GLOBAL" ? `TVC:${clean}` : `NSE:${clean}`;
}
