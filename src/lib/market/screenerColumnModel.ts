import {
  FILTER_BY_ID,
  canonicalFilterId,
  type ActiveFilter,
} from "./screenerCatalog";

// Filter-id → column-id map. Kept as the single source of truth for what
// column a given filter surfaces in results grids.
export const FILTER_TO_COL: Record<string, string> = {
  market_cap: "market_cap",
  ltp: "close",
  volume: "volume",
  vol_gt_avg30: "vol_gt_avg30",
  change_pct: "change_pct",
  pct_from_52w_high: "pct_from_52w_high",
  rel_volume: "rel_volume",
  pe: "pe", pb: "pb", peg: "peg", eps: "eps", book_value: "book_value",
  dividend_yield: "dividend_yield",
  roe: "roe", roce: "roce",
  debt_equity: "debt_equity",
  sales_growth: "sales_growth", profit_growth: "profit_growth", eps_growth: "eps_growth",
  promoter_holding: "promoter_holding", dii_holding: "dii_holding",
  fii_holding: "fii_holding", institutional_holding: "institutional_holding",
  rsi: "rsi", adx: "adx",
  ret_5d: "ret_5d", ret_21d: "ret_21d", ret_ytd: "ret_ytd",
  breakout_score: "breakout_score", prebreakout_score: "prebreakout_score",
  sector: "sector", industry: "industry",
  // Previously missing — filtering by these narrowed results but the
  // matching column never rendered, making the match criterion invisible.
  atr_pct: "atr_pct", macd_hist: "macd_hist", bb_width: "bb_width",
  rel_strength_nifty: "rel_strength_nifty", sector_strength: "sector_strength",
  high_52w: "high_52w", low_52w: "low_52w",
  current_ratio: "current_ratio", quick_ratio: "quick_ratio",
  sales: "sales", net_profit: "net_profit",
};

export interface ColsFromFiltersOpts {
  /** When true, filters whose kind is 'boolean' don't add a column. Default true. */
  skipBooleans?: boolean;
  /** Restrict to a set of allowed column ids (used to intersect with a specific table's registry). */
  allowedCols?: Set<string>;
}

/** Returns ["symbol", ...cols] derived from the active filters. */
export function colsFromActiveFilters(active: ActiveFilter[], opts: ColsFromFiltersOpts = {}): string[] {
  const { skipBooleans = true, allowedCols } = opts;
  const out: string[] = ["symbol"];
  const seen = new Set(out);
  for (const f of active) {
    const id = canonicalFilterId(f.id);
    const def = FILTER_BY_ID[id];
    if (!def) continue;
    if (skipBooleans && def.kind === "boolean") continue;
    const col = FILTER_TO_COL[id];
    if (!col) continue;
    if (allowedCols && !allowedCols.has(col)) continue;
    if (!seen.has(col)) { out.push(col); seen.add(col); }
  }
  return out;
}