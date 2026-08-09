// Screener runner: reads the unified market_data table.
// All provider-specific fields normalized into this single table.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { UniverseId } from "./screenerCatalog";
import { safeStorage } from "@/lib/safeStorage";
import { liveInterval, marketOpen } from "./hooks";

// Shape of a market_data row as consumed by the screener/StockTable — the
// unified schema (see 20260721000000_market_multi_provider.sql), NOT the
// legacy market_stock_scores shape (StockScore in ./types) which uses
// different field names (close/rsi14/ema20/above_ema200 etc). Those two
// tables are dual-written by market-pipeline-eod but have distinct schemas;
// don't conflate them.
export interface ScreenerRow {
  symbol: string;
  exchange: string;
  trade_date: string | null;
  // Session the technical indicators belong to. Equals trade_date whenever the
  // score row was computed for the displayed price session; a different (or
  // null) value means the indicators lag the price and tech filters skip it.
  score_trade_date: string | null;
  company_name: string | null;
  sector: string | null;
  sub_sector: string | null;
  industry: string | null;
  instrument_type?: string | null;
  market_cap: number | null; // ₹ Cr
  /** Where market_cap came from: reported_live | reported_eod | reported | derived | none */
  mcap_basis: string | null;
  data_provenance?: Record<string, unknown> | null;
  is_nifty500: boolean;
  in_nifty50: boolean;
  in_banknifty: boolean;
  in_finnifty: boolean;

  ltp: number | null;
  previous_close: number | null;
  change_abs: number | null;
  change_pct: number | null;
  change_pct_raw: number | null;

  // --- live plane (market_live_prices, published only by an atomic sweep) ---
  /** `live` = priced by the promoted sweep for today's session, `stale_live` =
   *  a live row exists but belongs to an older session (demoted, EOD is shown),
   *  `eod` = settled bar only, `no_quote` = neither. */
  quote_state: "live" | "stale_live" | "eod" | "no_quote" | null;
  live_provider: string | null;
  live_as_of: string | null;
  live_sweep_id: string | null;
  live_volume: number | null;
  /** Seconds since the live tick was captured (null when not live). */
  live_age_s: number | null;
  /** True when a live row exists but has been demoted for being from an older session. */
  live_stale: boolean | null;
  /** Fraction of the 09:15–15:30 IST session elapsed (0.02–1). */
  session_elapsed_frac: number | null;
  /** live volume ÷ (30-day average volume × elapsed session fraction). */
  vol_pace_ratio: number | null;
  /** Pace-aware version of vol_gt_avg30 — compares intraday volume to the
   *  pro-rated 30-day average instead of the full-day average. */
  vol_gt_avg30_paced: boolean | null;
  /** Raw (Economic-Times parity) comparison: cumulative session volume vs the
   *  full-day 30-day average. Statistically pessimistic intraday, but it is
   *  what external screeners print, so it is selectable. */
  vol_gt_avg30_raw: boolean | null;

  // --- settled bhavcopy passthrough, used verbatim by EOD mode ---
  eod_trade_date: string | null;
  eod_close: number | null;
  eod_previous_close: number | null;
  eod_change_abs: number | null;
  eod_change_pct: number | null;
  eod_change_pct_raw: number | null;
  eod_volume: number | null;
  eod_market_cap: number | null;
  eod_vol_gt_avg30: boolean | null;
  /** Settled-basis valuation/technicals, before live revaluation. */
  eod_pe: number | null;
  eod_pb: number | null;
  eod_rel_volume: number | null;
  eod_pct_from_52w_high: number | null;



  // fundamentals (unified schema)
  pe: number | null;
  pb: number | null;
  peg: number | null;
  eps: number | null;
  book_value: number | null;
  dividend_yield: number | null;
  roe: number | null;
  roce: number | null;
  debt_equity: number | null;
  current_ratio: number | null;
  quick_ratio: number | null;
  sales: number | null;
  net_profit: number | null;
  sales_growth: number | null;
  profit_growth: number | null;
  eps_growth: number | null;
  promoter_holding: number | null;
  dii_holding: number | null;
  fii_holding: number | null;
  institutional_holding: number | null;

  high_52w: number | null;
  low_52w: number | null;

