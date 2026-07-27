// React Query hooks for the Market section. Query keys live under ["market", ...].
import { useEffect, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { callMarketFn } from "./api";
import { nseOpenNow } from "./liveTickStore";
import type {
  ApiSettings,
  BreadthDaily,
  CandlesResponse,
  IndexConstituent,
  IndexQuote,
  IndexWatchRow,
  Position,
  Quote,
  SavedScreener,
  ScreenerGroup,
  SectorStrength,
  StockScore,
  TopMoverRow,
} from "./types";

// NSE market hours (IST 09:15–15:30) — poll faster during them. See
// nseOpenNow() in liveTickStore.ts, the single shared implementation.
export function marketOpen(): boolean {
  return nseOpenNow();
}

// Brief window right after close where we keep slow-polling to catch the
// settled EOD tick, instead of freezing on whatever LTP won the race at 15:30.
function justClosedWindow(): boolean {
  const now = new Date();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const day = now.getUTCDay();
  return day >= 1 && day <= 5 && utcMin > 600 && utcMin <= 615;
}

// react-query re-evaluates `refetchInterval` after every fetch when it is a
// FUNCTION, but freezes it when it is a plain number computed at render time.
// Every market hook used the number form, so a tab mounted before 09:15 kept
// polling at the closed-market cadence (e.g. 120 s) for the whole session.
// This helper keeps the cadence honest without needing a re-render.
export function liveInterval(openMs: number, closedMs: number | false, justClosedMs?: number) {
  return () => (marketOpen() ? openMs : justClosedWindow() ? (justClosedMs ?? closedMs) : closedMs);
}

export function useMarketSettings() {
  return useQuery({
    queryKey: ["market", "settings"],
    queryFn: async (): Promise<ApiSettings[]> => {
      const { data, error } = await supabase.from("market_api_settings").select("*");
      if (error) throw error;
      return (data ?? []) as ApiSettings[];
    },
  });
}

// Status of the app-wide market-data feed (the designated system Kotak Neo
// connection). Market data is not account-bound: every signed-in user reads
// prices from this one feed, and only connects their own Kotak for account
// data (orders, holdings, positions, funds). Price banners must key off THIS,
// not off whether the current user personally connected a broker.
export interface SystemFeedStatus {
  configured: boolean;
  designated: boolean;
  status: string;
  healthy: boolean;
  last_error: string | null;
  last_sync_at: string | null;
  token_expires_at: string | null;
  id: string | null;
  ucc: string | null;
  is_owner: boolean;
  is_admin: boolean;
}

export function useSystemFeed() {
  return useQuery({
    queryKey: ["market", "system-feed"],
    queryFn: () => callMarketFn<SystemFeedStatus>("market-system-feed"),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

export function useDesignateSystemFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => callMarketFn<SystemFeedStatus>("market-system-feed", { action: "designate", id }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["market", "system-feed"] }); },
  });
}


export function useIndices() {
  return useQuery({
    queryKey: ["market", "indices"],
    queryFn: () =>
      callMarketFn<{ quotes: IndexQuote[]; breadth: BreadthDaily | null }>("market-indices"),
    refetchInterval: liveInterval(1_000, 120_000, 15_000),
    placeholderData: (prev: unknown) => prev as any,
    refetchIntervalInBackground: false,
  });
}

