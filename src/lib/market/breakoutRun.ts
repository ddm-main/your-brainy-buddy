// Breakout tracker data layer — reads the durable episode + snapshot tables
// written by market-pipeline-aggregates. Mirrors screenerRun.ts conventions
// (react-query, explicit projection, num() coercion). The Breakout page joins
// these episodes with the live screener rows (useScreenerData) so it can reuse
// the shared filter catalog + live-tick overlay.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type BreakoutStatus = "active" | "extended" | "cooled" | "failed" | "closed";
export const OPEN_STATUSES: BreakoutStatus[] = ["active", "extended", "cooled"];

export interface BreakoutEpisode {
  symbol: string;
  exchange: string;
  first_detected_date: string;
  entry_close: number | null;
  trigger_price: number | null;
  detected_score: number | null;
  peak_close: number | null;
  peak_return_pct: number | null;
  current_close: number | null;
  current_return_pct: number | null;
  days_tracked: number;
  last_score: number | null;
  /** Percentile of the score inside that session's liquid universe. */
  rank_pct: number | null;
  /** Worst drawdown from entry seen intraday since detection (negative %). */
  mae_pct: number | null;
  peak_high: number | null;
  followthrough_score: number | null;
  /** null entries mark sessions the pipeline skipped — render as gaps. */
  score_trend: (number | null)[];
  status: BreakoutStatus;
  below_threshold_days: number;
  sector: string | null;
  market_cap: number | null;
  last_evaluated_date: string | null;
  closed_at: string | null;
}

export interface BreakoutSnapshot {
  symbol: string;
  exchange: string;
  trade_date: string;
  breakout_score: number | null;
  close: number | null;
}

/** Lightweight per-symbol lookup for the tracked set (name, LTP, stage inputs). */
export interface BreakoutSymbolMeta {
  symbol: string;
  exchange: string;
  company_name: string | null;
  ltp: number | null;
  rel_volume: number | null;
  atr14: number | null;
  ema20: number | null;
  close: number | null;
  bb_squeeze: boolean | null;
  near_resistance: boolean | null;
  resistance_level: number | null;
  score_components: { breakout?: Record<string, number> } | null;
  /** v4 bucket points — the breakdown that matches the v4 score on the row. */
  breakout_v4_buckets?: Record<string, number> | null;
  breakout_state?: string | null;
  /** Sessions since that state began — set for failed states too. */
  breakout_state_days?: number | null;
  breakout_level_cleared?: number | null;
  // Trigger geometry, read from market_stock_scores (not exposed by the
  // screener view) so the stage read can reach TRIGGERED / EXTENDED.
  rolling_high_20?: number | null;
  rolling_high_55?: number | null;
  pivot_level?: number | null;
  breakout_freshness_days?: number | null;
  base_tightness?: number | null;
  base_duration_days?: number | null;
  atr_contracting?: boolean | null;
}

export const metaKey = (exchange: string, symbol: string) => `${exchange}:${symbol}`;

const num = (v: any): number | null => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

function mapEpisode(r: any): BreakoutEpisode {
  return {
    symbol: r.symbol,
    exchange: r.exchange,
    first_detected_date: r.first_detected_date,
    entry_close: num(r.entry_close),
    trigger_price: num(r.trigger_price),
    detected_score: num(r.detected_score),
    peak_close: num(r.peak_close),
    peak_return_pct: num(r.peak_return_pct),
    current_close: num(r.current_close),
    current_return_pct: num(r.current_return_pct),
    days_tracked: Number(r.days_tracked ?? 1),
    last_score: num(r.last_score),
    rank_pct: num(r.rank_pct),
    mae_pct: num(r.mae_pct),
    peak_high: num(r.peak_high),
    followthrough_score: num(r.followthrough_score),
    score_trend: Array.isArray(r.score_trend)
      ? r.score_trend.map((v: any) => (v == null ? null : Number(v)))
      : [],
    status: (r.status ?? "active") as BreakoutStatus,
    below_threshold_days: Number(r.below_threshold_days ?? 0),
    sector: r.sector ?? null,
    market_cap: num(r.market_cap),
    last_evaluated_date: r.last_evaluated_date ?? null,
    closed_at: r.closed_at ?? null,
  };
}

/**
 * Breakout episodes. Defaults to open episodes only (active/extended/cooled) —
 * the tracker's hot list. Pass includeClosed to also pull failed/closed history.
 */
export function useBreakoutTracker(includeClosed = false, enabled = true) {
  return useQuery({
    queryKey: ["market", "breakout-tracker", includeClosed],
    queryFn: async (): Promise<BreakoutEpisode[]> => {
      const rows: any[] = [];
      for (let from = 0; ; from += 1000) {
        let q = (supabase as any)
          .from("market_breakout_tracker")
          .select("*")
          .order("first_detected_date", { ascending: false })
          .order("followthrough_score", { ascending: false, nullsFirst: false })
          .range(from, from + 999);
        if (!includeClosed) q = q.in("status", OPEN_STATUSES);
        const { data, error } = await q;
        if (error) throw error;
        const chunk = data ?? [];
        rows.push(...chunk);
        if (chunk.length < 1000) break;
      }
      return rows.map(mapEpisode);
    },
    staleTime: 60_000,
    enabled,
  });
}

