// Screener runner: reads the unified market_data table.
// All provider-specific fields normalized into this single table.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { UniverseId } from "./screenerCatalog";

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
const SCREENER_COLUMNS = [
  "symbol","exchange","company_name","sector","sub_sector","industry","market_cap",
  "is_nifty500","instrument_type","trade_date","score_trade_date","close","previous_close","change_abs",
  "change_pct","change_pct_raw","volume","is_liquid_tradable","swing_score","intraday_score",
  "rel_volume","vol_avg30","vol_gt_avg30","ema20","ema50","ema100","ema200","rsi14","macd","macd_signal",
  "macd_hist","adx14","atr14","atr_pct","bb_upper","bb_lower","bb_width",
  "bb_squeeze","high_52w","low_52w","pct_from_52w_high","above_ema200",
  "higher_lows","near_resistance","resistance_level","support_level",
  "sector_strength","rel_strength_nifty","breakout_score","prebreakout_score",
  "pe_ttm","pb","peg","eps_ttm","book_value","dividend_yield",
  "roe","roce","debt_to_equity","current_ratio","quick_ratio","revenue_ttm_cr",
  "profit_ttm_cr","revenue_growth_yoy","profit_growth_yoy","eps_growth_yoy",
  "promoter_holding","fii_holding","dii_holding",
  "ret_5d","ret_21d","ret_ytd","fno_enabled","sme",
  // The blob's real keys are `mcap` (source tag) and `mcap_as_of`.
  "mcap_source:data_provenance->>mcap",
  "mcap_as_of:data_provenance->>mcap_as_of",

].join(",");


/** Server-side universe narrowing. Fetching all 2 800 rows and filtering in
 *  the browser meant every "Nifty 50" view still paid for the whole universe. */
function applyUniverseQuery(q: any, universeSet: Set<string> | "nifty500" | "fno" | "sme" | null): any {
  if (universeSet === "nifty500") return q.eq("instrument_type", "EQ").eq("is_nifty500", true);
  if (universeSet === "fno")      return q.eq("instrument_type", "EQ").eq("fno_enabled", true);
  if (universeSet === "sme")      return q.eq("sme", true);
  if (universeSet === null)       return q.eq("instrument_type", "EQ");
  return q.eq("instrument_type", "EQ").in("symbol", Array.from(universeSet));
}

async function fetchScreenerRows(
  universeSet: Set<string> | "nifty500" | "fno" | "sme" | null,
): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const base = (supabase as any)
      .from("market_screener_rows")
      .select(SCREENER_COLUMNS)
      .eq("is_active", true)
      .eq("exchange", "NSE");
    const { data, error } = await applyUniverseQuery(base, universeSet)
      .order("breakout_score", { ascending: false, nullsFirst: false })
      .order("symbol", { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    const chunk = data ?? [];
    rows.push(...chunk);
    if (chunk.length < 1000) break;
  }
  return rows;
}

// The screener view exposes only the legacy v2 score, but the board, the badge
// popover and /market/score/:sym/explain all read v4 — ranking on v2 while
// showing v4 is how a "top breakout" list ends up disagreeing with every
// number printed next to it. Merge v4 in from the scores table and rank on it.
async function mergeV4Scores(rows: any[]): Promise<any[]> {
  const byKey = new Map<string, any>();
  for (const r of rows) byKey.set(`${r.exchange}:${r.symbol}`, r);
  const symbols = rows.map((r) => r.symbol as string);
  // Only the symbols actually on screen, and only the `buckets` sub-object of
  // `breakout_v4_components` — the full blob is several hundred bytes a row.
  for (let i = 0; i < symbols.length; i += 500) {
    const { data, error } = await (supabase as any)
      .from("market_stock_scores")
      .select("symbol,exchange,breakout_score_v4,buckets:breakout_v4_components->buckets")
      .in("symbol", symbols.slice(i, i + 500));
    if (error) break; // v4 columns unavailable — fall back to the legacy rank
    for (const r of data ?? []) {
      const target = byKey.get(`${r.exchange}:${r.symbol}`);
      if (!target) continue;
      target.breakout_score_v4 = r.breakout_score_v4 ?? null;
      target.breakout_v4_buckets = r.buckets ?? null;
    }
  }

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

    pe:                num(s.pe_ttm ?? s.pe),
    pb:                num(s.pb),
    peg:               num(s.peg),
    eps:               num(s.eps_ttm ?? s.eps),
    book_value:        num(s.book_value),
    dividend_yield:    num(s.dividend_yield),
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
    high_52w:          num(s.high_52w),
    low_52w:           num(s.low_52w),
    ret_5d:            num(s.ret_5d),
    ret_21d:           num(s.ret_21d),
    ret_ytd:           num(s.ret_ytd),
    fno_enabled:       s.fno_enabled ?? null,
    sme:               s.sme ?? null,

    volume:            num(s.volume),
    rel_volume:        num(s.rel_volume),
    vol_avg30:         num(s.vol_avg30),
    vol_gt_avg30:      s.vol_gt_avg30 ?? null,

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
    atr_pct:           num(s.atr_pct),
    bb_upper:          num(s.bb_upper),
    bb_lower:          num(s.bb_lower),
    bb_width:          num(s.bb_width),
    bb_squeeze:        s.bb_squeeze ?? null,
    pct_from_52w_high: num(s.pct_from_52w_high),
    above_ema_200:     s.above_ema200 ?? s.above_ema_200 ?? null,
    higher_lows:       s.higher_lows ?? null,
    near_resistance:   s.near_resistance ?? null,
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

export function useScreenerData(universe: UniverseId, asOfDate: string | null = null, enabled = true) {
  return useQuery({
    queryKey: ["market", "screener-rows-v3", universe, asOfDate ?? "latest"],
    queryFn: async (): Promise<ScreenerRow[]> => {
      // Back-date branch — delegate compute to the edge function.
      if (asOfDate) {
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
        asofMetaCache.set(asofKey(universe, asOfDate), {
          as_of: payload?.as_of ?? asOfDate,
          requested_as_of: payload?.requested_as_of ?? asOfDate,
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
      }

      // Live/latest branch — existing fast path.
      const universeSet = await resolveUniverseFilter(universe);
      const filtered = await fetchScreenerRows(universeSet);
      if (filtered.length === 0) return [];
      const [idxSets, ranked] = await Promise.all([
        fetchIndexMembershipSets(filtered.map((s: any) => s.symbol)),
        mergeV4Scores(filtered),
      ]);
      return ranked.map((s) => toScreenerRow(s, idxSets));
    },
    // A back-date run is deterministic and expensive — cache it for the session.
    // The live branch is an 8 MB-class fetch: a 60 s staleTime plus refetch on
    // focus/mount meant tabbing back into the Screener re-pulled the whole
    // universe. The snapshot itself only refreshes every 15 min server-side,
    // so anything shorter than that is pure egress with no new data.
    staleTime: asOfDate ? Infinity : 15 * 60_000,
    gcTime: asOfDate ? 30 * 60_000 : 30 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: false,
    enabled,
  });

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

