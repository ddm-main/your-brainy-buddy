// Row/DTO types for the Market section.

export type Provider = "kotak_neo" | "yahoo" | "zerodha" | "dhan";

export interface ApiSettings {
  id?: string;
  active_provider: Provider;
  consumer_key: string | null;
  base_url: string | null;
  ws_url: string | null;
  exchange: string | null;
  connection_status: string;
  token_expires_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  ucc: string | null;
  greeting_name: string | null;
  totp_secret_enc?: string | null;
}

export interface Quote {
  symbol: string;
  exchange: string;
  ltp: number;
  previous_close: number | null;
  change_pct: number | null;
  day_change: number | null;
  source?: string | null;
  as_of?: string | null;
  previous_close_as_of?: string | null;
  stale?: boolean | null;
}

export interface IndexQuote {
  symbol: string;
  name: string;
  price: number;
  change_pct: number | null;
  change_abs: number | null;
  region?: "IN" | "GLOBAL";
  nse_symbol?: string | null;
  fno_enabled?: boolean;
  constituents_slug?: string | null;
}

export interface IndexWatchRow {
  id: string;
  user_id: string;
  symbol: string;
  name: string;
  region: "IN" | "GLOBAL";
  nse_symbol: string | null;
  fno_enabled: boolean;
  constituents_slug: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface IndexConstituent {
  symbol: string;
  company: string;
  sector: string | null;
  close: number | null;
  change_pct: number | null;
  breakout_score: number | null;
  prebreakout_score: number | null;
  rel_volume: number | null;
  rsi14: number | null;
}

export interface BreadthDaily {
  trade_date: string;
  advances: number | null;
  declines: number | null;
  unchanged: number | null;
  pct_above_ema20: number | null;
  pct_above_ema50: number | null;
  pct_above_ema200: number | null;
  avg_rsi: number | null;
  nifty_close: number | null;
  nifty_change_pct: number | null;
  regime: string | null;
}

export interface SectorStrength {
  trade_date: string;
  sector: string;
  stock_count: number | null;
  avg_change_pct: number | null;
  avg_rsi: number | null;
  pct_above_ema50: number | null;
  strength_rank: number | null;
}

export interface StockScore {
  id: string;
  symbol: string;
  exchange: string;
  trade_date: string | null;
  close: number | null;
  change_pct: number | null;
  volume: number | null;
  rel_volume: number | null;
  ema20: number | null;
  ema50: number | null;
  ema100: number | null;
  ema200: number | null;
  rsi14: number | null;
  macd: number | null;
  macd_signal: number | null;
  macd_hist: number | null;
  adx14: number | null;
  atr14: number | null;
  atr_pct: number | null;
  bb_width: number | null;
  bb_squeeze: boolean | null;
  high_52w: number | null;
  low_52w: number | null;
  pct_from_52w_high: number | null;
  above_ema200: boolean | null;
  higher_lows: boolean | null;
  near_resistance: boolean | null;
  resistance_level: number | null;
  support_level: number | null;
  sector: string | null;
  sector_strength: number | null;
  rel_strength_nifty: number | null;
  breakout_score: number | null;
  prebreakout_score: number | null;
  // extended technicals / fundamentals stamped by the pipeline (nullable when not yet synced)
  delivery_pct?: number | null;
  mfi14?: number | null;
  bb_percent_b?: number | null;
  supertrend_dir?: number | null;
  vwap?: number | null;
  pe_ttm?: number | null;
  roe?: number | null;
  revenue_growth?: number | null;
  pattern_flags?: Record<string, boolean> | null;
  score_components: { breakout?: Record<string, number>; prebreakout?: Record<string, number> } | null;
  computed_at: string;
}

export interface Holding {
  id: string;
  symbol: string;
  exchange: string;
  quantity: number;
  avg_price: number;
  buy_date: string | null;
  investment_type: string | null;
  notes: string | null;
  source: string;
}

export interface Position {
  id: string;
  symbol: string;
  exchange: string;
  side: "long" | "short";
  quantity: number;
  entry_price: number;
  stop_loss: number | null;
  target: number | null;
  opened_at: string;
  closed_at: string | null;
  exit_price: number | null;
  pnl: number | null;
  trailing_stop: number | null;
  journal_notes: string | null;
}

export interface CandleDto {
  time: string | number; // "YYYY-MM-DD" for daily, unix seconds for intraday
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandlesResponse {
  candles: CandleDto[];
  emas: Record<string, Array<{ t: number; v: number | null }>>;
  timeframe: string;
}

export interface SavedScreener {
  id: string;
  name: string;
  description: string | null;
  filters: ScreenerGroup[];
  sort: { id: string; desc: boolean } | null;
}

// Screener model: groups are OR'd; conditions within a group are AND'd.
export interface ScreenerCondition {
  column: string;
  op: "gt" | "gte" | "lt" | "lte" | "eq" | "is_true" | "is_false";
  value?: number | string;
}
export interface ScreenerGroup {
  conditions: ScreenerCondition[];
}
