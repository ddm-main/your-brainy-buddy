// Screener runner: reads the unified market_data table.
// All provider-specific fields normalized into this single table.
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
  instrument_type?: string | null;
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
        .from("market_data").select("symbol").eq("is_nifty500", true).eq("is_active", true)
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
      .from("market_data")
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
    queryKey: ["market", "screener-rows-v2", universe],
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

      return filtered.map((s): ScreenerRow => {
        const num = (v: any): number | null => (v == null || Number.isNaN(Number(v))) ? null : Number(v);
        return {
          ...(s as StockScore),
          sector:       s.sector ?? null,
          company_name: s.company_name ?? null,
          market_cap:   num(s.market_cap),
          is_nifty500:  Boolean(s.is_nifty500),
          industry:     s.industry ?? null,
          in_nifty50:   idxSets.NIFTY50.has(s.symbol),
          in_banknifty: idxSets.BANKNIFTY.has(s.symbol),
          in_finnifty:  idxSets.FINNIFTY.has(s.symbol),
          pe:                num(s.pe),
          pb:                num(s.pb),
          peg:               num(s.peg),
          eps:               num(s.eps),
          book_value:        num(s.book_value),
          dividend_yield:    num(s.dividend_yield),
          roe:               num(s.roe),
          roce:              num(s.roce),
          debt_equity:       num(s.debt_equity),
          current_ratio:     num(s.current_ratio),
          quick_ratio:       num(s.quick_ratio),
          sales:             num(s.sales),
          net_profit:        num(s.net_profit),
          sales_growth:      num(s.sales_growth),
          profit_growth:     num(s.profit_growth),
          eps_growth:        num(s.eps_growth),
          promoter_holding:  num(s.promoter_holding),
          dii_holding:       num(s.dii_holding ?? s.fii_holding),
          high_52w:          num(s.high_52w),
          low_52w:           num(s.low_52w),
          instrument_type:   s.instrument_type ?? "EQ",
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