export function useTopMovers() {
  return useQuery({
    queryKey: ["market", "top-movers"],
    queryFn: async (): Promise<TopMoverRow[]> => {
      const { data, error } = await supabase
        .from("market_top_movers" as any).select("*").order("rn", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as TopMoverRow[];
    },
    staleTime: 60_000,
    refetchInterval: liveInterval(60_000, false),
    refetchIntervalInBackground: false,
  });
}

// Shared IST market status ticker. Recomputes every second when the market is
// open and every 30 s when closed, so the strip / dashboard header don't
// re-render 24/7 for a status that only flips at 09:15 / 15:30.
export function useMarketStatus() {
  const compute = () => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const day = get("weekday");
    const hh = Number(get("hour")); const mm = Number(get("minute")); const ss = Number(get("second"));
    const secs = hh * 3600 + mm * 60 + ss;
    const openSecs = 9 * 3600 + 15 * 60;
    const closeSecs = 15 * 3600 + 30 * 60;
    const istClock = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")} IST`;
    if (day === "Sat" || day === "Sun") return { open: false, label: "closed · weekend", istClock };
    if (secs < openSecs) {
      const d = openSecs - secs;
      const h = Math.floor(d / 3600); const m = Math.floor((d % 3600) / 60); const s = d % 60;
      return { open: false, label: `opens in ${h ? h + "h " : ""}${m}m ${String(s).padStart(2, "0")}s`, istClock };
    }
    if (secs > closeSecs) return { open: false, label: "closed", istClock };
    const d = closeSecs - secs;
    const h = Math.floor(d / 3600); const m = Math.floor((d % 3600) / 60); const s = d % 60;
    return { open: true, label: `open · closes in ${h ? h + "h " : ""}${m}m ${String(s).padStart(2, "0")}s`, istClock };
  };
  const [status, setStatus] = useState(compute);
  useEffect(() => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const tick = () => setStatus(compute());
    const interval = status.open ? 1_000 : 30_000;
    const t = setInterval(tick, interval);
    return () => clearInterval(t);
  }, [status.open]);
  return status;
}

export function useQuotes(keys: string[], opts?: { intervalMs?: number }) {
  // Callers can override the market-hours REST poll interval — e.g. Top
  // Breakouts symbols that aren't in the Kotak WS relay's subscription set
  // need a faster REST poll (~3s) to feel "live" instead of updating once
  // a minute. Off-hours we keep the just-closed short window then stop.
  const openInterval = opts?.intervalMs ?? 1_000;
  return useQuery({
    queryKey: ["market", "quotes", [...keys].sort().join(",")],
    queryFn: () => callMarketFn<{ quotes: Quote[]; source: string; provider?: string }>("market-quotes", { symbols: keys }),
    enabled: keys.length > 0,
    refetchInterval: liveInterval(openInterval, false, 15_000),
    // During market hours the poll itself keeps the data fresh — a short
    // stale window prevents duplicate parallel fetches when many components
    // subscribe. Off-hours the value can't move, so cache it and stop firing
    // refetches on remount/focus.
    // `open` was captured at render, so a component mounted before 09:15 kept
    // an Infinity staleTime (and focus/reconnect refetches disabled) for the
    // whole session. Short stale window always; off-hours the interval is
    // already false so nothing polls anyway.
    staleTime: Math.max(500, openInterval - 200),
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    // Keep the last successful batch visible while a new fetch is in flight
    // so subscribing new symbols (paging/filtering) doesn't blank the table.
    placeholderData: (prev: unknown) => prev as any,
  });
}

const QUOTE_BATCH_SIZE = 200;

// Chunked variant for large candidate sets (e.g. screener live-filter overlay
// against hundreds/thousands of symbols) — unlike useQuotes above, this does
// NOT poll every second; a full-universe 1s poll would hammer the Kotak/Yahoo
// rate limits this app is already tight against (see the "quotes degraded"
// banner elsewhere). Each chunk is its own react-query entry via useQueries
// so chunks can fail/retry independently without invalidating the rest.
export function useQuotesBatched(keys: string[], chunkSize = QUOTE_BATCH_SIZE) {
  const sortedKeys = [...keys].sort();
  const chunks: string[][] = [];
  for (let i = 0; i < sortedKeys.length; i += chunkSize) chunks.push(sortedKeys.slice(i, i + chunkSize));

  const results = useQueries({
    queries: chunks.map((chunk) => ({
      queryKey: ["market", "quotes-batch", chunk.join(",")],
      queryFn: () => callMarketFn<{ quotes: Quote[]; source: string }>("market-quotes", { symbols: chunk }),
      enabled: chunk.length > 0,
      staleTime: 20_000,
      refetchInterval: false as const,
    })),
  });

  const quotes: Quote[] = [];
  let anyFailed = false;
  let anyFetching = false;
  for (const r of results) {
    if (r.data?.quotes) quotes.push(...r.data.quotes);
    if (r.isError) anyFailed = true;
    if (r.isFetching) anyFetching = true;
  }
  return { quotes, isFetching: anyFetching, anyFailed, chunkCount: chunks.length };
}

