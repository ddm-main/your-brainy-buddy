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
...
          rel_strength_nifty: num(s.rel_strength_nifty),
          breakout_score:    s.breakout_score ?? null,
          prebreakout_score: s.prebreakout_score ?? null,
          score_components:  s.score_components ?? null,
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
