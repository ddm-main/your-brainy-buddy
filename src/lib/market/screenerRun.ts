// Screener runner: fetches market_stock_scores enriched with market_stocks metadata
// AND joined with market_fundamentals_global (PE, ROE, growth, etc.). Pages beyond
// the 1000-row PostgREST default so "All Stocks" universes are complete.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { UniverseId } from "./screenerCatalog";
import type { StockScore } from "./types";

export interface ScreenerRow extends StockScore {
  company_name: string | null;
  market_cap: number | null; // ₹ Cr
  is_nifty500: boolean;
  industry: string | null;
  in_nifty50: boolean;
  in_banknifty: boolean;
  in_finnifty: boolean;
  // fundamentals (from market_fundamentals_global)
  pe_ttm: number | null;
  pb: number | null;
  peg: number | null;
  eps_ttm: number | null;
  book_value: number | null;
  dividend_yield: number | null;
  roe: number | null;
  roce: number | null;
  debt_to_equity: number | null;
  current_ratio: number | null;
  quick_ratio: number | null;
  revenue_ttm_cr: number | null;
  profit_ttm_cr: number | null;
  revenue_growth_yoy: number | null;
  profit_growth_yoy: number | null;
  eps_growth_yoy: number | null;
  promoter_holding: number | null;
  dii_holding: number | null;
  high_52w: number | null;
  low_52w: number | null;
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
      const { data, error } = await supabase
        .from("market_stocks").select("symbol").eq("is_nifty500", true)
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

async function fetchAllScores(): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("market_stock_scores").select("*")
      .order("breakout_score", { ascending: false, nullsFirst: false })
      .range(from, from + 999);
    if (error) throw error;
    const chunk = data ?? [];
    rows.push(...chunk);
    if (chunk.length < 1000) break;
  }
  return rows;
}

async function fetchStocksMeta(symbols: string[]): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  for (let i = 0; i < symbols.length; i += 500) {
    const slice = symbols.slice(i, i + 500);
    const { data } = await supabase
      .from("market_stocks")
      .select("symbol, company_name, market_cap, is_nifty500, industry, sector")
      .in("symbol", slice);
    (data ?? []).forEach((s: any) => map.set(s.symbol, s));
  }
  return map;
}

async function fetchFundamentals(symbols: string[]): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  for (let i = 0; i < symbols.length; i += 500) {
    const slice = symbols.slice(i, i + 500);
    const { data } = await (supabase as any)
      .from("market_fundamentals_global")
      .select("*")
      .in("symbol", slice);
    (data ?? []).forEach((f: any) => map.set(f.symbol, f));
  }
  return map;
}

export function useScreenerData(universe: UniverseId) {
  return useQuery({
    queryKey: ["market", "screener-rows-v2", universe],
    queryFn: async (): Promise<ScreenerRow[]> => {
      const universeSet = await fetchUniverseSymbols(universe);
      const scores = await fetchAllScores();
      const filtered = universeSet ? scores.filter((r) => universeSet.has(r.symbol)) : scores;
      if (filtered.length === 0) return [];
      const symbols = filtered.map((r) => r.symbol);
      const [stockBy, fundBy] = await Promise.all([fetchStocksMeta(symbols), fetchFundamentals(symbols)]);

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

      return filtered.map((s): ScreenerRow => {
        const meta = stockBy.get(s.symbol) ?? {};
        const f = fundBy.get(s.symbol) ?? {};
        const num = (v: any): number | null => (v == null || Number.isNaN(Number(v))) ? null : Number(v);
        return {
          ...(s as StockScore),
          // sector: prefer fundamentals-global, then market_stocks, then score row
          sector: f.sector ?? meta.sector ?? s.sector ?? null,
          company_name: f.company_name ?? meta.company_name ?? null,
          market_cap:   num(f.market_cap_cr ?? meta.market_cap),
          is_nifty500:  Boolean(meta.is_nifty500),
          industry:     f.industry ?? meta.industry ?? null,
          in_nifty50:   idxSets.NIFTY50.has(s.symbol),
          in_banknifty: idxSets.BANKNIFTY.has(s.symbol),
          in_finnifty:  idxSets.FINNIFTY.has(s.symbol),
          pe_ttm:            num(f.pe_ttm),
          pb:                num(f.pb),
          peg:               num(f.peg),
          eps_ttm:           num(f.eps_ttm),
          book_value:        num(f.book_value),
          dividend_yield:    num(f.dividend_yield),
          roe:               num(f.roe),
          roce:              num(f.roce),
          debt_to_equity:    num(f.debt_to_equity),
          current_ratio:     num(f.current_ratio),
          quick_ratio:       num(f.quick_ratio),
          revenue_ttm_cr:    num(f.revenue_ttm_cr),
          profit_ttm_cr:     num(f.profit_ttm_cr),
          revenue_growth_yoy: num(f.revenue_growth_yoy),
          profit_growth_yoy:  num(f.profit_growth_yoy),
          eps_growth_yoy:     num(f.eps_growth_yoy),
          promoter_holding:  num(f.promoter_holding),
          dii_holding:       num(f.dii_holding),
          high_52w:          num(f.high_52w),
          low_52w:           num(f.low_52w),
        };
      });
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