export function usePositions() {
  return useQuery({
    queryKey: ["market", "positions"],
    queryFn: async (): Promise<Position[]> => {
      const { data, error } = await supabase
        .from("market_positions").select("*").order("opened_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Position[];
    },
    refetchInterval: liveInterval(10_000, 5 * 60_000, 30_000),
    refetchIntervalInBackground: false,
  });
}

// Shared holdings hook — pages used to roll their own supabase.from().select()
// which meant a mutation on Holdings wouldn't reflect in PortfolioOverview
// until remount. Central hook + query-key means invalidations propagate.
export interface HoldingRow {
  id: string;
  symbol: string;
  exchange: string;
  quantity: number;
  avg_price: number;
  buy_date: string | null;
  investment_type: string | null;
  notes: string | null;
  source: string;
  settled_qty: number | null;
  t1_qty: number | null;
  pledged_qty: number | null;
}

export function usePortfolioLastSync() {
  return useQuery({
    queryKey: ["market", "portfolio-last-sync"],
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase
        .from("market_api_settings")
        .select("last_sync_at")
        .eq("active_provider", "kotak_neo")
        .maybeSingle();
      if (error) throw error;
      return (data as any)?.last_sync_at ?? null;
    },
    staleTime: 30_000,
  });
}
export function useHoldings() {
  return useQuery({
    queryKey: ["market", "holdings"],
    queryFn: async (): Promise<HoldingRow[]> => {
      const { data, error } = await supabase
        .from("market_holdings").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as HoldingRow[];
    },
    refetchInterval: liveInterval(30_000, 5 * 60_000),
    refetchIntervalInBackground: false,
  });
}

// Today's intraday realized P&L (per-symbol, from market_realized_pnl_daily).
// Kite/Groww's "Today's P&L" = open-positions day + realized-today; without
// this, closing a scalp during the session would make today's P&L drop back
// to whatever the open book shows.
export interface TodayRealizedRow {
  symbol: string; exchange: string; quantity: number; realized: number;
}
export function useTodayRealized() {
  return useQuery({
    queryKey: ["market", "realized-daily"],
    queryFn: async (): Promise<TodayRealizedRow[]> => {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
      const { data, error } = await supabase
        .from("market_realized_pnl_daily")
        .select("symbol,exchange,quantity,realized")
        .eq("day", day);
      if (error) throw error;
      return (data ?? []) as TodayRealizedRow[];
    },
    refetchInterval: liveInterval(30_000, false, 60_000),
    refetchIntervalInBackground: false,
    staleTime: 20_000,
  });
}

export function useSyncPositions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callMarketFn("market-sync-positions"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["market", "positions"] });
      qc.invalidateQueries({ queryKey: ["market", "funds"] });
      qc.invalidateQueries({ queryKey: ["market", "realized-daily"] });
      qc.invalidateQueries({ queryKey: ["market", "holdings"] });
      qc.invalidateQueries({ queryKey: ["market", "portfolio-last-sync"] });
    },
  });
}

export function useSyncHoldings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callMarketFn<{ ok: boolean; inserted?: number; updated?: number; removed?: number }>("market-sync-holdings"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["market", "holdings"] });
      qc.invalidateQueries({ queryKey: ["market", "funds"] });
      qc.invalidateQueries({ queryKey: ["market", "settings"] });
      qc.invalidateQueries({ queryKey: ["market", "portfolio-last-sync"] });
    },
  });
}

