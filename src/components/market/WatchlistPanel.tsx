// Watchlist widget for the Overview dashboard.
// Multi-list: users get up to N named lists (tabs below the header). The
// symbol search sits inline in the panel header, so no vertical space is
// spent on a separate row.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useUi } from "@/store/uiStore";
import { Pencil, RefreshCw, Settings2, ShoppingCart, Trash2 } from "lucide-react";
import { SymbolSearchInput, type SymbolOption } from "@/components/market/SymbolSearchInput";
import { quoteKey } from "@/lib/market/pnl";
import { useQuotes } from "@/lib/market/hooks";
import { mergeLiveQuotes, useLiveTickStore } from "@/lib/market/liveTickStore";
import { subscribeSymbolsForTicks } from "@/lib/market/useRealtimeTicks";
import type { Quote } from "@/lib/market/types";
import { OrderTicket } from "@/components/market/OrderTicket";
import { Return1DCell } from "@/components/hud/DataTable";

type Item = { id: string; watchlist_id: string; symbol: string; exchange: string };
type List = { id: string; name: string };

const ACTIVE_KEY = "market.watchlist.activeId";
// Seed a single "Default" list on first use. Users can add more via "+ new".
// (Previous behavior of pre-creating 4 empty tabs cluttered the panel.)
const MIN_LISTS = 1;

