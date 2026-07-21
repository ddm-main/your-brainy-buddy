// Screener filter catalogue, tiers, and presets — inspired by Tickertape & Screener.in.
// All filters operate against a merged row shape combining market_stock_scores,
// market_stocks (mcap, index membership), and market_fundamentals_global (PE, ROE, growth, …).

export type FilterKind = "number" | "boolean" | "enum";
export type FilterCategory =
  | "basics"
  | "valuation"
  | "profitability"
  | "growth"
  | "health"
  | "ownership"
  | "technicals"
  | "momentum"
  | "signals";

/** Applicability scope — determines which rows are counted for coverage and,
 *  by extension, whether a null value is legitimate ("N/A") or missing.
 *   - all       : every active row (structural columns)
 *   - eq        : equity instruments only (ETFs excluded)
 *   - eq_profit : equities with positive EPS (loss-makers have no meaningful PE/PEG)
 *   - eq_profit_pe : eq_profit, AND the PE value itself must be present — a row with
 *                    valid EPS but a missing PE (a real data-source gap) is N/A, not
 *                    "out of range."
 *   - eq_owner  : equities where any ownership number was reported
 *   - tech      : rows with a trade_date (i.e. an EOD score row exists)
 */
export type ApplicabilityScope = "all" | "eq" | "eq_profit" | "eq_profit_pe" | "eq_owner" | "tech";

export function rowIsApplicable(row: Record<string, any>, scope: ApplicabilityScope): boolean {
  const type = row.instrument_type ?? "EQ";
  switch (scope) {
    case "all":       return true;
    case "eq":        return type === "EQ";
    case "eq_profit": return type === "EQ" && row.eps != null && Number(row.eps) > 0;
    case "eq_profit_pe": return type === "EQ" && row.eps != null && Number(row.eps) > 0 && row.pe != null;
    case "eq_owner":  return type === "EQ" && (row.promoter_holding != null || row.fii_holding != null || row.dii_holding != null);
    case "tech":      return row.trade_date != null;
  }
}

export interface FilterDef {
  id: string;
  label: string;
  category: FilterCategory;
  kind: FilterKind;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  /** enum values (for kind: 'enum') */
  options?: string[];
  /** Legacy flag — replaced by scope; kept for saved-screener back-compat. */
  fundamental?: boolean;
  /** Applicability scope: rows failing this are neither counted in coverage nor filtered out. */
  scope?: ApplicabilityScope;
  /** For numeric filters where NULL semantically means zero (e.g. non-dividend payer). */
  nullMeansZero?: boolean;
}

export const CATEGORIES: Array<{ id: FilterCategory; label: string; desc: string }> = [
  { id: "basics",        label: "Basics",             desc: "Market cap, sector, price, volume" },
  { id: "valuation",     label: "Valuation",          desc: "PE, PB, PEG, dividend, EV/EBITDA" },
  { id: "profitability", label: "Profitability",      desc: "ROE, ROCE, margins" },
  { id: "growth",        label: "Growth",             desc: "Revenue, profit, EPS growth" },
  { id: "health",        label: "Financial Health",   desc: "Leverage & liquidity" },
  { id: "ownership",     label: "Ownership",          desc: "Promoter, FII, DII holdings" },
  { id: "technicals",    label: "Technicals",         desc: "EMAs, RSI, ADX, MACD" },
  { id: "momentum",      label: "Momentum & Volume",  desc: "Change, RVol, delivery, RS" },
  { id: "signals",       label: "Signals & Setups",   desc: "Breakouts, squeezes, patterns" },
];

