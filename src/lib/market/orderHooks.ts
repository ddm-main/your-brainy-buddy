// React Query hooks for funds, orders, trades, and order-entry mutations.
// Kept separate from hooks.ts (which is already ~500 lines) so this cluster
// of live-trading concerns lives in one place.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { callMarketFn } from "./api";
import { marketOpen } from "./hooks";

export interface FundsRow {
  net_cash: number | null;
  available_margin: number | null;
  used_margin: number | null;
  collateral: number | null;
  payin_amount: number | null;
  synced_at: string;
}
export interface FundsResponse { funds: FundsRow | null; source: string; error?: string; note?: string }

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
    refetchInterval: marketOpen() ? 60_000 : 5 * 60_000,
    staleTime: 30_000,
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
    refetchInterval: marketOpen() ? 10_000 : false,
  });
}

export function useBrokerTrades() {
  return useQuery({
    queryKey: ["market", "broker-trades"],
    queryFn: () => callMarketFn<{ trades: BrokerTrade[]; source: string }>("market-trades"),
    refetchInterval: marketOpen() ? 15_000 : false,
  });
}

export function useMarketOrderMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["market", "broker-orders"] });
    qc.invalidateQueries({ queryKey: ["market", "broker-trades"] });
    qc.invalidateQueries({ queryKey: ["market", "funds"] });
  };
  const place = useMutation({
    mutationFn: (input: PlaceOrderInput) =>
      callMarketFn<{ ok: boolean; order_id: string; status: string }>("market-order-place", input as unknown as Record<string, unknown>),
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
  return { place, modify, cancel };
}