  // technicals (unified schema)
  volume: number | null;
  vol_avg30: number | null;
  rel_volume: number | null;
  vol_gt_avg30: boolean | null;
  ema_20: number | null;
  ema_50: number | null;
  ema_100: number | null;
  ema_200: number | null;
  rsi: number | null;
  macd: number | null;
  macd_signal: number | null;
  macd_hist: number | null;
  adx: number | null;
  atr: number | null;
  atr_pct: number | null;
  bb_upper: number | null;
  bb_lower: number | null;
  bb_width: number | null;
  bb_squeeze: boolean | null;
  pct_from_52w_high: number | null;
  above_ema_200: boolean | null;
  higher_lows: boolean | null;
  near_resistance: boolean | null;
  resistance_level: number | null;
  support_level: number | null;
  sector_strength: number | null;
  rel_strength_nifty: number | null;
  breakout_score: number | null;
  /** v4 breakout score — the model the explain view and the Breakout board
   *  use. Not in the screener view, merged in from market_stock_scores. */
  breakout_score_v4: number | null;
  breakout_v4_buckets: Record<string, number> | null;
  prebreakout_score: number | null;
  score_components: { breakout?: Record<string, number>; prebreakout?: Record<string, number> } | null;
  ret_5d: number | null;
  ret_21d: number | null;
  ret_ytd: number | null;
  fno_enabled: boolean | null;
  sme: boolean | null;

  // v3 — swing/intraday scoring + liquidity gate. Additive; breakout_score/
  // prebreakout_score above are unrelated and unchanged.
  swing_score: number | null;
  swing_components: Record<string, number> | null;
  intraday_score: number | null;
  intraday_components: Record<string, number> | null;
  avg_turnover_cr: number | null;
  is_liquid_tradable: boolean | null;
  // false while only the neutral-context EOD pass has run (sector/RS/regime
  // not yet applied) — the badge marks such scores provisional.
  context_complete: boolean | null;
}


const universeIndexKey: Record<UniverseId, string | null> = {
  all:       null,
  nifty500:  null,
  nifty50:   "NIFTY50",
  banknifty: "BANKNIFTY",
  finnifty:  "FINNIFTY",
  midcap150: "NIFTYMIDCAP150",
  smallcap250: "NIFTYSMALLCAP250",
  fno:       null,
  sme:       null,
};

async function fetchIndexMemberSet(indexKey: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("market_index_members").select("symbol").eq("index_key", indexKey);
  if (error) throw error;
  return new Set((data ?? []).map((r: any) => r.symbol));
}

// Explicit projection — drops ~15 unused fundamental_* duplicates and metadata
// columns from the wire, ~30% smaller responses than the previous `select("*")`.
//
// EGRESS: the two jsonb blobs this view carries (`score_components` ~616 B and
// `data_provenance` ~609 B per row) were 30% of an 11 MB full-universe fetch
// and are read by exactly two things: the score-badge popover (hover only) and
// the market-cap source tooltip. `score_components` is therefore fetched
// lazily per symbol (see ScoreBadge), and only the two provenance keys the UI
// actually reads are projected as scalars.
// EGRESS: the row is fetched as TWO planes instead of one 108-column payload.
//
//  * STATIC_COLUMNS — identity, sector, fundamentals, technicals, 52w levels,
//    scores and the settled (EOD) plane. These change once a day (post-close),
//    so they are fetched once per session and cached, not every 60 s.
//  * LIVE_COLUMNS — only what actually moves intraday (price, change, volume,
//    the live-revalued derivations and freshness metadata). This is the only
//    payload that repeats on the poll cadence, and it is ~1/4 the bytes.
//
// The two are merged in memory before `toScreenerRow`, so nothing downstream
// changes. Together with the 5 min poll (the server sweep publishes every
// 5 min — polling faster only bought duplicate bytes) this cut the screener
// from ~2.6 MB/min to ~0.7 MB/5 min.
//
// EGRESS (stage 2): both planes are further narrowed to the fields the screen
// actually needs right now. `planProjection` intersects the full plane with
// the visible column preset + the columns the active filters reference, so a
// four-filter Tickertape-style run pulls ~12 columns instead of 108. Filtering
// itself still happens client-side against the same view, so no displayed
// value can change — only the number of columns on the wire does.
const STATIC_BASE = [
  "symbol","exchange","company_name","sector","sub_sector","industry",
  "is_nifty500","instrument_type","is_liquid_tradable","fno_enabled","sme",
  "vol_avg30","breakout_score","breakout_score_v4",
  // The blob's real keys are `mcap` (source tag) and `mcap_as_of`.
  "mcap_source:data_provenance->>mcap",
  "mcap_as_of:data_provenance->>mcap_as_of",
  // The settled plane powers the Live/EOD toggle, which is a pure projection
  // over an already-fetched row — it must always be present.
  "eod_trade_date","eod_close","eod_previous_close","eod_change_abs",
  "eod_change_pct","eod_change_pct_raw","eod_volume","eod_market_cap","eod_vol_gt_avg30",
];