// Market-cap tier definitions (₹ Cr) — Tickertape/Sebi-style.
export interface CapTier { id: string; label: string; min: number; max?: number }
export const CAP_TIERS: CapTier[] = [
  { id: "mega",  label: "Mega Cap (>₹1L Cr)",  min: 100000 },
  { id: "large", label: "Large Cap (₹20K–1L Cr)", min: 20000, max: 100000 },
  { id: "mid",   label: "Mid Cap (₹5K–20K Cr)",   min: 5000,  max: 20000 },
  { id: "small", label: "Small Cap (₹500–5K Cr)", min: 500,   max: 5000 },
  { id: "micro", label: "Micro Cap (<₹500 Cr)",   min: 0,     max: 500 },
];

export const FILTERS: FilterDef[] = [
  // Basics — structural columns, apply to every active row.
  { id: "market_cap",         label: "Market Cap",        category: "basics",     kind: "number", unit: "Cr", min: 0, max: 2_500_000, step: 500, scope: "all" },
  { id: "sector",             label: "Sector",            category: "basics",     kind: "enum", scope: "eq" },
  { id: "industry",           label: "Industry",          category: "basics",     kind: "enum", scope: "eq" },
  { id: "ltp",                label: "Price",             category: "basics",     kind: "number", unit: "₹", min: 0, max: 200000, step: 1, scope: "all" },
  { id: "volume",             label: "Volume",            category: "basics",     kind: "number", min: 0, max: 200_000_000, step: 100_000, scope: "tech" },
  { id: "pct_from_52w_high",  label: "% from 52w High",   category: "basics",     kind: "number", unit: "%", min: -100, max: 20, step: 1, scope: "tech" },

  // Valuation — most require positive earnings to be meaningful.
  { id: "pe",                 label: "PE (TTM)",          category: "valuation",  kind: "number", unit: "x", min: 0, max: 300, step: 1, fundamental: true, scope: "eq_profit_pe" },
  { id: "pb",                 label: "P/B",               category: "valuation",  kind: "number", unit: "x", min: 0, max: 50, step: 0.1, fundamental: true, scope: "eq" },
  { id: "peg",                label: "PEG",               category: "valuation",  kind: "number", unit: "x", min: 0, max: 10, step: 0.1, fundamental: true, scope: "eq_profit" },
  { id: "dividend_yield",     label: "Dividend Yield",    category: "valuation",  kind: "number", unit: "%", min: 0, max: 15, step: 0.1, fundamental: true, scope: "eq", nullMeansZero: true },
  { id: "eps",                label: "EPS (TTM)",         category: "valuation",  kind: "number", unit: "₹", min: -500, max: 5000, step: 1, fundamental: true, scope: "eq" },
  { id: "book_value",         label: "Book Value",        category: "valuation",  kind: "number", unit: "₹", min: 0, max: 20000, step: 1, fundamental: true, scope: "eq" },

  // Profitability
  { id: "roe",                label: "ROE",               category: "profitability", kind: "number", unit: "%", min: -50, max: 100, step: 1, fundamental: true, scope: "eq" },

  // Growth
  { id: "sales_growth",       label: "Revenue Growth YoY", category: "growth",    kind: "number", unit: "%", min: -50, max: 200, step: 1, fundamental: true, scope: "eq" },
  { id: "profit_growth",      label: "Profit Growth YoY",  category: "growth",    kind: "number", unit: "%", min: -100, max: 300, step: 1, fundamental: true, scope: "eq" },
  { id: "eps_growth",         label: "EPS Growth YoY",     category: "growth",    kind: "number", unit: "%", min: -100, max: 300, step: 1, fundamental: true, scope: "eq" },

  // Financial Health
  { id: "debt_equity",        label: "Debt / Equity",     category: "health",     kind: "number", unit: "x", min: 0, max: 10, step: 0.1, fundamental: true, scope: "eq", nullMeansZero: true },
  { id: "current_ratio",      label: "Current Ratio",     category: "health",     kind: "number", unit: "x", min: 0, max: 10, step: 0.1, fundamental: true, scope: "eq" },
  { id: "quick_ratio",        label: "Quick Ratio",       category: "health",     kind: "number", unit: "x", min: 0, max: 10, step: 0.1, fundamental: true, scope: "eq" },

  // Ownership — only meaningful where any ownership number is reported.
  { id: "promoter_holding",   label: "Promoter Holding",  category: "ownership",  kind: "number", unit: "%", min: 0, max: 100, step: 1, fundamental: true, scope: "eq_owner" },
  { id: "dii_holding",        label: "Institutional Hold", category: "ownership", kind: "number", unit: "%", min: 0, max: 100, step: 1, fundamental: true, scope: "eq_owner" },

  // Technicals — depend on an EOD score row.
  { id: "rsi",                label: "RSI (14)",          category: "technicals", kind: "number", min: 0, max: 100, step: 1, scope: "tech" },
  { id: "adx",                label: "ADX (14)",          category: "technicals", kind: "number", min: 0, max: 100, step: 1, scope: "tech" },
  { id: "macd_hist",          label: "MACD Hist",         category: "technicals", kind: "number", min: -50, max: 50, step: 0.1, scope: "tech" },
  { id: "bb_width",           label: "BB Width",          category: "technicals", kind: "number", min: 0, max: 1, step: 0.01, scope: "tech" },
  { id: "atr_pct",            label: "ATR %",             category: "technicals", kind: "number", unit: "%", min: 0, max: 20, step: 0.1, scope: "tech" },
  { id: "above_ema_200",      label: "Above 200 EMA",     category: "technicals", kind: "boolean", scope: "tech" },

  // Momentum & Volume
  { id: "change_pct",         label: "1D Return %",       category: "momentum",   kind: "number", unit: "%", min: -20, max: 20, step: 0.1, scope: "tech" },
  { id: "rel_volume",         label: "Rel Volume",        category: "momentum",   kind: "number", unit: "x", min: 0, max: 20, step: 0.1, scope: "tech" },
  { id: "rel_strength_nifty", label: "RS vs NIFTY",       category: "momentum",   kind: "number", unit: "%", min: -50, max: 50, step: 1, scope: "tech" },
  { id: "sector_strength",    label: "Sector Strength",   category: "momentum",   kind: "number", min: 0, max: 1, step: 0.05, scope: "tech" },

  // Signals
  { id: "breakout_score",     label: "Breakout Score",    category: "signals",    kind: "number", min: 0, max: 100, step: 5, scope: "tech" },
  { id: "prebreakout_score",  label: "Pre-Breakout Score",category: "signals",    kind: "number", min: 0, max: 100, step: 5, scope: "tech" },
  { id: "bb_squeeze",         label: "BB Squeeze",        category: "signals",    kind: "boolean", scope: "tech" },
  { id: "higher_lows",        label: "Higher Lows",       category: "signals",    kind: "boolean", scope: "tech" },
  { id: "near_resistance",    label: "Near Resistance",   category: "signals",    kind: "boolean", scope: "tech" },
];

