// AutoTrade hooks — rule-based entry/exit against the connected Kotak Neo
// account. CRUD goes straight through the Supabase client (same pattern as
// useSavedScreeners/useScreenerMutations for market_saved_screeners); only
// eval (cron) and on-demand actions (flatten/cancel/dry-run) are edge
// functions, since those are the only parts that touch the broker.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { callMarketFn } from "./api";
import type { ScreenerGroup } from "./types";

// market_autotrade_* tables aren't in the generated Supabase types until the
// AutoTrade migration is applied to the live project and types regenerated
// (`generate_typescript_types`) — same untyped-escape-hatch pattern already
// used elsewhere in this codebase for tables ahead of the generated types
// (e.g. Home.tsx's `(mod.supabase as any)` for jarvis_interactions).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export interface AutoTradeSettings {
  user_id: string;
  enabled: boolean;
  max_capital_per_rule: number;
  max_open_positions: number;
  daily_loss_limit: number;
  disabled_reason: string | null;
  disabled_at: string | null;
}

export interface AutoTradeRule {
  id: string;
  name: string;
  symbol: string | null;
  exchange: string;
  watchlist_id: string | null;
  entry_conditions: ScreenerGroup[];
  exit_conditions: ScreenerGroup[];
  stop_loss_pct: number | null;
  target_pct: number | null;
  trail_stop_pct: number | null;
  product: "MIS" | "CNC";
  order_type: "MARKET" | "LIMIT";
  exit_order_type: "MARKET" | "LIMIT" | "SL" | "SL-M";
  limit_offset_pct: number | null;
  sizing_mode: "fixed_qty" | "fixed_capital";
  sizing_value: number;
  is_armed: boolean;
  created_at: string;
}

export interface AutoTradeOrder {
  id: string;
  rule_id: string | null;
  symbol: string;
  exchange: string;
  side: "BUY" | "SELL";
  leg: "entry" | "exit";
  quantity: number;
  order_type: "MARKET" | "LIMIT";
  product: "MIS" | "CNC";
  requested_price: number | null;
  broker_order_id: string | null;
  status: string;
  reason: string | null;
  filled_price: number | null;
  created_at: string;
}

export interface AutoTradeLogRow {
  id: string;
  rule_id: string | null;
  level: "info" | "skip" | "error" | "fired";
  message: string;
  created_at: string;
}

const DEFAULT_SETTINGS: Omit<AutoTradeSettings, "user_id"> = {
  enabled: false,
  max_capital_per_rule: 10000,
  max_open_positions: 3,
  daily_loss_limit: 2000,
  disabled_reason: null,
  disabled_at: null,
};

export function useAutoTradeSettings() {
  return useQuery({
    queryKey: ["market", "autotrade", "settings"],
    queryFn: async (): Promise<AutoTradeSettings> => {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      const { data, error } = await db.from("market_autotrade_settings").select("*").maybeSingle();
      if (error) throw error;
      return (data as AutoTradeSettings) ?? { user_id: userId ?? "", ...DEFAULT_SETTINGS };
    },
  });
}

export function useAutoTradeSettingsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<Omit<AutoTradeSettings, "user_id">>) => {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) throw new Error("Sign in required");
      const { error } = await db.from("market_autotrade_settings")
        .upsert({ user_id: userId, ...patch }, { onConflict: "user_id" });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["market", "autotrade", "settings"] }),
  });
}

export function useAutoTradeRules() {
  return useQuery({
    queryKey: ["market", "autotrade", "rules"],
    queryFn: async (): Promise<AutoTradeRule[]> => {
      const { data, error } = await db.from("market_autotrade_rules").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as AutoTradeRule[];
    },
  });
}

export function useAutoTradeRuleMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["market", "autotrade", "rules"] });
  const save = useMutation({
    mutationFn: async (r: Partial<AutoTradeRule> & { name: string }) => {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) throw new Error("Sign in required");
      const payload = { ...r, user_id: userId } as any;
      if (r.id) {
        const { error } = await db.from("market_autotrade_rules").update(payload).eq("id", r.id);
        if (error) throw error;
      } else {
        const { error } = await db.from("market_autotrade_rules").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: invalidate,
  });
  const setArmed = useMutation({
    mutationFn: async ({ id, armed }: { id: string; armed: boolean }) => {
      const { error } = await db.from("market_autotrade_rules").update({ is_armed: armed }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from("market_autotrade_rules").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
  return { save, setArmed, remove };
}

export function useAutoTradeOrders() {
  return useQuery({
    queryKey: ["market", "autotrade", "orders"],
    queryFn: async (): Promise<AutoTradeOrder[]> => {
      const { data, error } = await db.from("market_autotrade_orders")
        .select("*").order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as AutoTradeOrder[];
    },
    refetchInterval: 15_000,
  });
}

export function useAutoTradeLog() {
  return useQuery({
    queryKey: ["market", "autotrade", "log"],
    queryFn: async (): Promise<AutoTradeLogRow[]> => {
      const { data, error } = await db.from("market_autotrade_log")
        .select("*").order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as AutoTradeLogRow[];
    },
    refetchInterval: 15_000,
  });
}

export function useAutoTradeAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => callMarketFn("market-autotrade-action", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["market", "autotrade"] });
    },
  });
}
