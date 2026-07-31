// React Query hooks for funds, orders, trades, and order-entry mutations.
// Kept separate from hooks.ts (which is already ~500 lines) so this cluster
// of live-trading concerns lives in one place.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { callMarketFn } from "./api";
import { liveInterval, marketOpen } from "./hooks";

export interface FundsRow {
  net_cash: number | null;
  available_margin: number | null;
  used_margin: number | null;
  collateral: number | null;
  payin_amount: number | null;
  // Extended breakdown (edge-function surfaces from payload.extended).
  cash_balance?: number | null;
  payout_amount?: number | null;
  span_margin?: number | null;
  exposure_margin?: number | null;
  realized_mtm?: number | null;
  unrealized_mtm?: number | null;
  synced_at: string;
}
export type FundsReasonCode = "not_connected" | "session_expired" | "rate_limited" | "upstream_down" | "unknown";
export interface FundsResponse {
  funds: FundsRow | null;
  source: string;
  reason?: string;
  reason_code?: FundsReasonCode;
  note?: string;
  not_connected?: boolean;
  stale_since?: string | null;
  retry_after?: number;
  retry_after_at?: string | null;
  /** @deprecated superseded by `reason` */
  error?: string;
}

function fundsRefetchInterval(data: FundsResponse | undefined): number | false {
  const retryAt = data?.retry_after_at ? new Date(data.retry_after_at).getTime() : 0;
  if (Number.isFinite(retryAt) && retryAt > Date.now()) {
    return Math.max(1_000, retryAt - Date.now() + 1_000);
  }
  return marketOpen() ? 60_000 : 5 * 60_000;
}


export interface BrokerOrder {
  order_id: string; symbol: string; exchange: string; side: "BUY" | "SELL";
  quantity: number; filled_qty: number; price: number; status: string;
  order_time: string; product: string;
}
export interface BrokerTrade {
  trade_id: string; order_id: string; symbol: string; exchange: string; side: "BUY" | "SELL";
  quantity: number; price: number; trade_time: string;
}

export interface PlaceOrderInput {
  symbol: string; exchange: "NSE" | "BSE"; side: "BUY" | "SELL";
  quantity: number; orderType: "MARKET" | "LIMIT" | "SL" | "SL-M";
  product: "MIS" | "CNC" | "NRML"; price?: number; triggerPrice?: number;
  validity?: "DAY" | "IOC"; disclosedQuantity?: number; amo?: boolean;
  skipMarginCheck?: boolean;
  // Stable across retries of the same order-entry intent (see OrderTicket) —
  // lets the server dedupe a network-retry/double-click instead of placing
  // the order twice. Omit only for callers that don't need dedupe.
  idempotencyKey?: string;
}

export function useFunds() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["market", "funds"],
    queryFn: async (): Promise<FundsResponse> => {
      // Read local snapshot first (RLS-scoped) — the edge function refreshes
      // it in-place, but a fresh sign-in with a warm cache shouldn't wait.
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) return { funds: null, source: "unauthenticated" };
      return callMarketFn<FundsResponse>("market-funds");
    },
    refetchInterval: (q) => fundsRefetchInterval(q.state.data as FundsResponse | undefined),
    staleTime: 60_000,
    retry: false,
    // Focus refetch bypassed the cooldown gate — a tab switch during an
    // active retry window would burn another Kotak call and reset the
    // cooldown. Only refetch on focus when there's no active cooldown.
    refetchOnWindowFocus: (q) => {
      const d = q.state.data as FundsResponse | undefined;
      const retryAt = d?.retry_after_at ? new Date(d.retry_after_at).getTime() : 0;
      return !(Number.isFinite(retryAt) && retryAt > Date.now());
    },
  });

  const refresh = useMutation({
    mutationFn: () => callMarketFn<FundsResponse>("market-funds"),
    onSuccess: (d) => qc.setQueryData(["market", "funds"], d),
  });
  return { ...query, refresh };
}

export function useBrokerOrders() {
  return useQuery({
    queryKey: ["market", "broker-orders"],
    queryFn: () => callMarketFn<{ orders: BrokerOrder[]; source: string }>("market-orders"),
    // Function form: `marketOpen()` evaluated at mount froze the cadence for
    // the whole session (open the page pre-open and it never refreshed again).
    refetchInterval: liveInterval(10_000, false, 30_000),
  });
}

export function useBrokerTrades() {
  return useQuery({
    queryKey: ["market", "broker-trades"],
    queryFn: () => callMarketFn<{ trades: BrokerTrade[]; source: string }>("market-trades"),
    refetchInterval: liveInterval(15_000, false, 30_000),
  });
}


export function useMarketOrderMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["market", "broker-orders"] });
    qc.invalidateQueries({ queryKey: ["market", "broker-trades"] });
    qc.invalidateQueries({ queryKey: ["market", "funds"] });
    qc.invalidateQueries({ queryKey: ["market", "positions"] });
    qc.invalidateQueries({ queryKey: ["market", "holdings"] });
    qc.invalidateQueries({ queryKey: ["market", "realized-daily"] });
  };
  const place = useMutation({
    mutationFn: async (input: PlaceOrderInput) => {
      const r = await callMarketFn<{ ok: boolean; order_id?: string; status?: string; error?: string; code?: string; session_expired?: boolean; retryable?: boolean; verification_required?: boolean; http_status?: number }>(
        "market-order-place",
        input as unknown as Record<string, unknown>,
      );
      // The ambiguous-broker-session case is returned as HTTP 200 with
      // ok:false so the platform runtime tracker doesn't flag it as an
      // Edge Function crash. Re-throw as MarketFunctionError so the ticket's
      // existing recovery branch handles it uniformly — carrying the REAL
      // status (200), not a fabricated 409 that no server ever returned.
      if (r && r.ok === false) {
        const { MarketFunctionError } = await import("@/lib/market/api");
        throw new MarketFunctionError(r.error || "Order status unknown", r.http_status ?? 200, r as unknown as Record<string, unknown>);
      }

      return r as { ok: true; order_id: string; status: string };
    },
    onSuccess: invalidate,
  });
  const modify = useMutation({
    mutationFn: (input: { order_id: string } & Partial<Omit<PlaceOrderInput, "symbol" | "exchange" | "side" | "product">>) =>
      callMarketFn<{ ok: boolean; order_id: string; status: string }>("market-order-modify", input),
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    mutationFn: (order_id: string) =>
      callMarketFn<{ ok: boolean; order_id: string; status: string }>("market-order-cancel", { order_id }),
    onSuccess: invalidate,
  });
  const convertPosition = useMutation({
    mutationFn: (input: { symbol: string; exchange: "NSE" | "BSE"; side: "BUY" | "SELL"; quantity: number; fromProduct: "MIS" | "CNC" | "NRML"; toProduct: "MIS" | "CNC" | "NRML" }) =>
      callMarketFn<{ ok: true }>("market-position-convert", input as unknown as Record<string, unknown>),
    onSuccess: invalidate,
  });
  return { place, modify, cancel, convertPosition };
}