export const FILTER_BY_ID: Record<string, FilterDef> = Object.fromEntries(FILTERS.map((f) => [f.id, f]));

// ----- Active filter state -----
export interface ActiveFilter {
  id: string;
  min?: number | "";
  max?: number | "";
  bool?: boolean;
  values?: string[]; // for enum filters
}

/** Returns true if the row satisfies the active filter.
 *  Rules:
 *   - Rows outside the filter's applicability scope are always kept (they are "N/A").
 *   - Numeric filter with no min/max set → matches everything.
 *   - Numeric filter with a bound + `nullMeansZero` → NULL is treated as 0.
 *   - Numeric filter with a bound and no `nullMeansZero` → NULL is excluded. */
export function filterMatches(row: Record<string, any>, af: ActiveFilter): boolean {
  const def = FILTER_BY_ID[af.id];
  if (!def) return true;
  // Applicability: rows outside the scope are excluded from filtering — they pass through
  // untouched so that, e.g., an ETF is not dropped by a PE filter.
  const scope: ApplicabilityScope = def.scope ?? (def.fundamental ? "eq" : "all");
  if (!rowIsApplicable(row, scope)) return true;
  const v = row[af.id];
  if (def.kind === "boolean") {
    if (af.bool === undefined) return true;
    return Boolean(v) === af.bool;
  }
  if (def.kind === "enum") {
    if (!af.values || af.values.length === 0) return true;
    return typeof v === "string" && af.values.includes(v);
  }
  const minNum = af.min === undefined || af.min === "" || Number.isNaN(Number(af.min)) ? null : Number(af.min);
  const maxNum = af.max === undefined || af.max === "" || Number.isNaN(Number(af.max)) ? null : Number(af.max);
  if (minNum === null && maxNum === null) return true;
  let n: number;
  if (v == null || Number.isNaN(v)) {
    if (def.nullMeansZero) n = 0;
    else return false;
  } else {
    n = Number(v);
  }
  if (minNum !== null && n < minNum) return false;
  if (maxNum !== null && n > maxNum) return false;
  return true;
}

