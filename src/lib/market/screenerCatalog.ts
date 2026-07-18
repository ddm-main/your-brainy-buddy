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
  /** Marks filters whose data comes from the global fundamentals sync. */
  fundamental?: boolean;
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
  // Basics
  { id: "market_cap",         label: "Market Cap",        category: "basics",     kind: "number", unit: "Cr", min: 0, max: 1_500_000, step: 500 },
  { id: "sector",             label: "Sector",            category: "basics",     kind: "enum" },
  { id: "industry",           label: "Industry",          category: "basics",     kind: "enum" },
  { id: "close",              label: "Price",             category: "basics",     kind: "number", unit: "₹", min: 0, max: 100000, step: 1 },
  { id: "volume",             label: "Volume",            category: "basics",     kind: "number", min: 0, max: 50_000_000, step: 100_000 },
  { id: "pct_from_52w_high",  label: "% from 52w High",   category: "basics",     kind: "number", unit: "%", min: -100, max: 0, step: 1 },

  // Valuation
  { id: "pe_ttm",             label: "PE (TTM)",          category: "valuation",  kind: "number", unit: "x", min: 0, max: 200, step: 1, fundamental: true },
  { id: "pb",                 label: "P/B",               category: "valuation",  kind: "number", unit: "x", min: 0, max: 30, step: 0.1, fundamental: true },
  { id: "peg",                label: "PEG",               category: "valuation",  kind: "number", unit: "x", min: 0, max: 10, step: 0.1, fundamental: true },
  { id: "dividend_yield",     label: "Dividend Yield",    category: "valuation",  kind: "number", unit: "%", min: 0, max: 15, step: 0.1, fundamental: true },
  { id: "eps_ttm",            label: "EPS (TTM)",         category: "valuation",  kind: "number", unit: "₹", min: -100, max: 2000, step: 1, fundamental: true },
  { id: "book_value",         label: "Book Value",        category: "valuation",  kind: "number", unit: "₹", min: 0, max: 10000, step: 1, fundamental: true },

  // Profitability
  { id: "roe",                label: "ROE",               category: "profitability", kind: "number", unit: "%", min: -50, max: 80, step: 1, fundamental: true },
  { id: "roce",               label: "ROCE",              category: "profitability", kind: "number", unit: "%", min: -50, max: 80, step: 1, fundamental: true, hint: "Populated where available" },

  // Growth
  { id: "revenue_growth_yoy", label: "Revenue Growth YoY", category: "growth",    kind: "number", unit: "%", min: -50, max: 200, step: 1, fundamental: true },
  { id: "profit_growth_yoy",  label: "Profit Growth YoY",  category: "growth",    kind: "number", unit: "%", min: -100, max: 300, step: 1, fundamental: true },
  { id: "eps_growth_yoy",     label: "EPS Growth YoY",     category: "growth",    kind: "number", unit: "%", min: -100, max: 300, step: 1, fundamental: true },

  // Financial Health
  { id: "debt_to_equity",     label: "Debt / Equity",     category: "health",     kind: "number", unit: "x", min: 0, max: 10, step: 0.1, fundamental: true },
  { id: "current_ratio",      label: "Current Ratio",     category: "health",     kind: "number", unit: "x", min: 0, max: 10, step: 0.1, fundamental: true },
  { id: "quick_ratio",        label: "Quick Ratio",       category: "health",     kind: "number", unit: "x", min: 0, max: 10, step: 0.1, fundamental: true },

  // Ownership
  { id: "promoter_holding",   label: "Promoter Holding",  category: "ownership",  kind: "number", unit: "%", min: 0, max: 100, step: 1, fundamental: true },
  { id: "dii_holding",        label: "Institutional Hold", category: "ownership", kind: "number", unit: "%", min: 0, max: 100, step: 1, fundamental: true },

  // Technicals
  { id: "rsi14",              label: "RSI (14)",          category: "technicals", kind: "number", min: 0, max: 100, step: 1 },
  { id: "adx14",              label: "ADX (14)",          category: "technicals", kind: "number", min: 0, max: 100, step: 1 },
  { id: "macd_hist",          label: "MACD Hist",         category: "technicals", kind: "number", min: -50, max: 50, step: 0.1 },
  { id: "mfi14",              label: "MFI (14)",          category: "technicals", kind: "number", min: 0, max: 100, step: 1 },
  { id: "bb_percent_b",       label: "BB %B",             category: "technicals", kind: "number", min: -0.5, max: 1.5, step: 0.05 },
  { id: "bb_width",           label: "BB Width",          category: "technicals", kind: "number", min: 0, max: 1, step: 0.01 },
  { id: "atr_pct",            label: "ATR %",             category: "technicals", kind: "number", unit: "%", min: 0, max: 20, step: 0.1 },
  { id: "supertrend_dir",     label: "Supertrend Dir",    category: "technicals", kind: "number", min: -1, max: 1, step: 1, hint: "1 = up, -1 = down" },
  { id: "above_ema200",       label: "Above 200 EMA",     category: "technicals", kind: "boolean" },

  // Momentum & Volume
  { id: "change_pct",         label: "Change %",          category: "momentum",   kind: "number", unit: "%", min: -20, max: 20, step: 0.1 },
  { id: "rel_volume",         label: "Rel Volume",        category: "momentum",   kind: "number", unit: "x", min: 0, max: 20, step: 0.1 },
  { id: "delivery_pct",       label: "Delivery %",        category: "momentum",   kind: "number", unit: "%", min: 0, max: 100, step: 1 },
  { id: "rel_strength_nifty", label: "RS vs NIFTY",       category: "momentum",   kind: "number", unit: "%", min: -50, max: 50, step: 1 },
  { id: "sector_strength",    label: "Sector Strength",   category: "momentum",   kind: "number", min: 0, max: 1, step: 0.05 },

  // Signals
  { id: "breakout_score",     label: "Breakout Score",    category: "signals",    kind: "number", min: 0, max: 100, step: 5 },
  { id: "prebreakout_score",  label: "Pre-Breakout Score",category: "signals",    kind: "number", min: 0, max: 100, step: 5 },
  { id: "bb_squeeze",         label: "BB Squeeze",        category: "signals",    kind: "boolean" },
  { id: "higher_lows",        label: "Higher Lows",       category: "signals",    kind: "boolean" },
  { id: "near_resistance",    label: "Near Resistance",   category: "signals",    kind: "boolean" },
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

