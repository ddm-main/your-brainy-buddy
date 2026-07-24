// Icon-only toggle to add/remove a symbol from the user's currently-active
// watchlist. Reuses the same active-list key WatchlistPanel writes to, so the
// two stay in sync. If the user has no watchlist yet, one is seeded on first
// click (mirrors WatchlistPanel's "Default" seeding behavior).
import { useCallback, type MouseEvent } from "react";
import { Star } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useUi } from "@/store/uiStore";

const ACTIVE_KEY = "market.watchlist.activeId";

type ActiveListState = {
  listId: string | null;
  items: Record<string, string>; // symbol -> item id
};

async function resolveActiveList(): Promise<{ userId: string | null; listId: string | null }> {
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return { userId: null, listId: null };
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(ACTIVE_KEY) : null;
  const { data: lists } = await supabase.from("market_watchlists")
    .select("id").order("created_at", { ascending: true });
  const rows = (lists ?? []) as Array<{ id: string }>;
  const valid = stored && rows.some((r) => r.id === stored) ? stored : rows[0]?.id ?? null;
  return { userId: u.user.id, listId: valid };
}

export function AddToWatchlistButton({
  symbol,
  exchange = "NSE",
}: {
  symbol: string;
  exchange?: "NSE" | "BSE";
}) {
  const push = useUi((s) => s.push);
  const qc = useQueryClient();

  const { data: state } = useQuery<ActiveListState>({
    queryKey: ["market", "watchlist-active-items"],
    queryFn: async () => {
      const { listId } = await resolveActiveList();
      if (!listId) return { listId: null, items: {} };
      const { data } = await supabase.from("market_watchlist_items")
        .select("id,symbol").eq("watchlist_id", listId);
      const items: Record<string, string> = {};
      for (const row of (data ?? []) as Array<{ id: string; symbol: string }>) items[row.symbol] = row.id;
      return { listId, items };
    },
    staleTime: 30_000,
  });

  const inList = Boolean(state?.items[symbol]);

  const mut = useMutation({
    mutationFn: async () => {
      const { userId, listId: resolved } = await resolveActiveList();
      if (!userId) throw new Error("Sign in to use watchlists");
      let listId = resolved;
      if (!listId) {
        const { data, error } = await supabase.from("market_watchlists")
          .insert({ user_id: userId, name: "Default" } as any).select("id").single();
        if (error) throw error;
        listId = (data as { id: string }).id;
        try { localStorage.setItem(ACTIVE_KEY, listId); } catch { /* noop */ }
      }
      const existingId = state?.items[symbol];
      if (existingId) {
        const { error } = await supabase.from("market_watchlist_items").delete().eq("id", existingId);
        if (error) throw error;
        return { action: "removed" as const };
      }
      const { error } = await supabase.from("market_watchlist_items").insert({
        user_id: userId, watchlist_id: listId, symbol, exchange,
      } as any);
      if (error && error.code !== "23505") throw error;
      return { action: "added" as const };
    },
    onSuccess: (res) => {
      push(res.action === "added" ? `${symbol} added to watchlist` : `${symbol} removed`, "ok");
      qc.invalidateQueries({ queryKey: ["market", "watchlist-active-items"] });
      qc.invalidateQueries({ queryKey: ["market", "dash-counts"] });
    },
    onError: (e: unknown) => {
      push(e instanceof Error ? e.message : "watchlist update failed", "err");
    },
  });

  const onClick = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (mut.isPending) return;
    mut.mutate();
  }, [mut]);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={mut.isPending}
      title={inList ? `Remove ${symbol} from watchlist` : `Add ${symbol} to watchlist`}
      aria-label={inList ? `Remove ${symbol} from watchlist` : `Add ${symbol} to watchlist`}
      style={{
        width: 22, height: 22, display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "transparent", border: "1px solid var(--edge)", borderRadius: 2,
        color: inList ? "var(--accent)" : "var(--text-dim)",
        cursor: mut.isPending ? "wait" : "pointer",
        opacity: mut.isPending ? 0.6 : 1,
        padding: 0,
      }}
    >
      <Star size={12} fill={inList ? "currentColor" : "none"} />
    </button>
  );
}