/** Coverage over the applicable set: rows outside the filter's scope are excluded
 *  from both numerator and denominator, so "% coverage" is meaningful. */
export function coverageOf(rows: Array<Record<string, any>>, filterId: string): { has: number; total: number } {
  const def = FILTER_BY_ID[filterId];
  if (!def) return { has: 0, total: rows.length };
  const scope: ApplicabilityScope = def.scope ?? (def.fundamental ? "eq" : "all");
  const scoped = rows.filter((r) => rowIsApplicable(r, scope));
  let has = 0;
  for (const r of scoped) {
    const v = r[filterId];
    if (def.kind === "boolean") { if (v !== null && v !== undefined) has++; }
    else if (def.kind === "enum") { if (typeof v === "string" && v.length > 0) has++; }
    else {
      if (v != null && !Number.isNaN(v)) has++;
      else if (def.nullMeansZero) has++; // NULL is a meaningful zero
    }
  }
  return { has, total: scoped.length };
}

/** How many rows are being silently dropped by the currently-active filters purely
 *  because their value hasn't synced yet — as opposed to genuinely being out of range.
 *  Only counts filters with a bound actually set, non-nullMeansZero, numeric. A row
 *  missing data for more than one active filter is only counted once. */
export function excludedByMissingData(rows: Array<Record<string, any>>, active: ActiveFilter[]): number {
  const missing = new Set<string>();
  for (const af of active) {
    const def = FILTER_BY_ID[af.id];
    if (!def || def.kind !== "number" || def.nullMeansZero) continue;
    const hasBound = (af.min !== undefined && af.min !== "") || (af.max !== undefined && af.max !== "");
    if (!hasBound) continue;
    const scope: ApplicabilityScope = def.scope ?? (def.fundamental ? "eq" : "all");
    for (const r of rows) {
      if (!rowIsApplicable(r, scope)) continue;
      const v = r[af.id];
      if (v == null || Number.isNaN(v)) missing.add(`${r.symbol}:${r.exchange}`);
    }
  }
  return missing.size;
}


// ----- Universes -----
export type UniverseId = "all" | "nifty500" | "nifty50" | "banknifty" | "finnifty";
export const UNIVERSES: Array<{ id: UniverseId; label: string }> = [
  { id: "all",       label: "All Stocks" },
  { id: "nifty500",  label: "Nifty 500" },
  { id: "nifty50",   label: "Nifty 50" },
  { id: "banknifty", label: "Bank Nifty" },
  { id: "finnifty",  label: "Fin Nifty" },
];

// ----- Curated presets — Tickertape / Screener.in inspired -----
export interface Preset {
  id: string;
  name: string;
  desc: string;
  group: "Fundamental" | "Technical" | "Hybrid";
  universe?: UniverseId;
  filters: ActiveFilter[];
  /** Filter ids this preset needs data for; UI dims preset if coverage is poor. */
  requires?: string[];
}

