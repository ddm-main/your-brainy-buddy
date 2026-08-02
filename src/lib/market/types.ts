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
  funds_last_attempt_at?: string | null;
  funds_last_error_code?: string | null;
  funds_retry_after_at?: string | null;
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
  volume?: number | null;
  day_open?: number | null;
  day_high?: number | null;
  day_low?: number | null;
  source?: string | null;
  // Per-quote provider that actually served this row ("kotak" | "yahoo" |
  // "cache"). The Screener overlays intraday values on a row ONLY when this
  // is "kotak" — Yahoo/cache stay on the EOD number the filter used, so the
  // displayed 1D% can't drift below the range the user filtered on.
  provider?: string | null;
  as_of?: string | null;
  previous_close_as_of?: string | null;
  stale?: boolean | null;
}

export interface IndexQuote {
  symbol: string;
  name: string;
  price: number | null;
  change_pct: number | null;
  change_abs: number | null;
  region?: "IN" | "GLOBAL";
  nse_symbol?: string | null;
  fno_enabled?: boolean;
  constituents_slug?: string | null;
  source?: "kotak" | "yahoo" | "cache" | null;
  live_required?: boolean;
  delayed_blocked?: boolean;
  reason?: string | null;
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
  india_vix: number | null;
  fii_net_cr: number | null;
  dii_net_cr: number | null;
  new_highs: number | null;
  new_lows: number | null;
  market_score: number | null;
  computed_at?: string | null;
}

export interface TopMoverRow {
  symbol: string;
  exchange: string;
  sector: string | null;
  close: number | null;
  change_pct: number | null;
  volume: number | null;
  rel_volume: number | null;
  rsi14: number | null;
  breakout_score: number | null;
  trade_date: string | null;
  direction: "gain" | "lose";
  rn: number;
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
  // Breakout Intelligence v4 — coverage-aware score written by the aggregates
  // pass. Null until that pass has run for the session.
  breakout_score_v4?: number | null;
  breakout_band?: string | null;
  breakout_v4_rank_pct?: number | null;
  breakout_v4_components?: Record<string, number> | null;
  breakout_v4_coverage?: Record<string, number> | null;
  score_coverage?: number | null;
  score_unavailable_reason?: string | null;
  bars_available?: number | null;
  context_complete?: boolean | null;
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
  is_broker_synced?: boolean | null;
  exit_source?: string | null;
  product?: "MIS" | "CNC" | "NRML" | null;
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
  /**
   * What actually served this response:
   *  kotak_neo — live broker data
   *  yahoo     — ~15m delayed (only off-session, or symbols Kotak can't cover,
   *              or opt-in delayed fallback during session)
   *  cache     — stored bars from the last successful Kotak read
   *  quote     — live Kotak quote seeded the current candle while history is down
   *  quote_delayed — same idea but the quote itself is Yahoo/cache (~15m late)
   *  none      — nothing available (broker down during the session)
   */
  provider?: "kotak_neo" | "yahoo" | "cache" | "quote" | "quote_delayed" | "none";
  /** True whenever the data is not a live Kotak read. */
  degraded?: boolean;
  /** Machine-readable cause when degraded: broker_503, route_missing, session, no_token, empty, broker_503_delayed… */
  reason?: string;
  /** When `provider === "cache"`, ISO timestamp of the newest cached bar's fetch. */
  cached_at?: string;
  /** When `provider === "yahoo"` during session, roughly how stale the feed is. */
  delayed_minutes?: number;
  // ---- P0 provenance additions (all optional / backwards-compatible) ----
  /** Server clock at response time (ISO). Used by clients to compute freshness. */
  as_of?: string;
  /** ISO timestamp of the newest candle in the series. */
  last_bar_at?: string;
  /** ms between `last_bar_at` and `as_of`. */
  freshness_ms?: number;
  /** Session state for the exchange serving these bars. */
  market_session?: "open" | "closed" | "pre_open" | "post_close" | "holiday" | "weekend";
  /** Source of the historical series (everything except the current bar). */
  history_source?: "kotak_neo" | "yahoo" | "cache" | "mixed" | "none";
  /** Source of ONLY the most recent (possibly quote-seeded) bar. */
  last_bar_source?: "kotak_neo" | "yahoo" | "cache" | "quote" | "quote_delayed" | "none";
  /** True when the server answered a `since` request with only the tail bars —
   *  the client must merge these onto its cached series, not replace it. */
  partial?: boolean;
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