/** Extra static-plane columns each screener field id requires. */
const FIELD_STATIC: Record<string, string[]> = {
  symbol: [], exchange: [], company_name: [], sector: [], industry: [], sub_sector: [],
  market_cap: [], close: [], change_pct: [], volume: [], vol_avg30: [],
  vol_gt_avg30: ["vol_gt_avg30"],
  rel_volume: ["rel_volume"],
  rsi: ["rsi14"], adx: ["adx14"],
  macd_hist: ["macd","macd_signal","macd_hist"],
  atr_pct: ["atr14","atr_pct"],
  bb_width: ["bb_upper","bb_lower","bb_width"],
  high_52w: ["high_52w"], low_52w: ["low_52w"],
  pct_from_52w_high: ["pct_from_52w_high"],
  above_ema_200: ["above_ema200"],
  sector_strength: ["sector_strength"], rel_strength_nifty: ["rel_strength_nifty"],
  prebreakout_score: ["prebreakout_score"],
  breakout_score: ["breakout_score"], breakout_score_v4: [],
  swing_score: ["swing_score"], intraday_score: ["intraday_score"],
  avg_turnover_cr: [],
  setup: ["bb_squeeze","higher_lows","near_resistance"],
  pe: ["pe_ttm"], pb: ["pb"], peg: ["peg"], eps: ["eps_ttm"],
  book_value: ["book_value"], dividend_yield: ["dividend_yield"],
  roe: ["roe"], roce: ["roce"], debt_equity: ["debt_to_equity"],
  current_ratio: ["current_ratio"], quick_ratio: ["quick_ratio"],
  sales: ["revenue_ttm_cr"], net_profit: ["profit_ttm_cr"],
  sales_growth: ["revenue_growth_yoy"], profit_growth: ["profit_growth_yoy"],
  eps_growth: ["eps_growth_yoy"],
  promoter_holding: ["promoter_holding"], fii_holding: ["fii_holding"], dii_holding: ["dii_holding"],
  institutional_holding: ["fii_holding","dii_holding"],
  ret_5d: ["ret_5d"], ret_21d: ["ret_21d"], ret_ytd: ["ret_ytd"],
  fno_enabled: [], sme: [],
  // Filter-only ids that never became their own column, plus the row-actions
  // column. Without these a single "Price" or "BB Squeeze" filter silently
  // widened the request back to the full 108-column plane.
  ltp: [],
  bb_squeeze: ["bb_squeeze"],
  higher_lows: ["higher_lows"],
  near_resistance: ["near_resistance"],
  actions: [],
};

const LIVE_BASE = [
  "symbol","exchange","trade_date","score_trade_date","market_cap","mcap_basis",
  "close","previous_close","change_abs","change_pct","change_pct_raw","volume",
  "quote_state","live_provider","live_as_of","live_volume",
  "live_age_s","live_stale","session_elapsed_frac","vol_pace_ratio","vol_gt_avg30_paced",
];

/** Live-revalued twins — only fetched when the matching field is on screen. */
const FIELD_LIVE: Record<string, string[]> = {
  rel_volume: ["rel_volume_live"],
  pe: ["pe_live"], pb: ["pb_live"], peg: ["peg_live"],
  dividend_yield: ["dividend_yield_live"],
  high_52w: ["high_52w_live"], low_52w: ["low_52w_live"],
  pct_from_52w_high: ["pct_from_52w_high_live"],
  above_ema_200: ["above_ema200_live"],
  setup: ["near_resistance_live"],
  near_resistance: ["near_resistance_live"],
  atr_pct: ["atr_pct_live"],
};

const STATIC_FULL = Array.from(new Set([
  ...STATIC_BASE, ...Object.values(FIELD_STATIC).flat(),
])).join(",");
const LIVE_FULL = Array.from(new Set([
  ...LIVE_BASE, ...Object.values(FIELD_LIVE).flat(),
])).join(",");

export interface Projection { statics: string; live: string; key: string }

/** Build the two column lists for a set of on-screen field ids.
 *  An unrecognised field falls back to the full plane — a projection is only
 *  ever allowed to be narrower than what the screen can render if every field
 *  it needs is accounted for. */
