// Watchlist widget, embedded in the Overview dashboard — replaces the
// standalone multi-list Watchlists page. A user gets one implicit watchlist,
// auto-created on first add; the common case (a running list of symbols to
// watch) now lives on the page you actually look at.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, inputStyle } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useUi } from "@/store/uiStore";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { SymbolSearchInput } from "@/components/market/SymbolSearchInput";
import { quoteKey } from "@/lib/market/pnl";
import { useQuotes } from "@/lib/market/hooks";
import { mergeLiveQuotes, useLiveTickStore } from "@/lib/market/liveTickStore";
import type { Quote } from "@/lib/market/types";

type Item = { id: string; watchlist_id: string; symbol: string; exchange: string };

export function WatchlistPanel() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<Item[]>([]);
  const [listId, setListId] = useState<string | null>(null);
  const [newSym, setNewSym] = useState("");
  const [newEx, setNewEx] = useState("NSE");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const { data: wl, error: e1 } = await supabase.from("market_watchlists")
      .select("id").order("created_at", { ascending: true }).limit(1);
    if (e1) { push(e1.message, "err"); setLoading(false); return; }
    const id = wl?.[0]?.id ?? null;
    setListId(id);
    if (!id) { setItems([]); setLoading(false); return; }
    const { data: it, error: e2 } = await supabase.from("market_watchlist_items")
      .select("id,watchlist_id,symbol,exchange").eq("watchlist_id", id)
      .order("priority", { ascending: false });
    if (e2) push(e2.message, "err");
    setItems((it ?? []) as Item[]);
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const quoteKeys = useMemo(() => items.map((i) => `${i.exchange}:${i.symbol}`), [items]);
  const { data: quotesData, isFetching: quotesFetching, refetch: refetchQuotes } = useQuotes(quoteKeys);
  const restQuotes = useMemo(() => {
    const map: Record<string, Quote> = {};
    for (const q of quotesData?.quotes ?? []) map[quoteKey(q.exchange, q.symbol)] = q;
    return map;
  }, [quotesData]);
  const liveTicks = useLiveTickStore((s) => s.ticks);
  const quotes = useMemo(() => mergeLiveQuotes(restQuotes, liveTicks), [restQuotes, liveTicks]);

  const addItem = async () => {
    const symbol = newSym.trim().toUpperCase();
    if (!symbol) return;
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    let id = listId;
    if (!id) {
      const { data, error } = await supabase.from("market_watchlists")
        .insert({ name: "Watchlist", user_id: u.user.id } as any).select("id").single();
      if (error) { push(error.message, "err"); return; }
      id = (data as any).id;
      setListId(id);
    }
    const { error } = await supabase.from("market_watchlist_items").insert({
      user_id: u.user.id, watchlist_id: id, symbol, exchange: newEx,
    } as any);
    if (error) { push(error.message, "err"); return; }
    setNewSym("");
    await load();
  };

  const removeItem = async (id: string) => {
    const { error } = await supabase.from("market_watchlist_items").delete().eq("id", id);
    if (error) { push(error.message, "err"); return; }
    await load();
  };

  return (
    <HudPanel flow title="Watchlist" actions={
      <Btn size="sm" onClick={() => refetchQuotes()} disabled={quotesFetching || items.length === 0} title="refresh quotes">
        <RefreshCw size={11} />
      </Btn>
    }>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <SymbolSearchInput value={newSym} onChange={setNewSym} placeholder="Add symbol"
          onSelect={(o) => setNewEx(o.exchange)} onEnter={addItem}
          containerStyle={{ flex: 1 }} />
        <select value={newEx} onChange={(e) => setNewEx(e.target.value)} style={{ ...inputStyle, width: 62, padding: "6px 4px" }}>
          <option>NSE</option><option>BSE</option>
        </select>
        <Btn size="sm" onClick={addItem}><Plus size={11} /></Btn>
      </div>

      {loading ? (
        <div className="hud-label" style={{ fontSize: 11, color: "var(--text-muted)" }}>loading…</div>
      ) : items.length === 0 ? (
        <div className="hud-label" style={{ fontSize: 11, color: "var(--text-muted)" }}>no symbols yet — add one above</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 260, overflowY: "auto" }}>
          {items.map((i) => {
            const q = quotes[quoteKey(i.exchange, i.symbol)];
            return (
              <div key={i.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 2px", borderBottom: "1px solid var(--edge)", fontSize: 12 }}>
                <Link to={`/market/analysis/${i.symbol}?exchange=${i.exchange}`} style={{ color: "var(--accent)", textDecoration: "none" }}>
                  {i.symbol} <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{i.exchange}</span>
                </Link>
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{q ? q.ltp.toFixed(2) : "—"}</span>
                  <span style={{ minWidth: 56, textAlign: "right", color: (q?.change_pct ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}>
                    {q?.change_pct == null ? "—" : `${q.change_pct >= 0 ? "+" : ""}${q.change_pct.toFixed(2)}%`}
                  </span>
                  {q?.stale && <span style={{ fontSize: 9, color: "var(--warn)" }}>stale</span>}
                  <button onClick={() => removeItem(i.id)} className="hud-btn" data-variant="ghost" data-size="sm"><Trash2 size={11} /></button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </HudPanel>
  );
}
