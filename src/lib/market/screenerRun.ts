// Screener runner: reads the unified market_data table.
// All provider-specific fields normalized into this single table.
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
  industry: string | null;
  instrument_type?: string | null;
  market_cap: number | null; // ₹ Cr
  is_nifty500: boolean;
  in_nifty50: boolean;
  in_banknifty: boolean;
  in_finnifty: boolean;

  ltp: number | null;
  previous_close: number | null;
  change_abs: number | null;
  change_pct: number | null;

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
  high_52w: number | null;
  low_52w: number | null;

  // technicals (unified schema)
  volume: number | null;
  rel_volume: number | null;
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
}


const universeIndexKey: Record<UniverseId, string | null> = {
  all:       null,
  nifty500:  null,
  nifty50:   "NIFTY50",
  banknifty: "BANKNIFTY",
  finnifty:  "FINNIFTY",
};

async function fetchUniverseSymbols(universe: UniverseId): Promise<Set<string> | null> {
  if (universe === "all") return null;
  if (universe === "nifty500") {
    const rows: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await (supabase as any)
        .from("market_screener_rows").select("symbol").eq("is_nifty500", true).eq("is_active", true)
        .range(from, from + 999);
      if (error) throw error;
      const chunk = data ?? [];
      rows.push(...chunk);
      if (chunk.length < 1000) break;
    }
    return new Set(rows.map((r) => r.symbol));
  }
  const key = universeIndexKey[universe];
  if (!key) return null;
  const { data, error } = await supabase
    .from("market_index_members").select("symbol").eq("index_key", key);
  if (error) throw error;
  return new Set((data ?? []).map((r: any) => r.symbol));
}

async function fetchScreenerRows(): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await (supabase as any)
      .from("market_screener_rows")
      .select("*")
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

export function useScreenerData(universe: UniverseId) {
  return useQuery({
    queryKey: ["market", "screener-rows-v3", universe],
    queryFn: async (): Promise<ScreenerRow[]> => {
      const universeSet = await fetchUniverseSymbols(universe);
      const allRows = await fetchScreenerRows();
      const filtered = universeSet ? allRows.filter((r) => universeSet.has(r.symbol)) : allRows;
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
        company_name: s.company_name ?? null,
        market_cap:   num(s.market_cap),
        is_nifty500:  Boolean(s.is_nifty500),
        industry:     s.industry ?? null,
        in_nifty50:   idxSets.NIFTY50.has(s.symbol),
        in_banknifty: idxSets.BANKNIFTY.has(s.symbol),
        in_finnifty:  idxSets.FINNIFTY.has(s.symbol),
        instrument_type:   s.instrument_type ?? "EQ",

        // view uses `close`; client model uses `ltp`
        ltp:               num(s.close ?? s.ltp),
        previous_close:    num(s.previous_close),
        change_abs:        num(s.change_abs),
        change_pct:        num(s.change_pct),

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
        dii_holding:       num(s.dii_holding ?? s.fii_holding),
        high_52w:          num(s.high_52w),
        low_52w:           num(s.low_52w),

        // view uses `rsi14`, `adx14`, `atr14`, `ema20`..`ema200`
        volume:            num(s.volume),
        rel_volume:        num(s.rel_volume),
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
  });
}

/** Distinct sector list from the loaded rows — dynamic to whatever's actually present. */
export function useScreenerSectors(rows: ScreenerRow[]): string[] {
  const set = new Set<string>();
  rows.forEach((r) => r.sector && set.add(r.sector));
  return Array.from(set).sort();
}

/** Distinct industry list. */
export function useScreenerIndustries(rows: ScreenerRow[]): string[] {
  const set = new Set<string>();
  rows.forEach((r) => r.industry && set.add(r.industry));
  return Array.from(set).sort();
}