export function planProjection(fields: string[] | null | undefined): Projection {
  if (!fields || fields.length === 0) {
    return { statics: STATIC_FULL, live: LIVE_FULL, key: "full" };
  }
  const s = new Set(STATIC_BASE);
  const l = new Set(LIVE_BASE);
  for (const f of fields) {
    const add = FIELD_STATIC[f];
    if (!add) {
      if (import.meta.env.DEV) {
        console.warn(`[screener] unmapped field "${f}" — falling back to the full column plane`);
      }
      return { statics: STATIC_FULL, live: LIVE_FULL, key: "full" };
    }
    add.forEach((c) => s.add(c));
    (FIELD_LIVE[f] ?? []).forEach((c) => l.add(c));
  }
  const statics = Array.from(s).join(",");
  const live = Array.from(l).join(",");
  return { statics, live, key: `${s.size}:${l.size}:${Array.from(fields).sort().join("|")}` };
}



/** Server-side universe narrowing. Fetching all 2 800 rows and filtering in
 *  the browser meant every "Nifty 50" view still paid for the whole universe. */
function applyUniverseQuery(q: any, universeSet: Set<string> | "nifty500" | "fno" | "sme" | null): any {
  if (universeSet === "nifty500") return q.eq("instrument_type", "EQ").eq("is_nifty500", true);
  if (universeSet === "fno")      return q.eq("instrument_type", "EQ").eq("fno_enabled", true);
  if (universeSet === "sme")      return q.eq("sme", true);
  if (universeSet === null)       return q.eq("instrument_type", "EQ");
  return q.eq("instrument_type", "EQ").in("symbol", Array.from(universeSet));
}

// EGRESS: the statics plane is ~210 KB and only changes after the close, but
// every reload/new tab re-fetched it because react-query's cache is in memory.
// Persist it for the session so a day of reloads costs one fetch, not twenty.
const STATIC_CACHE_PREFIX = "screener.statics.v1:";
const STATIC_CACHE_TTL_MS = 6 * 3_600_000;
const STATIC_CACHE_MAX_CHARS = 1_500_000; // stay well inside the 5 MB quota

function readStaticCache(key: string): any[] | null {
  const raw = safeStorage.get(STATIC_CACHE_PREFIX + key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { at: number; rows: any[] };
    if (!parsed?.at || Date.now() - parsed.at > STATIC_CACHE_TTL_MS) return null;
    return Array.isArray(parsed.rows) && parsed.rows.length > 0 ? parsed.rows : null;
  } catch { return null; }
}

function writeStaticCache(key: string, rows: any[]): void {
  try {
    const payload = JSON.stringify({ at: Date.now(), rows });
    if (payload.length > STATIC_CACHE_MAX_CHARS) return;
    safeStorage.set(STATIC_CACHE_PREFIX + key, payload);
  } catch { /* ignore */ }
}

// EGRESS: the board only ever renders one page at a time, but both planes used
// to ship the whole ~1 800-row universe on every open (206 KB + 154 KB). The
// default read is now capped at BOARD_ROWS, server-ordered by breakout_score —
// the same order the board opens in — and the full plane is only fetched when
// something actually needs it (an active filter, a CSV export, "load all").
export const BOARD_ROWS = 300;
const PAGE = 1000;

async function fetchScreenerRows(
  universeSet: Set<string> | "nifty500" | "fno" | "sme" | null,
  columns: string,
  cap: number | null = null,
): Promise<any[]> {
  const rows: any[] = [];
  const step = cap ? Math.min(cap, PAGE) : PAGE;
  for (let from = 0; ; from += step) {
    const base = (supabase as any)
      .from("market_screener_rows")
      .select(columns)
      .eq("is_active", true)
      .eq("exchange", "NSE");
    const { data, error } = await applyUniverseQuery(base, universeSet)
      .order("breakout_score", { ascending: false, nullsFirst: false })
      .order("symbol", { ascending: true })
      .range(from, from + step - 1);
    if (error) throw error;
    const chunk = data ?? [];
    rows.push(...chunk);
    if (chunk.length < step) break;
    if (cap && rows.length >= cap) break;
  }
  return cap ? rows.slice(0, cap) : rows;
}


// The board, the badge popover and /market/score/:sym/explain all read the v4
// score — ranking on the legacy v2 while showing v4 is how a "top breakout"
// list ends up disagreeing with every number printed next to it.
//
// EGRESS: v4 used to be merged in from `market_stock_scores` in 500-symbol
// chunks (~29 KB each, ~10 MB/day). The screener view now carries
// `breakout_score_v4` itself, so ranking is a pure in-memory sort.
function rankByV4(rows: any[]): any[] {
  const rank = (r: any) => r.breakout_score_v4 ?? r.breakout_score ?? -1;
  return rows.sort((a, b) => rank(b) - rank(a) || String(a.symbol).localeCompare(String(b.symbol)));
}