/** Per-symbol daily score history for the trend sparkline / detail view. */
export function useBreakoutSymbolMeta(keys: { symbol: string; exchange: string }[]) {
  // Keyed by exchange:symbol, so the fetch must be exchange-aware too — a dual
  // listed name used to have one exchange's row overwrite the other's, and the
  // map lookup then returned null (no name, LTP, rel-vol or Setup on the row).
  const pairs = Array.from(new Set(keys.map((k) => `${k.exchange}:${k.symbol}`))).sort();
  const symbols = Array.from(new Set(keys.map((k) => k.symbol))).sort();
  const sig = pairs.join(",");
  return useQuery({
    queryKey: ["market", "breakout-symbol-meta", sig],
    queryFn: async (): Promise<Map<string, BreakoutSymbolMeta>> => {
      const out = new Map<string, BreakoutSymbolMeta>();
      if (symbols.length === 0) return out;
      const wanted = new Set(pairs);
      const cols = "symbol,exchange,company_name,close,rel_volume,atr14,ema20,bb_squeeze,near_resistance,resistance_level,score_components";
      const geoCols = "symbol,exchange,trade_date,rolling_high_20,rolling_high_55,breakout_freshness_days,base_tightness,base_duration_days,pivot_level,breakout_state,breakout_state_days,breakout_level_cleared,breakout_v4_components";

      // Both passes cover the same symbol chunks and neither depends on the
      // other's result, so they run together instead of as a serial waterfall
      // (previously 2 x ceil(n/300) sequential round-trips).
      const chunks: string[][] = [];
      for (let i = 0; i < symbols.length; i += 300) chunks.push(symbols.slice(i, i + 300));

      const [screenerRes, geoRes] = await Promise.all([
        Promise.all(chunks.map((chunk) => (supabase as any)
          .from("market_screener_rows").select(cols).in("symbol", chunk))),
        Promise.all(chunks.map((chunk) => (supabase as any)
          .from("market_stock_scores").select(geoCols).in("symbol", chunk)
          // Newest bar first, so the de-dupe below keeps the current session
          // when the table still holds prior trade_dates for a symbol.
          .order("trade_date", { ascending: false }))),
      ]);

      for (const { data, error } of screenerRes) {
        if (error) throw error;
        for (const r of data ?? []) {
          if (!wanted.has(`${r.exchange}:${r.symbol}`)) continue;
          out.set(metaKey(r.exchange, r.symbol), {
            symbol: r.symbol,
            exchange: r.exchange,
            company_name: r.company_name ?? null,
            ltp: num(r.close),
            rel_volume: num(r.rel_volume),
            atr14: num(r.atr14),
            ema20: num(r.ema20),
            close: num(r.close),
            bb_squeeze: r.bb_squeeze ?? null,
            near_resistance: r.near_resistance ?? null,
            resistance_level: num(r.resistance_level),
            score_components: r.score_components ?? null,
          });
        }
      }

      // The screener view doesn't expose the trigger geometry (rolling highs,
      // freshness, base tightness), so the stage read could never reach
      // TRIGGERED — it fell back to COILED/no-setup for every row. Pull those
      // columns straight from the scores table for the tracked names only.
      const seenGeo = new Set<string>();
      for (const { data } of geoRes) {
        for (const r of data ?? []) {
          const key = metaKey(r.exchange, r.symbol);
          if (!wanted.has(`${r.exchange}:${r.symbol}`)) continue;
          if (seenGeo.has(key)) continue; // first row = newest trade_date
          seenGeo.add(key);
          // A tracked name missing from the screener view (it filters on
          // liquidity//freshness) used to be dropped here entirely, so its row
          // rendered with no stage and no company name at all. Seed a minimal
          // record instead — geometry we have is better than a blank row.
          const base = out.get(key) ?? {
            symbol: r.symbol, exchange: r.exchange, company_name: null,
            ltp: null, rel_volume: null, atr14: null, ema20: null, close: null,
            bb_squeeze: null, near_resistance: null, resistance_level: null,
            score_components: null,
          } as BreakoutSymbolMeta;
          out.set(key, {
            ...base,
            rolling_high_20: num(r.rolling_high_20),
            rolling_high_55: num(r.rolling_high_55),
            pivot_level: num(r.pivot_level),
            breakout_freshness_days: num(r.breakout_freshness_days),
            base_tightness: num(r.base_tightness),
            base_duration_days: num(r.base_duration_days),
            breakout_state: r.breakout_state ?? null,
            breakout_state_days: num(r.breakout_state_days),
            breakout_level_cleared: num(r.breakout_level_cleared),
            breakout_v4_buckets: (r.breakout_v4_components as any)?.buckets ?? null,
          });
        }
      }
      return out;
    },

    staleTime: 60_000,
    enabled: symbols.length > 0,
  });
}

export function useBreakoutHistory(symbol: string | null, exchange = "NSE") {
  return useQuery({
    queryKey: ["market", "breakout-history", symbol, exchange],
    queryFn: async (): Promise<BreakoutSnapshot[]> => {
      if (!symbol) return [];
      const { data, error } = await (supabase as any)
        .from("market_breakout_snapshots")
        // market-pipeline-aggregates writes the v4 score into this column (the
        // tracked model), so the sparkline already matches the badge.
        .select("symbol,exchange,trade_date,breakout_score,close")
        .eq("symbol", symbol)
        .eq("exchange", exchange)
        .order("trade_date", { ascending: true })
        .limit(60);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        symbol: r.symbol,
        exchange: r.exchange,
        trade_date: r.trade_date,
        breakout_score: num(r.breakout_score),
        close: num(r.close),
      }));
    },
    staleTime: 60_000,
    enabled: !!symbol,
  });
}