export function WatchlistPanel({
  readyCount, nearCount, weakCount, onSettings,
}: {
  readyCount?: number;
  nearCount?: number;
  weakCount?: number;
  onSettings?: () => void;
} = {}) {
  const push = useUi((s) => s.push);
  const [lists, setLists] = useState<List[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem(ACTIVE_KEY));
  const [items, setItems] = useState<Item[]>([]);
  const [newSym, setNewSym] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [ticket, setTicket] = useState<{ symbol: string; exchange: "NSE" | "BSE"; side: "BUY" | "SELL" } | null>(null);

  const loadLists = async () => {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) { setLoading(false); return; }
    const { data: wl, error } = await supabase.from("market_watchlists")
      .select("id,name").order("created_at", { ascending: true });
    if (error) { push(error.message, "err"); setLoading(false); return; }
    let rows = (wl ?? []) as List[];
    // Seed default lists so the user always has ≥4 slots to work with.
    if (rows.length < MIN_LISTS) {
      const toCreate: Array<{ user_id: string; name: string }> = [
        { user_id: u.user.id, name: "Default" },
      ];
      const { data: inserted, error: e2 } = await supabase.from("market_watchlists")
        .insert(toCreate as any).select("id,name");
      if (e2) { push(e2.message, "err"); }
      else rows = [...rows, ...((inserted ?? []) as List[])];
    }
    setLists(rows);
    // Reconcile active id
    const stored = localStorage.getItem(ACTIVE_KEY);
    const valid = stored && rows.some((r) => r.id === stored) ? stored : rows[0]?.id ?? null;
    if (valid !== activeId) setActiveId(valid);
  };

  const loadItems = async (id: string | null) => {
    if (!id) { setItems([]); setLoading(false); return; }
    const { data: it, error } = await supabase.from("market_watchlist_items")
      .select("id,watchlist_id,symbol,exchange").eq("watchlist_id", id)
      .order("priority", { ascending: false });
    if (error) push(error.message, "err");
    setItems((it ?? []) as Item[]);
    setLoading(false);
  };

  useEffect(() => { loadLists(); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
    loadItems(activeId);
    // eslint-disable-next-line
  }, [activeId]);

  const quoteKeys = useMemo(() => items.map((i) => `${i.exchange}:${i.symbol}`), [items]);
  useEffect(() => { subscribeSymbolsForTicks(quoteKeys); }, [quoteKeys]);
  const { data: quotesData, isFetching: quotesFetching, refetch: refetchQuotes } = useQuotes(quoteKeys);
  const restQuotes = useMemo(() => {
    const map: Record<string, Quote> = {};
    for (const q of quotesData?.quotes ?? []) map[quoteKey(q.exchange, q.symbol)] = q;
    return map;
  }, [quotesData]);
  const liveTicks = useLiveTickStore((s) => s.ticks);
  const quotes = useMemo(() => mergeLiveQuotes(restQuotes, liveTicks), [restQuotes, liveTicks]);

  const addVerified = async (opt: SymbolOption) => {
    if (!activeId) return;
    setAdding(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { error } = await supabase.from("market_watchlist_items").insert({
        user_id: u.user.id, watchlist_id: activeId, symbol: opt.symbol, exchange: opt.exchange,
      } as any);
      if (error) {
        push(error.code === "23505" ? `${opt.symbol} is already in this list` : error.message, "err");
        return;
      }
      setNewSym("");
      push(`${opt.symbol} added`, "ok");
      await loadItems(activeId);
    } finally {
      setAdding(false);
    }
  };

  const removeItem = async (id: string) => {
    const { error } = await supabase.from("market_watchlist_items").delete().eq("id", id);
    if (error) { push(error.message, "err"); return; }
    await loadItems(activeId);
  };

  const addList = async () => {
    const name = window.prompt("Name this watchlist:", `Watchlist ${lists.length + 1}`)?.trim();
    if (!name) return;
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    const { data, error } = await supabase.from("market_watchlists")
      .insert({ user_id: u.user.id, name } as any).select("id,name").single();
    if (error) { push(error.message, "err"); return; }
    setLists((ls) => [...ls, data as List]);
    setActiveId((data as List).id);
  };

  const renameList = async (l: List) => {
    const name = window.prompt("Rename watchlist:", l.name)?.trim();
    if (!name || name === l.name) return;
    const { error } = await supabase.from("market_watchlists").update({ name }).eq("id", l.id);
    if (error) { push(error.message, "err"); return; }
    setLists((ls) => ls.map((x) => x.id === l.id ? { ...x, name } : x));
  };

  const deleteList = async (l: List) => {
    if (lists.length <= 1) { push("Keep at least one watchlist", "warn"); return; }
    if (!window.confirm(`Delete "${l.name}" and all its symbols?`)) return;
    const { error } = await supabase.from("market_watchlists").delete().eq("id", l.id);
    if (error) { push(error.message, "err"); return; }
    const remaining = lists.filter((x) => x.id !== l.id);
    setLists(remaining);
    if (activeId === l.id) setActiveId(remaining[0]?.id ?? null);
  };

  const headerActions = (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, justifyContent: "flex-end" }}>
      <div style={{ width: 220 }}>
        <SymbolSearchInput value={newSym} onChange={setNewSym}
          placeholder={adding ? "adding…" : "Search & add symbol…"}
          onSelect={addVerified} disabled={adding || !activeId} />
      </div>
      {(readyCount != null || nearCount != null || weakCount != null) && (
        <div style={{ display: "flex", gap: 3 }}>
          {readyCount ? <Chip tone="ok">{readyCount} ready</Chip> : null}
          {nearCount ? <Chip tone="warn">{nearCount} near</Chip> : null}
          {weakCount ? <Chip tone="err">{weakCount} weak</Chip> : null}
        </div>
      )}
      <Btn size="sm" onClick={() => refetchQuotes()} disabled={quotesFetching || items.length === 0} title="refresh quotes">
        <RefreshCw size={11} />
      </Btn>
      {onSettings && (
        <Btn size="sm" onClick={onSettings} title="settings"><Settings2 size={11} /></Btn>
      )}
    </div>
  );

  const activeList = lists.find((l) => l.id === activeId);

  return (
    <HudPanel flow title="Watchlist" actions={headerActions}>
      {items.length > 100 && (
        <div style={{ padding: "4px 8px", marginBottom: 6, fontSize: 11,
          border: "1px solid var(--warn, #d97706)", color: "var(--warn, #d97706)",
          background: "rgba(217,119,6,0.08)", borderRadius: 2 }}>
          Live ticks are capped at 100 symbols · {items.length - 100} symbol{items.length - 100 === 1 ? "" : "s"} will fall back to REST polling.
        </div>
      )}
      {/* Tabs */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8, borderBottom: "1px solid var(--edge)", paddingBottom: 6 }}>
        {lists.map((l) => {
          const active = l.id === activeId;
          return (
            <button key={l.id}
              onClick={() => setActiveId(l.id)}
              style={{
                padding: "3px 8px", fontSize: 11, cursor: "pointer",
                background: active ? "rgba(53,214,237,0.12)" : "transparent",
                color: active ? "var(--accent)" : "var(--text-dim)",
                border: `1px solid ${active ? "var(--accent)" : "var(--edge)"}`,
                borderRadius: 2, display: "inline-flex", alignItems: "center", gap: 4,
              }}
              title={l.name}
            >
              <span>{l.name}</span>
              {active && (
                <>
                  <span onClick={(e) => { e.stopPropagation(); renameList(l); }}
                    style={{ opacity: 0.7, cursor: "pointer" }} title="rename">
                    <Pencil size={9} />
                  </span>
                  <span onClick={(e) => { e.stopPropagation(); deleteList(l); }}
                    style={{ opacity: 0.7, cursor: "pointer" }} title="delete">
                    <Trash2 size={9} />
                  </span>
                </>
              )}
            </button>
          );
        })}
        <button onClick={addList}
          style={{ padding: "3px 8px", fontSize: 11, cursor: "pointer",
            background: "transparent", color: "var(--text-muted)",
            border: "1px dashed var(--edge)", borderRadius: 2 }}
          title="new watchlist"
        >+ new</button>
      </div>

      {loading ? (
        <div className="hud-label" style={{ fontSize: 11, color: "var(--text-muted)" }}>loading…</div>
      ) : items.length === 0 ? (
        <div className="hud-label" style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {activeList ? `no symbols in ${activeList.name} — search above` : "select a list"}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minHeight: 0, overflowY: "auto" }}>
          {items.map((i) => {
            const q = quotes[quoteKey(i.exchange, i.symbol)];
            return (
              <div key={i.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 2px", borderBottom: "1px solid var(--edge)", fontSize: 12 }}>
                <Link to={`/market/analysis/${i.symbol}?exchange=${i.exchange}`} style={{ color: "var(--accent)", textDecoration: "none" }}>
                  {i.symbol} <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{i.exchange}</span>
                </Link>
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span
                    style={{ fontVariantNumeric: "tabular-nums" }}
                    title={q?.source ? `price source: ${q.source}${q?.stale ? " · stale" : ""}` : undefined}
                  >
                    {q ? q.ltp.toFixed(2) : "—"}
                  </span>
                  <span
                    style={{ minWidth: 120, textAlign: "right" }}
                    title={q?.previous_close != null
                      ? `prev close ₹${q.previous_close.toFixed(2)}${q.previous_close_as_of ? ` (as of ${q.previous_close_as_of})` : ""}`
                      : "no prior close available"}
                  >
                    <Return1DCell
                      abs={q?.day_change ?? (q?.ltp != null && q?.previous_close != null ? q.ltp - q.previous_close : null)}
                      pct={q?.change_pct ?? null}
                    />
                  </span>
                  {q?.stale && <span style={{ fontSize: 9, color: "var(--warn)" }}>stale</span>}
                  <button onClick={() => setTicket({ symbol: i.symbol, exchange: i.exchange as "NSE" | "BSE", side: "BUY" })} className="hud-btn" data-variant="ghost" data-size="sm" title="Buy"><ShoppingCart size={11} /></button>
                  <button onClick={() => removeItem(i.id)} className="hud-btn" data-variant="ghost" data-size="sm"><Trash2 size={11} /></button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {ticket && (
        <OrderTicket open={ticket !== null} onClose={() => setTicket(null)}
          symbol={ticket.symbol} exchange={ticket.exchange} side={ticket.side} />
      )}
    </HudPanel>
  );
}