// Universe narrowing now happens in the query (applyUniverseQuery) so a
// "Nifty 50" view no longer pays for the whole 2 800-row universe.


async function resolveUniverseFilter(
  universe: UniverseId,
): Promise<Set<string> | "nifty500" | "fno" | "sme" | null> {
  if (universe === "all") return null;
  if (universe === "nifty500") return "nifty500";
  if (universe === "fno")      return "fno";
  if (universe === "sme")      return "sme";
  const key = universeIndexKey[universe];
  if (!key) return null;
  return fetchIndexMemberSet(key);
}

function toScreenerRow(s: any, idxSets: { NIFTY50: Set<string>; BANKNIFTY: Set<string>; FINNIFTY: Set<string> }): ScreenerRow {
  const num = (v: any): number | null => (v == null || Number.isNaN(Number(v))) ? null : Number(v);
  return {
    symbol: s.symbol,
    exchange: s.exchange,
    trade_date: s.trade_date ?? null,
    score_trade_date: s.score_trade_date ?? null,
    sector:       s.sector ?? null,
    sub_sector:   s.sub_sector ?? s.industry ?? s.sector ?? null,
    company_name: s.company_name ?? null,
    market_cap:   num(s.market_cap),
    mcap_basis:   (s.mcap_basis as string | null) ?? null,
    is_nifty500:  Boolean(s.is_nifty500),
    industry:     s.industry ?? null,
    // Rebuilt from the two projected scalars so the UI keeps its existing
    // shape without the ~600 B blob crossing the wire.
    data_provenance: (s.mcap_source || s.mcap_as_of)
      ? { market_cap_source: s.mcap_source ?? null, market_cap_as_of: s.mcap_as_of ?? null }
      : null,

    in_nifty50:   idxSets.NIFTY50.has(s.symbol),
    in_banknifty: idxSets.BANKNIFTY.has(s.symbol),
    in_finnifty:  idxSets.FINNIFTY.has(s.symbol),
    instrument_type:   s.instrument_type ?? null,

    ltp:               num(s.close ?? s.ltp),
    previous_close:    num(s.previous_close),
    change_abs:        num(s.change_abs),
    change_pct:        num(s.change_pct),
    // Served by the view from the same session's close/prev_close that
    // `change_pct` rounds — never re-derived here, so the number the filters
    // evaluate and the number the table renders can't drift apart.
    change_pct_raw:    num(s.change_pct_raw) ?? num(s.change_pct),

    quote_state:       (s.quote_state ?? null) as ScreenerRow["quote_state"],
    live_provider:     s.live_provider ?? null,
    live_as_of:        s.live_as_of ?? null,
    live_sweep_id:     s.live_sweep_id ?? null,
    live_volume:       num(s.live_volume),
    live_age_s:        num(s.live_age_s),
    live_stale:        s.live_stale ?? null,
    session_elapsed_frac: num(s.session_elapsed_frac),
    vol_pace_ratio:    num(s.vol_pace_ratio),
    vol_gt_avg30_paced: s.vol_gt_avg30_paced ?? null,
    // Raw ET-parity basis: cumulative session volume vs full-day 30D average.
    // Computed here so it exists in both planes without another column.
    vol_gt_avg30_raw: (() => {
      const v = num(s.volume);
      const avg = num(s.vol_avg30);
      if (v == null || avg == null || avg <= 0) return null;
      return v > avg;
    })(),

    eod_trade_date:      s.eod_trade_date ?? null,
    eod_close:           num(s.eod_close),
    eod_previous_close:  num(s.eod_previous_close),
    eod_change_abs:      num(s.eod_change_abs),
    eod_change_pct:      num(s.eod_change_pct),
    eod_change_pct_raw:  num(s.eod_change_pct_raw) ?? num(s.eod_change_pct),
    eod_volume:          num(s.eod_volume),
    eod_market_cap:      num(s.eod_market_cap),
    eod_vol_gt_avg30:    s.eod_vol_gt_avg30 ?? null,
    eod_pe:              num(s.pe_ttm),
    eod_pb:              num(s.pb),
    eod_rel_volume:      num(s.rel_volume),
    eod_pct_from_52w_high: num(s.pct_from_52w_high),



    pe:                num(s.pe_live ?? s.pe_ttm ?? s.pe),
    pb:                num(s.pb_live ?? s.pb),
    peg:               num(s.peg_live ?? s.peg),
    eps:               num(s.eps_ttm ?? s.eps),
    book_value:        num(s.book_value),
    dividend_yield:    num(s.dividend_yield_live ?? s.dividend_yield),
    roe:               num(s.roe),
    roce:              num(s.roce),
    debt_equity:       num(s.debt_to_equity ?? s.debt_equity),
    current_ratio:     num(s.current_ratio),
    quick_ratio:       num(s.quick_ratio),
    sales:             num(s.revenue_ttm_cr ?? s.sales),
    net_profit:        num(s.profit_ttm_cr ?? s.net_profit),
    sales_growth:      num(s.revenue_growth_yoy ?? s.sales_growth),
    profit_growth:     num(s.profit_growth_yoy ?? s.profit_growth),
    eps_growth:        num(s.eps_growth_yoy ?? s.eps_growth),
    promoter_holding:  num(s.promoter_holding),
    dii_holding:       num(s.dii_holding),
    fii_holding:       num(s.fii_holding),
    institutional_holding: (() => {
      const d = num(s.dii_holding);
      const f = num(s.fii_holding);
      if (d == null && f == null) return null;
      return (d ?? 0) + (f ?? 0);
    })(),
    high_52w:          num(s.high_52w_live ?? s.high_52w),
    low_52w:           num(s.low_52w_live ?? s.low_52w),
    ret_5d:            num(s.ret_5d),
    ret_21d:           num(s.ret_21d),
    ret_ytd:           num(s.ret_ytd),
    fno_enabled:       s.fno_enabled ?? null,
    sme:               s.sme ?? null,

    volume:            num(s.volume),
    rel_volume:        num(s.rel_volume_live ?? s.rel_volume),
    vol_avg30:         num(s.vol_avg30),
    // Pace-aware during the session (intraday volume vs pro-rated 30D avg);
    // falls back to the settled full-day comparison outside market hours.
    vol_gt_avg30:      s.vol_gt_avg30_paced ?? s.vol_gt_avg30 ?? null,

    ema_20:            num(s.ema20 ?? s.ema_20),
    ema_50:            num(s.ema50 ?? s.ema_50),
    ema_100:           num(s.ema100 ?? s.ema_100),
    ema_200:           num(s.ema200 ?? s.ema_200),
    rsi:               num(s.rsi14 ?? s.rsi),
    macd:              num(s.macd),
    macd_signal:       num(s.macd_signal),
    macd_hist:         num(s.macd_hist),
    adx:               num(s.adx14 ?? s.adx),
    atr:               num(s.atr14 ?? s.atr),
    atr_pct:           num(s.atr_pct_live ?? s.atr_pct),
    bb_upper:          num(s.bb_upper),
    bb_lower:          num(s.bb_lower),
    bb_width:          num(s.bb_width),
    bb_squeeze:        s.bb_squeeze ?? null,
    pct_from_52w_high: num(s.pct_from_52w_high_live ?? s.pct_from_52w_high),
    above_ema_200:     s.above_ema200_live ?? s.above_ema200 ?? s.above_ema_200 ?? null,
    higher_lows:       s.higher_lows ?? null,
    near_resistance:   s.near_resistance_live ?? s.near_resistance ?? null,
    resistance_level:  num(s.resistance_level),
    support_level:     num(s.support_level),
    sector_strength:   num(s.sector_strength),
    rel_strength_nifty: num(s.rel_strength_nifty),
    breakout_score:    s.breakout_score ?? null,
    breakout_score_v4: s.breakout_score_v4 ?? null,
    breakout_v4_buckets: s.breakout_v4_buckets ?? (s.breakout_v4_components as any)?.buckets ?? null,
    prebreakout_score: s.prebreakout_score ?? null,
    score_components:  s.score_components ?? null,
    swing_score:        s.swing_score ?? null,
    swing_components:   s.swing_components ?? null,
    intraday_score:      s.intraday_score ?? null,
    intraday_components: s.intraday_components ?? null,
    avg_turnover_cr:     num(s.avg_turnover_cr),
    is_liquid_tradable:  s.is_liquid_tradable ?? null,
    context_complete:    s.context_complete ?? null,
  };
}

