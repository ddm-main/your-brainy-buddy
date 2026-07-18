// React Query hooks for the Market section. Query keys live under ["market", ...].
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { callMarketFn } from "./api";
import type {
  ApiSettings,
  BreadthDaily,
  CandlesResponse,
  Holding,
  IndexConstituent,
  IndexQuote,
  IndexWatchRow,
  Position,
  Quote,
  SavedScreener,
  ScreenerGroup,
  SectorStrength,
  StockScore,
} from "./types";

// NSE market hours (IST 09:15–15:30) ≈ UTC 03:45–10:00 — poll faster during them.
function marketOpen(): boolean {
  const now = new Date();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const day = now.getUTCDay();
  return day >= 1 && day <= 5 && utcMin >= 225 && utcMin <= 600;
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

export function useIndices() {
  return useQuery({
    queryKey: ["market", "indices"],
    queryFn: () =>
      callMarketFn<{ quotes: IndexQuote[]; breadth: BreadthDaily | null }>("market-indices"),
    refetchInterval: marketOpen() ? 15_000 : 120_000,
  });
}

export function useQuotes(keys: string[]) {
  return useQuery({
    queryKey: ["market", "quotes", [...keys].sort().join(",")],
    queryFn: () => callMarketFn<{ quotes: Quote[]; source: string }>("market-quotes", { symbols: keys }),
    enabled: keys.length > 0,
    refetchInterval: marketOpen() ? 15_000 : false,
  });
}

export function useHoldings() {
  return useQuery({
    queryKey: ["market", "holdings"],
    queryFn: async (): Promise<Holding[]> => {
      const { data, error } = await supabase
        .from("market_holdings").select("*").order("symbol");
      if (error) throw error;
      return (data ?? []) as Holding[];
    },
  });
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
  });
}

export function useSyncHoldings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callMarketFn("market-sync-holdings"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["market", "holdings"] }),
  });
}

export function useSyncPositions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callMarketFn("market-sync-positions"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["market", "positions"] }),
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
      const { data, error } = await supabase
        .from("market_breadth_daily").select("*")
        .order("trade_date", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data as BreadthDaily | null;
    },
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

export function useCandles(symbol: string | undefined, timeframe: string) {
  return useQuery({
    queryKey: ["market", "candles", symbol ?? "", timeframe],
    queryFn: () => callMarketFn<CandlesResponse>("market-candles", { symbol, timeframe }),
    enabled: !!symbol,
    staleTime: 5 * 60_000,
  });
}

export interface DepthRow { price: number; qty: number; orders: number }
export interface DepthResponse { bids: DepthRow[]; asks: DepthRow[]; ltp: number | null; source: string }

export function useDepth(symbol: string | undefined) {
  return useQuery({
    queryKey: ["market", "depth", symbol ?? ""],
    queryFn: () => callMarketFn<DepthResponse>("market-depth", { symbol }),
    enabled: !!symbol,
    refetchInterval: 15_000,
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
    }>("market-option-chain", { symbol, expiry }),
    enabled: !!symbol,
    refetchInterval: marketOpen() ? 60_000 : false,
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
