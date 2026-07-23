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
  rel_volume: number | null;
  vol_avg30: number | null;
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
  prebreakout_score: number | null;
  score_components: { breakout?: Record<string, number>; prebreakout?: Record<string, number> } | null;
  ret_5d: number | null;
  ret_21d: number | null;
  ret_ytd: number | null;
  fno_enabled: boolean | null;
  sme: boolean | null;
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
const SCREENER_COLUMNS = [
  "symbol","exchange","company_name","sector","sub_sector","industry","market_cap",
  "is_nifty500","instrument_type","trade_date","close","previous_close","change_pct","volume",
  "rel_volume","vol_avg30","ema20","ema50","ema100","ema200","rsi14","macd","macd_signal",
  "macd_hist","adx14","atr14","atr_pct","bb_upper","bb_lower","bb_width",
  "bb_squeeze","high_52w","low_52w","pct_from_52w_high","above_ema200",
  "higher_lows","near_resistance","resistance_level","support_level",
  "sector_strength","rel_strength_nifty","breakout_score","prebreakout_score",
  "score_components","pe_ttm","pb","peg","eps_ttm","book_value","dividend_yield",
  "roe","roce","debt_to_equity","current_ratio","quick_ratio","revenue_ttm_cr",
  "profit_ttm_cr","revenue_growth_yoy","profit_growth_yoy","eps_growth_yoy",
  "promoter_holding","fii_holding","dii_holding",
  "ret_5d","ret_21d","ret_ytd","fno_enabled","sme","data_provenance",
].join(",");


async function fetchScreenerRows(): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await (supabase as any)
      .from("market_screener_rows")
      .select(SCREENER_COLUMNS)
      .eq("is_active", true)
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

// Universe filtering is done client-side against the single "all rows" fetch —
// this avoids a second full paginated scan of market_screener_rows just to
// obtain the nifty500 symbol list (that flag is already on every row). For
// the index-membership universes (nifty50 / banknifty / finnifty) the
// filtering set still comes from market_index_members.
function applyUniverseFilter(
  rows: any[],
  universeSet: Set<string> | "nifty500" | "fno" | "sme" | null,
): any[] {
  if (universeSet === null) return rows;
  if (universeSet === "nifty500") return rows.filter((r) => Boolean(r.is_nifty500));
  if (universeSet === "fno")      return rows.filter((r) => Boolean(r.fno_enabled));
  if (universeSet === "sme")      return rows.filter((r) => Boolean(r.sme));
  return rows.filter((r) => universeSet.has(r.symbol));
}

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

export function useScreenerData(universe: UniverseId, enabled = true) {
  return useQuery({
    queryKey: ["market", "screener-rows-v3", universe],
    queryFn: async (): Promise<ScreenerRow[]> => {
      const [universeSet, allRows] = await Promise.all([
        resolveUniverseFilter(universe),
        fetchScreenerRows(),
      ]);
      const filtered = applyUniverseFilter(allRows, universeSet);
      if (filtered.length === 0) return [];
      const symbols = filtered.map((r) => r.symbol);

      // Batch index memberships
      const members: any[] = [];
      for (let i = 0; i < symbols.length; i += 500) {
        const slice = symbols.slice(i, i + 500);
        const { data } = await supabase
          .from("market_index_members")
          .select("symbol, index_key")
          .in("symbol", slice)
          .in("index_key", ["NIFTY50", "BANKNIFTY", "FINNIFTY"]);
        members.push(...(data ?? []));
      }
      const idxSets = { NIFTY50: new Set<string>(), BANKNIFTY: new Set<string>(), FINNIFTY: new Set<string>() };
      members.forEach((m: any) => {
        const k = m.index_key as keyof typeof idxSets;
        if (idxSets[k]) idxSets[k].add(m.symbol);
      });

      const num = (v: any): number | null => (v == null || Number.isNaN(Number(v))) ? null : Number(v);
      return filtered.map((s): ScreenerRow => ({
        symbol: s.symbol,
        exchange: s.exchange,
        trade_date: s.trade_date ?? null,
        sector:       s.sector ?? null,
        sub_sector:   s.sub_sector ?? s.industry ?? s.sector ?? null,
        company_name: s.company_name ?? null,
        market_cap:   num(s.market_cap),
        is_nifty500:  Boolean(s.is_nifty500),
        industry:     s.industry ?? null,
        data_provenance: s.data_provenance ?? null,
        in_nifty50:   idxSets.NIFTY50.has(s.symbol),
        in_banknifty: idxSets.BANKNIFTY.has(s.symbol),
        in_finnifty:  idxSets.FINNIFTY.has(s.symbol),
        // Preserve NULL so unknown-type rows are scoped as "all" only,
        // never silently pulled into equity-only coverage denominators.
        instrument_type:   s.instrument_type ?? null,

        // view uses `close`; client model uses `ltp`
        ltp:               num(s.close ?? s.ltp),
        previous_close:    num(s.previous_close),
        change_abs:        num(s.change_abs),
        change_pct:        num(s.change_pct),
        change_pct_raw:    (() => {
          const close = num(s.close ?? s.ltp);
          const prev = num(s.previous_close);
          if (close == null || prev == null || prev <= 0) return num(s.change_pct);
          return ((close - prev) / prev) * 100;
        })(),

        // view uses `pe_ttm`, `eps_ttm`, `debt_to_equity`, `*_growth_yoy`
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
        // Keep DII and FII strictly separate — silently substituting FII when
        // DII is null misrepresents the column. Callers wanting a combined
        // figure should sum explicitly (see `institutional_holding` below).
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

        // view uses `rsi14`, `adx14`, `atr14`, `ema20`..`ema200`
        volume:            num(s.volume),
        rel_volume:        num(s.rel_volume),
        vol_avg30:         num(s.vol_avg30),
        vol_gt_avg30:      (() => {
          const vol = num(s.volume);
          const avg = num(s.vol_avg30);
          if (vol == null || avg == null || avg <= 0) return null;
          return vol > avg;
        })(),

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
        prebreakout_score: s.prebreakout_score ?? null,
        score_components:  s.score_components ?? null,
      }));

    },
    staleTime: 60_000,
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