/** Returns true if the row satisfies the active filter. Null values are treated as
 *  a miss (excluded) for active filters — but the UI shows coverage stats so the
 *  user understands why fewer rows appear. */
export function filterMatches(row: Record<string, any>, af: ActiveFilter): boolean {
  const def = FILTER_BY_ID[af.id];
  if (!def) return true;
  const v = row[af.id];
  if (def.kind === "boolean") {
    if (af.bool === undefined) return true;
    return Boolean(v) === af.bool;
  }
  if (def.kind === "enum") {
    if (!af.values || af.values.length === 0) return true;
    return typeof v === "string" && af.values.includes(v);
  }
  if (v == null || Number.isNaN(v)) return false;
  if (af.min !== undefined && af.min !== "" && Number(v) < Number(af.min)) return false;
  if (af.max !== undefined && af.max !== "" && Number(v) > Number(af.max)) return false;
  return true;
}

/** How many rows have a usable value for the filter's underlying column. */
export function coverageOf(rows: Array<Record<string, any>>, filterId: string): { has: number; total: number } {
  const def = FILTER_BY_ID[filterId];
  if (!def) return { has: 0, total: rows.length };
  let has = 0;
  for (const r of rows) {
    const v = r[filterId];
    if (def.kind === "boolean") { if (v !== null && v !== undefined) has++; }
    else if (def.kind === "enum") { if (typeof v === "string" && v.length > 0) has++; }
    else { if (v != null && !Number.isNaN(v)) has++; }
  }
  return { has, total: rows.length };
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
    filters: [{ id: "roe", min: 15 }, { id: "revenue_growth_yoy", min: 10 }, { id: "debt_to_equity", max: 0.5 }],
    requires: ["roe", "revenue_growth_yoy", "debt_to_equity"] },
  { id: "magic_formula", name: "Magic Formula", group: "Fundamental", desc: "High ROE + low PE (Greenblatt)",
    filters: [{ id: "roe", min: 20 }, { id: "pe_ttm", max: 20 }], requires: ["roe", "pe_ttm"] },
  { id: "graham_number", name: "Graham Number", group: "Fundamental", desc: "Low PE and low P/B (Ben Graham)",
    filters: [{ id: "pe_ttm", max: 15 }, { id: "pb", max: 1.5 }], requires: ["pe_ttm", "pb"] },
  { id: "low_peg", name: "Low PEG", group: "Fundamental", desc: "PEG under 1 — growth at a discount",
    filters: [{ id: "peg", min: 0, max: 1 }], requires: ["peg"] },
  { id: "value_quality", name: "Value + Quality", group: "Fundamental", desc: "Low PE, high ROE, low leverage",
    filters: [{ id: "pe_ttm", max: 25 }, { id: "roe", min: 15 }, { id: "debt_to_equity", max: 0.5 }],
    requires: ["pe_ttm", "roe", "debt_to_equity"] },
  { id: "deep_value", name: "Deep Value", group: "Fundamental", desc: "Very low P/B, positive earnings",
    filters: [{ id: "pb", max: 1 }, { id: "eps_ttm", min: 0.1 }], requires: ["pb", "eps_ttm"] },
  { id: "low_pb_high_roe", name: "Low P/B, High ROE", group: "Fundamental", desc: "Undervalued quality",
    filters: [{ id: "pb", max: 3 }, { id: "roe", min: 20 }], requires: ["pb", "roe"] },

  // ===== Growth =====
  { id: "high_growth", name: "High Growth", group: "Fundamental", desc: "Strong topline & bottomline growth",
    filters: [{ id: "revenue_growth_yoy", min: 20 }, { id: "profit_growth_yoy", min: 20 }],
    requires: ["revenue_growth_yoy", "profit_growth_yoy"] },
  { id: "garp", name: "GARP", group: "Fundamental", desc: "Growth at a reasonable price",
    filters: [{ id: "profit_growth_yoy", min: 15 }, { id: "pe_ttm", max: 30 }, { id: "roe", min: 12 }],
    requires: ["profit_growth_yoy", "pe_ttm", "roe"] },
  { id: "smallcap_growth", name: "Small Cap Growth", group: "Fundamental", desc: "Fast-growing small caps",
    filters: [{ id: "market_cap", min: 500, max: 5000 }, { id: "profit_growth_yoy", min: 25 }],
    requires: ["market_cap", "profit_growth_yoy"] },
  { id: "sales_profit_doubler", name: "Sales & Profit Doublers", group: "Fundamental", desc: "≥ 50% growth on both lines",
    filters: [{ id: "revenue_growth_yoy", min: 50 }, { id: "profit_growth_yoy", min: 50 }],
    requires: ["revenue_growth_yoy", "profit_growth_yoy"] },
  { id: "eps_accelerator", name: "EPS Accelerator", group: "Fundamental", desc: "EPS growth ≥ 30%",
    filters: [{ id: "eps_growth_yoy", min: 30 }], requires: ["eps_growth_yoy"] },

  // ===== Quality =====
  { id: "high_roce_low_debt", name: "High ROCE, Low Debt", group: "Fundamental", desc: "Efficient capital, clean balance sheet",
    filters: [{ id: "roce", min: 20 }, { id: "debt_to_equity", max: 0.3 }], requires: ["roce", "debt_to_equity"] },
  { id: "zero_debt", name: "Zero-Debt Compounders", group: "Fundamental", desc: "Debt-free with strong returns",
    filters: [{ id: "debt_to_equity", max: 0.05 }, { id: "roe", min: 15 }], requires: ["debt_to_equity", "roe"] },
  { id: "consistent_roe", name: "Consistent ROE > 20%", group: "Fundamental", desc: "Elite return on equity",
    filters: [{ id: "roe", min: 20 }], requires: ["roe"] },
  { id: "healthy_liquidity", name: "Healthy Liquidity", group: "Fundamental", desc: "Current ratio ≥ 2, quick ≥ 1",
    filters: [{ id: "current_ratio", min: 2 }, { id: "quick_ratio", min: 1 }],
    requires: ["current_ratio", "quick_ratio"] },
  { id: "cash_rich_small", name: "Cash-Rich Small Caps", group: "Fundamental", desc: "Small cap, low debt, profitable",
    filters: [{ id: "market_cap", min: 500, max: 5000 }, { id: "debt_to_equity", max: 0.3 }, { id: "roe", min: 12 }],
    requires: ["market_cap", "debt_to_equity", "roe"] },

  // ===== Income =====
  { id: "dividend", name: "Dividend Payers", group: "Fundamental", desc: "Yield ≥ 3%",
    filters: [{ id: "dividend_yield", min: 3 }], requires: ["dividend_yield"] },
  { id: "high_dividend", name: "High Dividend Yield", group: "Fundamental", desc: "Yield ≥ 5% with earnings",
    filters: [{ id: "dividend_yield", min: 5 }, { id: "eps_ttm", min: 0 }],
    requires: ["dividend_yield", "eps_ttm"] },
  { id: "dividend_aristocrats", name: "Dividend Aristocrats", group: "Fundamental", desc: "Large cap dividend payers",
    filters: [{ id: "market_cap", min: 20000 }, { id: "dividend_yield", min: 2 }, { id: "roe", min: 15 }],
    requires: ["dividend_yield", "roe"] },

  // ===== Turnaround / Special =====
  { id: "loss_to_profit", name: "Loss → Profit", group: "Fundamental", desc: "Positive earnings + strong growth",
    filters: [{ id: "profit_growth_yoy", min: 50 }, { id: "eps_ttm", min: 0 }],
    requires: ["profit_growth_yoy", "eps_ttm"] },
  { id: "turnaround", name: "Turnaround Candidates", group: "Fundamental", desc: "Profit rebound with low base",
    filters: [{ id: "profit_growth_yoy", min: 100 }], requires: ["profit_growth_yoy"] },
  { id: "debt_reduction", name: "Debt Reduction Story", group: "Fundamental", desc: "Very low leverage + growing profits",
    filters: [{ id: "debt_to_equity", max: 0.1 }, { id: "profit_growth_yoy", min: 15 }],
    requires: ["debt_to_equity", "profit_growth_yoy"] },

  // ===== Ownership =====
  { id: "high_promoter", name: "High Promoter Holding", group: "Fundamental", desc: "Skin in the game (≥ 60%)",
    filters: [{ id: "promoter_holding", min: 60 }], requires: ["promoter_holding"] },
  { id: "institutional_favourites", name: "Institutional Favourites", group: "Fundamental", desc: "Strong DII/FII stake",
    filters: [{ id: "dii_holding", min: 20 }], requires: ["dii_holding"] },

  // ===== Momentum / Technical =====
  { id: "breakout", name: "Breakout Candidates", group: "Technical", desc: "High breakout score + volume + uptrend",
    filters: [{ id: "breakout_score", min: 65 }, { id: "rel_volume", min: 1.5 }, { id: "above_ema200", bool: true }] },
  { id: "coiled", name: "Coiled Springs", group: "Technical", desc: "BB squeeze + high pre-breakout score",
    filters: [{ id: "prebreakout_score", min: 60 }, { id: "bb_squeeze", bool: true }] },
  { id: "momentum", name: "Momentum Leaders", group: "Technical", desc: "Strong RSI, positive RS vs Nifty",
    filters: [{ id: "rsi14", min: 55, max: 72 }, { id: "rel_strength_nifty", min: 0 }, { id: "above_ema200", bool: true }] },
  { id: "oversold_bounce", name: "Oversold Bounce", group: "Technical", desc: "Deep RSI dip in uptrend",
    filters: [{ id: "rsi14", max: 32 }, { id: "above_ema200", bool: true }] },
  { id: "vol_surge", name: "Volume Surge", group: "Technical", desc: "3× average volume with positive change",
    filters: [{ id: "rel_volume", min: 3 }, { id: "change_pct", min: 0 }] },
  { id: "near_52wh", name: "Near 52w High", group: "Technical", desc: "Within 3% of 52-week high, strong sector",
    filters: [{ id: "pct_from_52w_high", min: -3 }, { id: "sector_strength", min: 0.5 }] },
  { id: "above_200dma", name: "Above 200 DMA", group: "Technical", desc: "In a long-term uptrend",
    filters: [{ id: "above_ema200", bool: true }] },
  { id: "rsi_overbought_trend", name: "Strong Trend (RSI)", group: "Technical", desc: "RSI > 70 in confirmed uptrend",
    filters: [{ id: "rsi14", min: 70 }, { id: "adx14", min: 25 }, { id: "above_ema200", bool: true }] },
  { id: "adx_trend", name: "Trending Stocks (ADX)", group: "Technical", desc: "ADX ≥ 25 signals a strong trend",
    filters: [{ id: "adx14", min: 25 }] },
  { id: "supertrend_up", name: "Supertrend Up", group: "Technical", desc: "Supertrend flipped positive",
    filters: [{ id: "supertrend_dir", min: 1, max: 1 }] },
  { id: "delivery_spike", name: "Delivery Spike", group: "Technical", desc: "High delivery % — real accumulation",
    filters: [{ id: "delivery_pct", min: 60 }, { id: "change_pct", min: 0 }] },
  { id: "higher_lows_setup", name: "Higher Lows Setup", group: "Technical", desc: "Constructive price structure",
    filters: [{ id: "higher_lows", bool: true }, { id: "above_ema200", bool: true }] },
  { id: "near_resistance_setup", name: "Testing Resistance", group: "Technical", desc: "Approaching supply zone",
    filters: [{ id: "near_resistance", bool: true }, { id: "rel_volume", min: 1.2 }] },
  { id: "macd_positive", name: "MACD Positive", group: "Technical", desc: "MACD histogram > 0",
    filters: [{ id: "macd_hist", min: 0 }] },

  // ===== Size buckets =====
  { id: "large_cap_compounder", name: "Large Cap Compounders", group: "Hybrid", desc: "Large + growing + profitable",
    filters: [{ id: "market_cap", min: 20000 }, { id: "roe", min: 15 }, { id: "profit_growth_yoy", min: 10 }],
    requires: ["market_cap", "roe", "profit_growth_yoy"] },
  { id: "midcap_growth", name: "Mid Cap Growth", group: "Hybrid", desc: "Mid caps with strong earnings growth",
    filters: [{ id: "market_cap", min: 5000, max: 20000 }, { id: "profit_growth_yoy", min: 20 }],
    requires: ["market_cap", "profit_growth_yoy"] },
  { id: "smallcap_multibagger", name: "Small Cap Multibaggers", group: "Hybrid", desc: "Small caps with growth + momentum",
    filters: [{ id: "market_cap", min: 500, max: 5000 }, { id: "profit_growth_yoy", min: 30 }, { id: "above_ema200", bool: true }],
    requires: ["profit_growth_yoy"] },

  // ===== Hybrid =====
  { id: "quality_momentum", name: "Quality Momentum", group: "Hybrid", desc: "Strong ROE + positive relative strength",
    filters: [{ id: "roe", min: 15 }, { id: "rel_strength_nifty", min: 5 }, { id: "above_ema200", bool: true }],
    requires: ["roe"] },
  { id: "consistent_compounder", name: "Consistent Compounders", group: "Hybrid", desc: "Profitable + growing + reasonably valued",
    filters: [{ id: "roe", min: 15 }, { id: "profit_growth_yoy", min: 15 }, { id: "pe_ttm", max: 40 }, { id: "debt_to_equity", max: 1 }],
    requires: ["roe", "profit_growth_yoy", "pe_ttm", "debt_to_equity"] },
  { id: "piotroski_like", name: "Piotroski-like Quality", group: "Hybrid", desc: "Positive earnings, low debt, healthy liquidity",
    filters: [{ id: "eps_ttm", min: 0 }, { id: "debt_to_equity", max: 0.5 }, { id: "current_ratio", min: 1.5 }, { id: "roe", min: 12 }],
    requires: ["eps_ttm", "debt_to_equity", "current_ratio", "roe"] },
];