export const PRESETS: Preset[] = [
  // ===== Value =====
  { id: "coffee_can", name: "Coffee Can", group: "Fundamental", desc: "High ROE, steady growth, low leverage",
    filters: [{ id: "roe", min: 15 }, { id: "sales_growth", min: 10 }, { id: "debt_equity", max: 0.5 }],
    requires: ["roe", "sales_growth", "debt_equity"] },
  { id: "magic_formula", name: "Magic Formula", group: "Fundamental", desc: "High ROE + low PE (Greenblatt)",
    filters: [{ id: "roe", min: 20 }, { id: "pe", max: 20 }], requires: ["roe", "pe"] },
  { id: "graham_number", name: "Graham Number", group: "Fundamental", desc: "Low PE and low P/B (Ben Graham)",
    filters: [{ id: "pe", max: 15 }, { id: "pb", max: 1.5 }], requires: ["pe", "pb"] },
  { id: "low_peg", name: "Low PEG", group: "Fundamental", desc: "PEG under 1 — growth at a discount",
    filters: [{ id: "peg", min: 0, max: 1 }], requires: ["peg"] },
  { id: "value_quality", name: "Value + Quality", group: "Fundamental", desc: "Low PE, high ROE, low leverage",
    filters: [{ id: "pe", max: 25 }, { id: "roe", min: 15 }, { id: "debt_equity", max: 0.5 }],
    requires: ["pe", "roe", "debt_equity"] },
  { id: "deep_value", name: "Deep Value", group: "Fundamental", desc: "Very low P/B, positive earnings",
    filters: [{ id: "pb", max: 1 }, { id: "eps", min: 0.1 }], requires: ["pb", "eps"] },
  { id: "low_pb_high_roe", name: "Low P/B, High ROE", group: "Fundamental", desc: "Undervalued quality",
    filters: [{ id: "pb", max: 3 }, { id: "roe", min: 20 }], requires: ["pb", "roe"] },

  // ===== Growth =====
  { id: "high_growth", name: "High Growth", group: "Fundamental", desc: "Strong topline & bottomline growth",
    filters: [{ id: "sales_growth", min: 20 }, { id: "profit_growth", min: 20 }],
    requires: ["sales_growth", "profit_growth"] },
  { id: "garp", name: "GARP", group: "Fundamental", desc: "Growth at a reasonable price",
    filters: [{ id: "profit_growth", min: 15 }, { id: "pe", max: 30 }, { id: "roe", min: 12 }],
    requires: ["profit_growth", "pe", "roe"] },
  { id: "smallcap_growth", name: "Small Cap Growth", group: "Fundamental", desc: "Fast-growing small caps",
    filters: [{ id: "market_cap", min: 500, max: 5000 }, { id: "profit_growth", min: 25 }],
    requires: ["market_cap", "profit_growth"] },
  { id: "sales_profit_doubler", name: "Sales & Profit Doublers", group: "Fundamental", desc: "≥ 50% growth on both lines",
    filters: [{ id: "sales_growth", min: 50 }, { id: "profit_growth", min: 50 }],
    requires: ["sales_growth", "profit_growth"] },
  { id: "eps_accelerator", name: "EPS Accelerator", group: "Fundamental", desc: "EPS growth ≥ 30%",
    filters: [{ id: "eps_growth", min: 30 }], requires: ["eps_growth"] },

  // ===== Quality =====
  { id: "zero_debt", name: "Zero-Debt Compounders", group: "Fundamental", desc: "Debt-free with strong returns",
    filters: [{ id: "debt_equity", max: 0.05 }, { id: "roe", min: 15 }], requires: ["debt_equity", "roe"] },
  { id: "consistent_roe", name: "Consistent ROE > 20%", group: "Fundamental", desc: "Elite return on equity",
    filters: [{ id: "roe", min: 20 }], requires: ["roe"] },
  { id: "healthy_liquidity", name: "Healthy Liquidity", group: "Fundamental", desc: "Current ratio ≥ 2, quick ≥ 1",
    filters: [{ id: "current_ratio", min: 2 }, { id: "quick_ratio", min: 1 }],
    requires: ["current_ratio", "quick_ratio"] },
  { id: "cash_rich_small", name: "Cash-Rich Small Caps", group: "Fundamental", desc: "Small cap, low debt, profitable",
    filters: [{ id: "market_cap", min: 500, max: 5000 }, { id: "debt_equity", max: 0.3 }, { id: "roe", min: 12 }],
    requires: ["market_cap", "debt_equity", "roe"] },

  // ===== Income =====
  { id: "dividend", name: "Dividend Payers", group: "Fundamental", desc: "Yield ≥ 3%",
    filters: [{ id: "dividend_yield", min: 3 }], requires: ["dividend_yield"] },
  { id: "high_dividend", name: "High Dividend Yield", group: "Fundamental", desc: "Yield ≥ 5% with earnings",
    filters: [{ id: "dividend_yield", min: 5 }, { id: "eps", min: 0 }],
    requires: ["dividend_yield", "eps"] },
  { id: "dividend_aristocrats", name: "Dividend Aristocrats", group: "Fundamental", desc: "Large cap dividend payers",
    filters: [{ id: "market_cap", min: 20000 }, { id: "dividend_yield", min: 2 }, { id: "roe", min: 15 }],
    requires: ["dividend_yield", "roe"] },

  // ===== Turnaround / Special =====
  { id: "loss_to_profit", name: "Loss → Profit", group: "Fundamental", desc: "Positive earnings + strong growth",
    filters: [{ id: "profit_growth", min: 50 }, { id: "eps", min: 0 }],
    requires: ["profit_growth", "eps"] },
  { id: "turnaround", name: "Turnaround Candidates", group: "Fundamental", desc: "Profit rebound with low base",
    filters: [{ id: "profit_growth", min: 100 }], requires: ["profit_growth"] },
  { id: "debt_reduction", name: "Debt Reduction Story", group: "Fundamental", desc: "Very low leverage + growing profits",
    filters: [{ id: "debt_equity", max: 0.1 }, { id: "profit_growth", min: 15 }],
    requires: ["debt_equity", "profit_growth"] },

  // ===== Ownership =====
  { id: "high_promoter", name: "High Promoter Holding", group: "Fundamental", desc: "Skin in the game (≥ 60%)",
    filters: [{ id: "promoter_holding", min: 60 }], requires: ["promoter_holding"] },
  { id: "institutional_favourites", name: "Institutional Favourites", group: "Fundamental", desc: "Strong DII/FII stake",
    filters: [{ id: "dii_holding", min: 20 }], requires: ["dii_holding"] },

  // ===== Momentum / Technical =====
  { id: "breakout", name: "Breakout Candidates", group: "Technical", desc: "High breakout score + volume + uptrend",
    filters: [{ id: "breakout_score", min: 65 }, { id: "rel_volume", min: 1.5 }, { id: "above_ema_200", bool: true }] },
  { id: "coiled", name: "Coiled Springs", group: "Technical", desc: "BB squeeze + high pre-breakout score",
    filters: [{ id: "prebreakout_score", min: 60 }, { id: "bb_squeeze", bool: true }] },
  { id: "momentum", name: "Momentum Leaders", group: "Technical", desc: "Strong RSI, positive RS vs Nifty",
    filters: [{ id: "rsi", min: 55, max: 72 }, { id: "rel_strength_nifty", min: 0 }, { id: "above_ema_200", bool: true }] },
  { id: "oversold_bounce", name: "Oversold Bounce", group: "Technical", desc: "Deep RSI dip in uptrend",
    filters: [{ id: "rsi", max: 32 }, { id: "above_ema_200", bool: true }] },
  { id: "vol_surge", name: "Volume Surge", group: "Technical", desc: "3× average volume with positive change",
    filters: [{ id: "rel_volume", min: 3 }, { id: "change_pct", min: 0 }] },
  { id: "near_52wh", name: "Near 52w High", group: "Technical", desc: "Within 3% of 52-week high, strong sector",
    filters: [{ id: "pct_from_52w_high", min: -3 }, { id: "sector_strength", min: 0.5 }] },
  { id: "above_200dma", name: "Above 200 DMA", group: "Technical", desc: "In a long-term uptrend",
    filters: [{ id: "above_ema_200", bool: true }] },
  { id: "rsi_overbought_trend", name: "Strong Trend (RSI)", group: "Technical", desc: "RSI > 70 in confirmed uptrend",
    filters: [{ id: "rsi", min: 70 }, { id: "adx", min: 25 }, { id: "above_ema_200", bool: true }] },
  { id: "adx_trend", name: "Trending Stocks (ADX)", group: "Technical", desc: "ADX ≥ 25 signals a strong trend",
    filters: [{ id: "adx", min: 25 }] },
  { id: "higher_lows_setup", name: "Higher Lows Setup", group: "Technical", desc: "Constructive price structure",
    filters: [{ id: "higher_lows", bool: true }, { id: "above_ema_200", bool: true }] },
  { id: "near_resistance_setup", name: "Testing Resistance", group: "Technical", desc: "Approaching supply zone",
    filters: [{ id: "near_resistance", bool: true }, { id: "rel_volume", min: 1.2 }] },
  { id: "macd_positive", name: "MACD Positive", group: "Technical", desc: "MACD histogram > 0",
    filters: [{ id: "macd_hist", min: 0 }] },

  // ===== Size buckets =====
  { id: "large_cap_compounder", name: "Large Cap Compounders", group: "Hybrid", desc: "Large + growing + profitable",
    filters: [{ id: "market_cap", min: 20000 }, { id: "roe", min: 15 }, { id: "profit_growth", min: 10 }],
    requires: ["market_cap", "roe", "profit_growth"] },
  { id: "midcap_growth", name: "Mid Cap Growth", group: "Hybrid", desc: "Mid caps with strong earnings growth",
    filters: [{ id: "market_cap", min: 5000, max: 20000 }, { id: "profit_growth", min: 20 }],
    requires: ["market_cap", "profit_growth"] },
  { id: "smallcap_multibagger", name: "Small Cap Multibaggers", group: "Hybrid", desc: "Small caps with growth + momentum",
    filters: [{ id: "market_cap", min: 500, max: 5000 }, { id: "profit_growth", min: 30 }, { id: "above_ema_200", bool: true }],
    requires: ["profit_growth"] },

  // ===== Hybrid =====
  { id: "quality_momentum", name: "Quality Momentum", group: "Hybrid", desc: "Strong ROE + positive relative strength",
    filters: [{ id: "roe", min: 15 }, { id: "rel_strength_nifty", min: 5 }, { id: "above_ema_200", bool: true }],
    requires: ["roe"] },
  { id: "consistent_compounder", name: "Consistent Compounders", group: "Hybrid", desc: "Profitable + growing + reasonably valued",
    filters: [{ id: "roe", min: 15 }, { id: "profit_growth", min: 15 }, { id: "pe", max: 40 }, { id: "debt_equity", max: 1 }],
    requires: ["roe", "profit_growth", "pe", "debt_equity"] },
  { id: "piotroski_like", name: "Piotroski-like Quality", group: "Hybrid", desc: "Positive earnings, low debt, healthy liquidity",
    filters: [{ id: "eps", min: 0 }, { id: "debt_equity", max: 0.5 }, { id: "current_ratio", min: 1.5 }, { id: "roe", min: 12 }],
    requires: ["eps", "debt_equity", "current_ratio", "roe"] },
];