async function fetchIndexMembershipSets(symbols: string[]) {
  const idxSets = { NIFTY50: new Set<string>(), BANKNIFTY: new Set<string>(), FINNIFTY: new Set<string>() };
  for (let i = 0; i < symbols.length; i += 500) {
    const slice = symbols.slice(i, i + 500);
    const { data } = await supabase
      .from("market_index_members")
      .select("symbol, index_key")
      .in("symbol", slice)
      .in("index_key", ["NIFTY50", "BANKNIFTY", "FINNIFTY"]);
    (data ?? []).forEach((m: any) => {
      const k = m.index_key as keyof typeof idxSets;
      if (idxSets[k]) idxSets[k].add(m.symbol);
    });
  }
  return idxSets;
}

/** Coverage/date metadata returned by the back-date run. `as_of` is the
 *  trading session actually used (the requested date snaps back over
 *  weekends/holidays); the skip counts explain any shortfall vs the universe. */
export interface AsofMeta {
  as_of: string;
  requested_as_of: string;
  earliest_as_of: string | null;
  universe_size: number;
  count: number;
  skipped_no_history: number;
  skipped_short_history: number;
}

const asofMetaCache = new Map<string, AsofMeta>();
const asofKey = (universe: UniverseId, asOf: string) => `${universe}|${asOf}`;