// PGRST filter-string escaping (commas/parens/backslash are structural in .or())
function escapePgrst(v: string): string {
  return v.replace(/[,()\\]/g, "\\$&");
}

const NUMERIC_OPS: Record<string, string> = { gt: "gt", gte: "gte", lt: "lt", lte: "lte", eq: "eq" };

function conditionToPgrst(c: { column: string; op: string; value?: number | string }): string | null {
  const col = c.column.replace(/[^a-z0-9_]/g, "");
  if (c.op === "is_true") return `${col}.is.true`;
  if (c.op === "is_false") return `${col}.is.false`;
  const op = NUMERIC_OPS[c.op];
  if (!op || c.value === undefined || c.value === "") return null;
  return `${col}.${op}.${escapePgrst(String(c.value))}`;
}

export function useStockScores(opts: {
  groups?: ScreenerGroup[];
  orderBy?: string;
  desc?: boolean;
  limit?: number;
  symbol?: string;
} = {}) {
  const { groups, orderBy = "breakout_score", desc = true, limit = 200, symbol } = opts;
  return useQuery({
    queryKey: ["market", "scores", JSON.stringify(groups ?? null), orderBy, desc, limit, symbol ?? null],
    queryFn: async (): Promise<StockScore[]> => {
      let q = supabase.from("market_stock_scores").select("*");
      if (symbol) q = q.eq("symbol", symbol);
      if (groups && groups.length > 0) {
        const orParts = groups
          .map((g) => {
            const parts = g.conditions.map(conditionToPgrst).filter((p): p is string => p != null);
            if (parts.length === 0) return null;
            return parts.length === 1 ? parts[0] : `and(${parts.join(",")})`;
          })
          .filter((p): p is string => p != null);
        if (orParts.length === 1 && !orParts[0].startsWith("and(")) {
          const [col, op, ...rest] = orParts[0].split(".");
          q = q.filter(col, op, rest.join("."));
        } else if (orParts.length > 0) {
          q = q.or(orParts.join(","));
        }
      }
      q = q.order(orderBy, { ascending: !desc, nullsFirst: false }).limit(limit);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as StockScore[];
    },
  });
}

