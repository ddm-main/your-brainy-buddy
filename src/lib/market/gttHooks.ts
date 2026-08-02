// GTT (Good-Till-Triggered) order hooks. Same shape as autotradeHooks.ts —
// CRUD through supabase-js (RLS-scoped), place/cancel via edge functions.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { callMarketFn } from "./api";
import { liveInterval } from "./hooks";

export interface GttOrder {
  id: string;
  symbol: string;
  exchange: "NSE" | "BSE";
  side: "BUY" | "SELL";
  trigger_type: "single" | "OCO";
  trigger_price: number;
  trigger_price_upper: number | null;
  order_type: "MARKET" | "LIMIT";
  price: number | null;
  quantity: number;
  product: "MIS" | "CNC" | "NRML";
  status: "active" | "triggered" | "cancelled" | "expired" | "failed";
  expires_at: string | null;
  triggered_at: string | null;
  triggered_leg: "lower" | "upper" | null;
  broker_order_id: string | null;
  last_error: string | null;
  notes: string | null;
  created_at: string;
}

export interface PlaceGttInput {
  symbol: string;
  exchange: "NSE" | "BSE";
  side: "BUY" | "SELL";
  triggerType?: "single" | "OCO";
  triggerPrice: number;
  triggerPriceUpper?: number;
  orderType?: "MARKET" | "LIMIT";
  price?: number;
  quantity: number;
  product?: "MIS" | "CNC" | "NRML";
  expiresAt?: string;
  notes?: string;
}

export function useGttOrders() {
  return useQuery({
    queryKey: ["market", "gtt", "list"],
    queryFn: async (): Promise<GttOrder[]> => {
      // EGRESS: explicit projection — the row carries broker payload/audit
      // columns the list never renders.
      const { data, error } = await supabase
        .from("market_gtt_orders")
        .select(
          "id,symbol,exchange,side,trigger_type,trigger_price,trigger_price_upper," +
          "order_type,price,quantity,product,status,expires_at,triggered_at," +
          "triggered_leg,broker_order_id,last_error,notes,created_at",
        )
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as GttOrder[];
    },
    // Trigger evaluation is server-side (market-gtt-eval cron); this poll
    // is just to reflect status flips in the UI. Off-hours nothing can flip,
    // and a hidden tab has nobody watching — both stop the poll entirely.
    refetchInterval: liveInterval(15_000, false),
    refetchIntervalInBackground: false,
  });
}

export function useGttMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["market", "gtt"] });
  const place = useMutation({
    mutationFn: (input: PlaceGttInput) =>
      callMarketFn<{ ok: boolean; id: string }>("market-gtt-place", input as unknown as Record<string, unknown>),
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    mutationFn: (id: string) =>
      callMarketFn<{ ok: boolean }>("market-gtt-cancel", { id }),
    onSuccess: invalidate,
  });
  return { place, cancel };
}