/** Read the metadata of the most recent back-date run for this universe/date.
 *  Populated by `useScreenerData`'s query function. */
export function getAsofMeta(universe: UniverseId, asOf: string | null): AsofMeta | null {
  if (!asOf) return null;
  return asofMetaCache.get(asofKey(universe, asOf)) ?? null;
}

const EMPTY_IDX = { NIFTY50: new Set<string>(), BANKNIFTY: new Set<string>(), FINNIFTY: new Set<string>() };

export function useScreenerData(
  universe: UniverseId,
  asOfDate: string | null = null,
  enabled = true,
  /** Field ids currently on screen (visible columns + active filter columns).
   *  Omit for the full plane. */
  fields: string[] | null = null,
  /** Fetch the whole universe instead of just the first board page. Required by
   *  client-side filtering, sorting on a non-server column and CSV export. */
  loadAll = false,
) {
  const projection = useMemo(() => planProjection(fields), [fields?.join("|")]);
  const cap = loadAll ? null : BOARD_ROWS;
  const capKey = loadAll ? "all" : String(BOARD_ROWS);

  // ---- Back-date branch: one deterministic edge-function call, cached forever.
  const asof = useQuery({
    queryKey: ["market", "screener-asof-v3", universe, asOfDate ?? "none"],
    queryFn: async (): Promise<ScreenerRow[]> => {
      const { data, error } = await supabase.functions.invoke("market-screener-asof", {
        body: { as_of: asOfDate, universe },
      });
      // functions.invoke surfaces a generic FunctionsHttpError; the useful
      // message (e.g. "history starts 2024-07-18") is in the JSON body.
      if (error) {
        const detail = await (error as any)?.context?.json?.().catch(() => null);
        throw new Error(detail?.error ?? error.message);
      }
      const payload = data as any;
      if (payload?.error) throw new Error(payload.error);
      asofMetaCache.set(asofKey(universe, asOfDate!), {
        as_of: payload?.as_of ?? asOfDate!,
        requested_as_of: payload?.requested_as_of ?? asOfDate!,
        earliest_as_of: payload?.earliest_as_of ?? null,
        universe_size: Number(payload?.universe_size ?? 0),
        count: Number(payload?.count ?? 0),
        skipped_no_history: Number(payload?.skipped_no_history ?? 0),
        skipped_short_history: Number(payload?.skipped_short_history ?? 0),
      });
      const rows: any[] = payload?.rows ?? [];
      if (rows.length === 0) return [];
      const idxSets = await fetchIndexMembershipSets(rows.map((r) => r.symbol));
      return rows.map((r) => toScreenerRow(r, idxSets));
    },
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: false,
    enabled: enabled && !!asOfDate,
  });

  // ---- Static plane: fundamentals, technicals, scores, settled EOD prices.
  // These only change after the close, so this is fetched once per session and
  // never polled — it is ~3/4 of the payload and 0 % of the intraday movement.
  const statics = useQuery({
    queryKey: ["market", "screener-static-v2", universe, projection.key],
    queryFn: async () => {
      const cacheKey = `${universe}:${projection.key}`;
      const cached = readStaticCache(cacheKey);
      const rows = cached ?? await fetchScreenerRows(await resolveUniverseFilter(universe), projection.statics);

      if (rows.length === 0) return { rows, idxSets: EMPTY_IDX };
      if (!cached) writeStaticCache(cacheKey, rows);
      const idxSets = await fetchIndexMembershipSets(rows.map((s: any) => s.symbol));
      return { rows: rankByV4(rows), idxSets };
    },
    staleTime: 6 * 3_600_000,
    gcTime: 6 * 3_600_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: false,
    enabled: enabled && !asOfDate,
  });

  // ---- Live plane: the ~30 columns that actually tick. Polled on the server
  // sweep cadence (5 min) and never in a background tab.
  const live = useQuery({
    queryKey: ["market", "screener-live-v2", universe, projection.key],
    queryFn: async () => {
      const universeSet = await resolveUniverseFilter(universe);
      return await fetchScreenerRows(universeSet, projection.live);

    },
    staleTime: marketOpen() ? 4 * 60_000 : 15 * 60_000,
    gcTime: 30 * 60_000,
    refetchInterval: liveInterval(5 * 60_000, false),
    refetchIntervalInBackground: false,
    // EGRESS: "always" re-shipped the whole live plane on every tab focus.
    // The 5-minute poll already covers the sweep cadence.
    refetchOnWindowFocus: false,
    retry: false,
    enabled: enabled && !asOfDate,
  });

  const merged = useMemo<ScreenerRow[]>(() => {
    if (asOfDate) return asof.data ?? [];
    const base = statics.data?.rows ?? [];
    if (base.length === 0) return [];
    const liveByKey = new Map<string, any>();
    for (const r of live.data ?? []) liveByKey.set(`${r.exchange}:${r.symbol}`, r);
    const idxSets = statics.data?.idxSets ?? EMPTY_IDX;
    return base.map((s: any) => toScreenerRow({ ...s, ...(liveByKey.get(`${s.exchange}:${s.symbol}`) ?? {}) }, idxSets));
  }, [asOfDate, asof.data, statics.data, live.data]);

  return {
    data: merged,
    isLoading: asOfDate ? asof.isLoading : (statics.isLoading || live.isLoading),
    isFetching: asOfDate ? asof.isFetching : (statics.isFetching || live.isFetching),
    error: (asOfDate ? asof.error : (statics.error ?? live.error)) as Error | null,
    dataUpdatedAt: asOfDate ? asof.dataUpdatedAt : live.dataUpdatedAt,
    refetch: () => { if (asOfDate) { void asof.refetch(); } else { void statics.refetch(); void live.refetch(); } },
  };
}