export function useBreadth() {
  return useQuery({
    queryKey: ["market", "breadth"],
    queryFn: async (): Promise<BreadthDaily | null> => {
      // market_breadth_latest points at whatever the breadth job wrote last,
      // which on a Sat/Sun/holiday run is a degenerate row (zero A/D) that
      // silently overwrote Friday's real session. Read the most recent
      // trading session directly from market_breadth_daily instead, filtering
      // out rows with no advances or declines.
      const { data, error } = await supabase
        .from("market_breadth_daily" as any)
        .select("*")
        .or("advances.gt.0,declines.gt.0")
        .order("trade_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as BreadthDaily | null;
    },
    staleTime: 60_000,
    refetchInterval: liveInterval(60_000, false),
    refetchIntervalInBackground: false,
  });
}


export interface FiiDiiRow {
  activity_date: string;
  segment: string;
  fii_net: number | null;
  dii_net: number | null;
  net_buy_inr_cr: number | null;
  source: string | null;
}

// Recent FII/DII activity (defaults to CASH segment, last 10 sessions).
// Segment is matched case-insensitively — the sync writer historically wrote
// lowercase "cash" while every reader asked for "CASH", so exact matching
// silently returned zero rows.
export function useFiiDiiHistory(limit = 10, segment = "CASH") {
  return useQuery({
    queryKey: ["market", "fii-dii-history", segment, limit],
    queryFn: async (): Promise<FiiDiiRow[]> => {
      const { data, error } = await supabase
        .from("fii_dii_activity")
        .select("activity_date,segment,fii_net,dii_net,net_buy_inr_cr,source")
        .ilike("segment", segment)
        .order("activity_date", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as FiiDiiRow[];
    },
    staleTime: 5 * 60_000,
  });
}

// Latest FII/DII net cash flows (₹ crore) for the market strip.
// `market_breadth_daily.fii_net_cr` / `dii_net_cr` are never written by any
// job, so the strip used to read permanently-NULL columns. fii_dii_activity
// is the table the sync actually populates — read that instead.
export function useFiiDiiLatest(segment = "CASH") {
  return useQuery({
    queryKey: ["market", "fii-dii-latest", segment],
    queryFn: async (): Promise<FiiDiiRow | null> => {
      const { data, error } = await supabase
        .from("fii_dii_activity")
        .select("activity_date,segment,fii_net,dii_net,net_buy_inr_cr,source")
        .ilike("segment", segment)
        .order("activity_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as FiiDiiRow | null;
    },
    staleTime: 5 * 60_000,
    refetchInterval: liveInterval(15 * 60_000, false),
    refetchIntervalInBackground: false,
  });
}

export function useSectorStrength() {
  return useQuery({
    queryKey: ["market", "sectors"],
    queryFn: async (): Promise<SectorStrength[]> => {
      const { data: latest } = await supabase
        .from("market_sector_strength_daily").select("trade_date")
        .order("trade_date", { ascending: false }).limit(1).maybeSingle();
      if (!latest) return [];
      const { data, error } = await supabase
        .from("market_sector_strength_daily").select("*")
        .eq("trade_date", latest.trade_date)
        .order("strength_rank", { ascending: true });
      if (error) throw error;
      return (data ?? []) as SectorStrength[];
    },
  });
}

export function useCandles(symbol: string | undefined, timeframe: string, exchange = "NSE") {
  // Intraday timeframes need to pick up new completed bars while the market
  // is open. Live LTP nudges the last bar via the tick store, but the full
  // series stays 5 min stale without a refetch loop.
  const intraday = /^(?:\d+m|\d+h)$/.test(timeframe);
  return useQuery({
    queryKey: ["market", "candles", symbol ?? "", timeframe, exchange],
    queryFn: () => callMarketFn<CandlesResponse>("market-candles", { symbol, timeframe, exchange }),
    enabled: !!symbol,
    staleTime: intraday ? 60_000 : 5 * 60_000,
    refetchInterval: intraday ? liveInterval(60_000, false) : (false as const),
    refetchIntervalInBackground: false,
  });
}

export interface DepthRow { price: number; qty: number; orders: number }
export interface DepthResponse { bids: DepthRow[]; asks: DepthRow[]; ltp: number | null; source: string }

export function useDepth(symbol: string | undefined, exchange = "NSE") {
  return useQuery({
    queryKey: ["market", "depth", symbol ?? "", exchange],
    queryFn: () => callMarketFn<DepthResponse>("market-depth", { symbol, exchange }),
    enabled: !!symbol,
    refetchInterval: liveInterval(1_000, false),
    retry: false,
  });
}

export function useSavedScreeners() {
  return useQuery({
    queryKey: ["market", "screeners"],
    queryFn: async (): Promise<SavedScreener[]> => {
      const { data, error } = await supabase
        .from("market_saved_screeners").select("*").order("name");
      if (error) throw error;
      return (data ?? []) as unknown as SavedScreener[];
    },
  });
}

export function useScreenerMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["market", "screeners"] });
  const save = useMutation({
    mutationFn: async (s: { id?: string; name: string; filters: ScreenerGroup[] }) => {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) throw new Error("Not signed in");
      const filtersJson = s.filters as unknown as import("@/integrations/supabase/types").Json;
      if (s.id) {
        const { error } = await supabase.from("market_saved_screeners")
          .update({ name: s.name, filters: filtersJson }).eq("id", s.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("market_saved_screeners")
          .insert({ user_id: userId, name: s.name, filters: filtersJson });
        if (error) throw error;
      }
    },
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("market_saved_screeners").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
  return { save, remove };
}

// Per-user favorite filter IDs for the Screener's Add Filter picker.
export function useFavoriteFilters() {
  return useQuery({
    queryKey: ["market", "screener-favorites"],
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await (supabase as any)
        .from("market_screener_favorites")
        .select("filter_id, sort_order, created_at")
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []).map((r: any) => r.filter_id as string);
    },
  });
}

