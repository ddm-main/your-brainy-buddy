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
    cols: ["symbol", "sector", "market_cap", "close", "change_pct", "pe", "roe", "breakout_score"],
  },
  {
    id: "valuation",
    label: "Valuation",
    desc: "PE, PB, PEG, dividend yield, EPS",
    cols: ["symbol", "sector", "market_cap", "pe", "pb", "peg", "eps", "book_value", "dividend_yield"],
  },
  {
    id: "growth",
    label: "Growth",
    desc: "Revenue / profit / EPS growth",
    cols: ["symbol", "sector", "market_cap", "sales_growth", "profit_growth", "eps_growth", "roe", "pe"],
  },
  {
    id: "profitability",
    label: "Profitability",
    desc: "ROE, ROCE, margins, health",
    cols: ["symbol", "sector", "market_cap", "roe", "debt_equity", "sales_growth", "profit_growth"],
  },
  {
    id: "technical",
    label: "Technical",
    desc: "Price action, RSI, ADX, volume",
    cols: ["symbol", "close", "change_pct", "volume", "rel_volume", "rsi", "adx", "pct_from_52w_high", "breakout_score", "setup"],
  },
  {
    id: "ownership",
    label: "Ownership",
    desc: "Promoter, institutional holdings",
    cols: ["symbol", "sector", "market_cap", "promoter_holding", "dii_holding", "dividend_yield"],
  },
];