/** Single source of truth for Live vs EOD.
 *
 *  The row already carries both planes, so switching mode is a pure
 *  projection — no second fetch, no candidate cap, no overlay map that can
 *  disagree with the value a filter matched on. In EOD mode the price fields
 *  are replaced verbatim by the last settled bhavcopy session; in Live mode
 *  they stay as the promoted sweep published them. */
export type VolumeBasis = "paced" | "raw";

export function projectRowsForMode(
  rows: ScreenerRow[],
  liveMode: boolean,
  volBasis: VolumeBasis = "paced",
): ScreenerRow[] {
  if (liveMode) {
    // Volume basis only means something intraday: pace-adjusted compares the
    // session so far against a pro-rated average, raw is the ET-style
    // cumulative-vs-full-day comparison.
    if (volBasis !== "raw") return rows;
    return rows.map((r) => ({ ...r, vol_gt_avg30: r.vol_gt_avg30_raw }));
  }
  return rows.map((r) => ({
    ...r,
    trade_date:     r.eod_trade_date ?? r.trade_date,
    ltp:            r.eod_close,
    previous_close: r.eod_previous_close,
    change_abs:     r.eod_change_abs,
    change_pct:     r.eod_change_pct,
    change_pct_raw: r.eod_change_pct_raw ?? r.eod_change_pct,
    volume:         r.eod_volume,
    vol_gt_avg30:   r.eod_vol_gt_avg30,
    rel_volume:     r.eod_rel_volume ?? r.rel_volume,
    market_cap:     r.eod_market_cap ?? r.market_cap,
    // Valuation and 52-week distance must fall back to the settled basis too —
    // showing live-revalued P/E next to a settled close is the inconsistency
    // this projection exists to prevent.
    pe:             r.eod_pe ?? r.pe,
    pb:             r.eod_pb ?? r.pb,
    pct_from_52w_high: r.eod_pct_from_52w_high ?? r.pct_from_52w_high,
    live_age_s:     null,
    vol_pace_ratio: null,
    vol_gt_avg30_paced: null,
    quote_state:    r.eod_close != null ? "eod" : "no_quote",
  }));
}




/** Distinct sector list from the loaded rows — memoised on rows identity so
 *  the sidebar's enum picker doesn't rebuild the Set on every render. */
export function useScreenerSectors(rows: ScreenerRow[]): string[] {
  return useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => r.sector && set.add(r.sector));
    return Array.from(set).sort();
  }, [rows]);
}

/** Distinct industry list. Memoised for the same reason as sectors — the
 *  industry universe is 100+ strings and rebuilding it per keystroke was
 *  showing up in the profiler. */
export function useScreenerIndustries(rows: ScreenerRow[]): string[] {
  return useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => r.industry && set.add(r.industry));
    return Array.from(set).sort();
  }, [rows]);
}

