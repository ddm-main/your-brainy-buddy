// Screener column presets — one-click column-set swaps (Screener.in style).
// The set of column IDs must match COLUMNS in Screener.tsx.
export interface ColumnPreset {
  id: string;
  label: string;
  desc: string;
  cols: string[];
}

export const COLUMN_PRESETS: ColumnPreset[] = [
  {
    id: "overview",
    label: "Overview",
    desc: "Symbol, sector, cap, price, change",
    cols: ["symbol", "sector", "market_cap", "close", "change_pct", "pe_ttm", "roe", "breakout_score"],
  },
  {
    id: "valuation",
    label: "Valuation",
    desc: "PE, PB, PEG, dividend yield, EPS",
    cols: ["symbol", "sector", "market_cap", "pe_ttm", "pb", "peg", "eps_ttm", "book_value", "dividend_yield"],
  },
  {
    id: "growth",
    label: "Growth",
    desc: "Revenue / profit / EPS growth",
    cols: ["symbol", "sector", "market_cap", "revenue_growth_yoy", "profit_growth_yoy", "eps_growth_yoy", "roe", "pe_ttm"],
  },
  {
    id: "profitability",
    label: "Profitability",
    desc: "ROE, ROCE, margins, health",
    cols: ["symbol", "sector", "market_cap", "roe", "debt_to_equity", "revenue_growth_yoy", "profit_growth_yoy"],
  },
  {
    id: "technical",
    label: "Technical",
    desc: "Price action, RSI, ADX, volume",
    cols: ["symbol", "close", "change_pct", "volume", "rel_volume", "rsi14", "adx14", "pct_from_52w_high", "breakout_score", "setup"],
  },
  {
    id: "ownership",
    label: "Ownership",
    desc: "Promoter, institutional holdings",
    cols: ["symbol", "sector", "market_cap", "promoter_holding", "dii_holding", "dividend_yield"],
  },
];