export function useFavoriteFilterMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["market", "screener-favorites"] });
  const toggle = useMutation({
    mutationFn: async ({ filterId, isFav }: { filterId: string; isFav: boolean }) => {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) throw new Error("Not signed in");
      if (isFav) {
        const { error } = await (supabase as any)
          .from("market_screener_favorites")
          .delete()
          .eq("user_id", userId)
          .eq("filter_id", filterId);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any)
          .from("market_screener_favorites")
          .insert({ user_id: userId, filter_id: filterId, sort_order: Math.floor(Date.now() / 1000) });
        if (error && (error as any).code !== "23505") throw error;
      }
    },
    onSuccess: invalidate,
  });
  return { toggle };
}

export function useFundamentals(symbol: string | undefined, exchange = "NSE") {
  return useQuery({
    queryKey: ["market", "fundamentals", symbol ?? "", exchange],
    queryFn: () => callMarketFn<{ fundamentals: any; cached: boolean; fetched_at: string }>(
      "market-fundamentals", { symbol, exchange },
    ),
    enabled: !!symbol,
    staleTime: 6 * 3600_000,
  });
}

export interface StockInsight {
  verdict: "buy" | "hold" | "wait" | "avoid";
  confidence: number;
  entry: number | null;
  stop_loss: number | null;
  targets: number[];
  holding_period_days: number | null;
  rationale: string;
  risks: string[];
}
export function useStockInsight(symbol: string | undefined, exchange = "NSE") {
  return useQuery({
    queryKey: ["market", "insight", symbol ?? "", exchange],
    queryFn: () => callMarketFn<{ payload: StockInsight; cached: boolean; computed_at: string }>(
      "market-stock-insight", { symbol, exchange },
    ),
    enabled: !!symbol,
    staleTime: 6 * 3600_000,
    retry: 1,
  });
}
export function useRefreshStockInsight() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ symbol, exchange = "NSE" }: { symbol: string; exchange?: string }) =>
      callMarketFn<{ payload: StockInsight; cached: boolean; computed_at: string }>(
        "market-stock-insight", { symbol, exchange, force: true },
      ),
    onSuccess: (_r, v) => qc.invalidateQueries({ queryKey: ["market", "insight", v.symbol, v.exchange ?? "NSE"] }),
  });
}

export function useOptionChain(symbol: string | undefined, expiry?: string) {
  return useQuery({
    queryKey: ["market", "optionchain", symbol ?? "", expiry ?? ""],
    queryFn: () => callMarketFn<{
      symbol: string; expiry: string; expiries: string[]; underlying: number;
      pcr: number | null; total_call_oi: number; total_put_oi: number;
      rows: Array<{ strike: number; call: any; put: any }>;
      cached?: boolean; captured_at?: string; warning?: string;
    }>("market-option-chain", { symbol, expiry }),
    enabled: !!symbol,
    refetchInterval: liveInterval(60_000, false),
    staleTime: 30_000,
  });
}


// ---- Indices watchlist (user-configurable list on the dashboard) ----

export function useIndexWatch() {
  return useQuery({
    queryKey: ["market", "indexwatch"],
    queryFn: async (): Promise<IndexWatchRow[]> => {
      const { data, error } = await supabase
        .from("market_index_watch" as any).select("*").order("sort_order");
      if (error) throw error;
      return (data ?? []) as unknown as IndexWatchRow[];
    },
  });
}

export function useIndexWatchMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["market", "indexwatch"] });
    qc.invalidateQueries({ queryKey: ["market", "indices"] });
  };
  const add = useMutation({
    mutationFn: async (row: Omit<IndexWatchRow, "id" | "user_id" | "sort_order" | "created_at" | "updated_at">) => {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) throw new Error("Not signed in");
      const { error } = await supabase.from("market_index_watch" as any).insert({ ...row, user_id: userId } as any);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("market_index_watch" as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
  const reorder = useMutation({
    mutationFn: async (rows: { id: string; sort_order: number }[]) => {
      for (const r of rows) {
        const { error } = await supabase.from("market_index_watch" as any)
          .update({ sort_order: r.sort_order } as any).eq("id", r.id);
        if (error) throw error;
      }
    },
    onSuccess: invalidate,
  });
  return { add, remove, reorder };
}

export function useIndexConstituents(slug: string | null | undefined) {
  return useQuery({
    queryKey: ["market", "constituents", slug ?? ""],
    queryFn: () => callMarketFn<{ members: IndexConstituent[]; count: number; reason?: string }>(
      "market-index-constituents", { slug },
    ),
    enabled: !!slug,
    staleTime: 10 * 60_000,
  });
}

export interface NewsRow { id: string; headline: string; url: string | null; source: string | null; published_at: string | null }
export interface CorporateActionRow {
  id: string; action_type: string; ex_date: string | null; record_date: string | null;
  details: { subject?: string } | null;
}

export function useMarketNews(symbol: string | undefined, exchange = "NSE") {
  return useQuery({
    queryKey: ["market", "news", symbol ?? "", exchange],
    queryFn: async (): Promise<NewsRow[]> => {
      const { data, error } = await supabase.from("market_news" as any)
        .select("id,headline,url,source,published_at")
        .eq("symbol", symbol).eq("exchange", exchange)
        .order("published_at", { ascending: false }).limit(10);
      if (error) throw error;
      return (data ?? []) as unknown as NewsRow[];
    },
    enabled: !!symbol,
  });
}

export function useCorporateActions(symbol: string | undefined, exchange = "NSE") {
  return useQuery({
    queryKey: ["market", "corporate-actions", symbol ?? "", exchange],
    queryFn: async (): Promise<CorporateActionRow[]> => {
      const { data, error } = await supabase.from("market_corporate_actions" as any)
        .select("id,action_type,ex_date,record_date,details")
        .eq("symbol", symbol).eq("exchange", exchange)
        .order("ex_date", { ascending: false }).limit(10);
      if (error) throw error;
      return (data ?? []) as unknown as CorporateActionRow[];
    },
    enabled: !!symbol,
  });
}

export interface PortfolioSnapshotRow {
  snapshot_date: string;
  total_value: number | null;
  total_invested: number | null;
  total_pnl: number | null;
  unresolved_count: number;
}

export function usePortfolioSnapshots(days = 180) {
  return useQuery({
    queryKey: ["market", "portfolio-snapshots", days],
    queryFn: async (): Promise<PortfolioSnapshotRow[]> => {
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      const { data, error } = await supabase.from("market_portfolio_snapshots" as any)
        .select("snapshot_date,total_value,total_invested,total_pnl,unresolved_count")
        .gte("snapshot_date", since)
        .order("snapshot_date", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as PortfolioSnapshotRow[];
    },
  });
}

export function useSyncNewsAndActions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ symbol, exchange }: { symbol: string; exchange: string }) => {
      const body = { symbols: [{ symbol, exchange }] };
      await Promise.all([
        callMarketFn("market-news-sync", body),
        exchange === "NSE" ? callMarketFn("market-corporate-actions-sync", body) : Promise.resolve(),
      ]);
    },
    onSuccess: (_d, { symbol, exchange }) => {
      qc.invalidateQueries({ queryKey: ["market", "news", symbol, exchange] });
      qc.invalidateQueries({ queryKey: ["market", "corporate-actions", symbol, exchange] });
    },
  });
}
