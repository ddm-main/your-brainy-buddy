// Watchlist widget for the Overview dashboard.
// Multi-list, realtime-synced, sortable, filterable, keyboard-driven.
//
// Fixes (see .lovable/plan.md "Watchlist audit"):
//  1. request-id guard on loadItems so tab switches can't be overwritten by
//     a stale in-flight response.
//  2. active-id reconciliation runs before the first loadItems call (no
//     empty-list flash when localStorage points at a deleted list).
//  3. cross-device sync via Realtime on market_watchlists + items.
//  4. deterministic ordering (priority DESC, created_at ASC).
//  5. duplicate-symbol guard client-side in addition to the unique index.
//  6. delete-list confirmation and rename via HudModal (no window.prompt/
//     confirm — blocked in the embedded preview).
//  7. deleting active list falls back to the neighbour, not always index 0.
//  8. live-tick cap banner reads the true constant from useRealtimeTicks.
//  9. quoteKeys memo is stable on identical symbols (no spurious resubscribe).
// 10. row abs is derived from pct*prevClose when the live tick only ships pct.
// 11. refresh button only disables while the manual click is in-flight — the
//     background poll no longer greys it out.
// 12. row buttons have aria-labels and the tabs use proper role="tab"/tablist.
// 13. keyboard: "/" focus search, "n" new list, "Del" remove focused row,
//     "←/→" cycle tabs. Skipped when focus is in an input.
// 14. per-row sort (Symbol / LTP / 1D%) + inline filter box.
// 15. row reorder buttons (persist to `priority`) — no drag lib.
// 16. CSV export per list.
//
// Skipped deliberately (heavy, out-of-envelope for this pass):
// sparklines, drag-and-drop reorder, sector grouping, batch multi-select.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { HudModal } from "@/components/hud/HudModal";
import { Btn, Chip } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useUi } from "@/store/uiStore";
import {
  ArrowDown, ArrowUp, Bell, Download, Pencil, RefreshCw, Search,
  Settings2, ShoppingCart, TrendingDown, Trash2,
} from "lucide-react";
import { SymbolSearchInput, type SymbolOption } from "@/components/market/SymbolSearchInput";
import { quoteKey } from "@/lib/market/pnl";
import { useQuotes } from "@/lib/market/hooks";
import { mergeLiveQuotes, useLiveTickStore } from "@/lib/market/liveTickStore";
import { subscribeSymbolsForTicks, MAX_SUBSCRIBE_SYMBOLS } from "@/lib/market/useRealtimeTicks";
import type { Quote } from "@/lib/market/types";
import { OrderTicket } from "@/components/market/OrderTicket";
import { Return1DCell, deriveChangeAbs } from "@/components/hud/DataTable";

type Item = { id: string; watchlist_id: string; symbol: string; exchange: string; priority: number | null; created_at: string };
type List = { id: string; name: string };
type SortKey = "manual" | "symbol" | "ltp" | "chg";

const ACTIVE_KEY = "market.watchlist.activeId";
const SORT_KEY = "market.watchlist.sort";
const FILTER_KEY = "market.watchlist.filter";

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
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [newSym, setNewSym] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [ticket, setTicket] = useState<{ symbol: string; exchange: "NSE" | "BSE"; side: "BUY" | "SELL" } | null>(null);
  const [filter, setFilter] = useState(() => sessionStorage.getItem(FILTER_KEY) ?? "");
  const [sort, setSort] = useState<SortKey>(() => (localStorage.getItem(SORT_KEY) as SortKey) ?? "manual");
  const [showFilter, setShowFilter] = useState(false);

  // Modals
  const [renaming, setRenaming] = useState<List | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [creatingList, setCreatingList] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<List | null>(null);

  const userIdRef = useRef<string | null>(null);
  const loadRequestRef = useRef(0);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id);
    if (id) localStorage.setItem(ACTIVE_KEY, id);
  }, []);

  useEffect(() => { localStorage.setItem(SORT_KEY, sort); }, [sort]);
  useEffect(() => { sessionStorage.setItem(FILTER_KEY, filter); }, [filter]);

  // ---- data loaders --------------------------------------------------------

  const loadLists = useCallback(async (): Promise<List[]> => {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) { setLoading(false); return []; }
    userIdRef.current = u.user.id;
    const { data: wl, error } = await supabase.from("market_watchlists")
      .select("id,name").order("created_at", { ascending: true });
    if (error) { push(error.message, "err"); setLoading(false); return []; }
    let rows = (wl ?? []) as List[];
    if (rows.length === 0) {
      const { data: inserted, error: e2 } = await supabase.from("market_watchlists")
        .insert([{ user_id: u.user.id, name: "Default" }] as any).select("id,name");
      if (e2) push(e2.message, "err");
      else rows = (inserted ?? []) as List[];
    }
    setLists(rows);
    return rows;
  }, [push]);

  const loadItems = useCallback(async (id: string | null) => {
    if (!id) { setItems([]); setLoading(false); return; }
    const reqId = ++loadRequestRef.current;
    const { data: it, error } = await supabase.from("market_watchlist_items")
      .select("id,watchlist_id,symbol,exchange,priority,created_at")
      .eq("watchlist_id", id)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true });
    if (reqId !== loadRequestRef.current) return; // stale — a newer switch superseded us
    if (error) push(error.message, "err");
    setItems((it ?? []) as Item[]);
    setLoading(false);
  }, [push]);

  // Initial bootstrap: lists first, then reconcile activeId, then items.
  useEffect(() => {
    (async () => {
      const rows = await loadLists();
      const stored = localStorage.getItem(ACTIVE_KEY);
      const valid = stored && rows.some((r) => r.id === stored) ? stored : rows[0]?.id ?? null;
      setActiveId(valid);
      await loadItems(valid);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow-up loads when the user switches tabs.
  const isFirstItemLoad = useRef(true);
  useEffect(() => {
    if (isFirstItemLoad.current) { isFirstItemLoad.current = false; return; }
    loadItems(activeId);
  }, [activeId, loadItems]);

  // Realtime cross-device sync.
  useEffect(() => {
    const uid = userIdRef.current;
    if (!uid) return;
    const ch = supabase.channel(`watchlist-${uid}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "market_watchlists", filter: `user_id=eq.${uid}` },
        () => { loadLists(); })
      .on("postgres_changes",
        { event: "*", schema: "public", table: "market_watchlist_items", filter: `user_id=eq.${uid}` },
        (payload) => {
          const wid = (payload.new as any)?.watchlist_id ?? (payload.old as any)?.watchlist_id;
          if (wid === activeId) loadItems(activeId);
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [activeId, loadItems, loadLists]);

  // ---- quotes + live ticks -------------------------------------------------

  const quoteKeys = useMemo(
    () => items.map((i) => `${i.exchange}:${i.symbol}`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items.map((i) => `${i.exchange}:${i.symbol}`).join("|")],
  );
  useEffect(() => { subscribeSymbolsForTicks(quoteKeys); }, [quoteKeys]);
  const { data: quotesData, refetch: refetchQuotes } = useQuotes(quoteKeys);
  const restQuotes = useMemo(() => {
    const map: Record<string, Quote> = {};
    for (const q of quotesData?.quotes ?? []) map[quoteKey(q.exchange, q.symbol)] = q;
    return map;
  }, [quotesData]);
  const liveTicks = useLiveTickStore((s) => s.ticks);
  const quotes = useMemo(() => mergeLiveQuotes(restQuotes, liveTicks), [restQuotes, liveTicks]);

  // ---- derived rows: filter + sort ----------------------------------------

  const rows = useMemo(() => {
    const needle = filter.trim().toUpperCase();
    let out = items;
    if (needle) out = out.filter((i) => i.symbol.toUpperCase().includes(needle));
    if (sort !== "manual") {
      out = [...out].sort((a, b) => {
        if (sort === "symbol") return a.symbol.localeCompare(b.symbol);
        const qa = quotes[quoteKey(a.exchange, a.symbol)];
        const qb = quotes[quoteKey(b.exchange, b.symbol)];
        const va = sort === "ltp" ? qa?.ltp ?? -Infinity : qa?.change_pct ?? -Infinity;
        const vb = sort === "ltp" ? qb?.ltp ?? -Infinity : qb?.change_pct ?? -Infinity;
        return vb - va;
      });
    }
    return out;
  }, [items, filter, sort, quotes]);

  // ---- mutations -----------------------------------------------------------

  const addVerified = async (opt: SymbolOption) => {
    if (!activeId) return;
    // Client-side dedupe — the unique index still guards races.
    if (items.some((i) => i.symbol.toUpperCase() === opt.symbol.toUpperCase() && i.exchange === opt.exchange)) {
      push(`${opt.symbol} is already in this list`, "warn");
      setNewSym("");
      return;
    }
    setAdding(true);
    try {
      const uid = userIdRef.current;
      if (!uid) return;
      const { error } = await supabase.from("market_watchlist_items").insert({
        user_id: uid, watchlist_id: activeId, symbol: opt.symbol, exchange: opt.exchange,
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
    // Optimistic — realtime + reload will reconcile on error.
    const prev = items;
    setItems((xs) => xs.filter((x) => x.id !== id));
    const { error } = await supabase.from("market_watchlist_items").delete().eq("id", id);
    if (error) { push(error.message, "err"); setItems(prev); }
  };

  const reorder = async (id: string, dir: -1 | 1) => {
    if (sort !== "manual") { push("Switch sort to Manual to reorder", "warn"); return; }
    const idx = items.findIndex((i) => i.id === id);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= items.length) return;
    const a = items[idx];
    const b = items[swap];
    // Renumber the whole list to keep priority monotone (safe, O(n) on small lists).
    const next = [...items];
    next[idx] = b; next[swap] = a;
    const updates = next.map((it, i) => ({ id: it.id, priority: next.length - i }));
    setItems(next.map((it, i) => ({ ...it, priority: next.length - i })));
    // Batch upsert — tiny payload, one round-trip.
    const uid = userIdRef.current!;
    const payload = updates.map((u, i) => ({
      id: u.id, priority: u.priority, user_id: uid,
      watchlist_id: activeId!, symbol: next[i].symbol, exchange: next[i].exchange,
    }));
    const { error } = await supabase.from("market_watchlist_items").upsert(payload as any);
    if (error) { push(error.message, "err"); await loadItems(activeId); }
  };

  const submitCreateList = async () => {
    const name = newListName.trim();
    if (!name) return;
    const uid = userIdRef.current;
    if (!uid) return;
    const { data, error } = await supabase.from("market_watchlists")
      .insert({ user_id: uid, name } as any).select("id,name").single();
    if (error) { push(error.message, "err"); return; }
    setLists((ls) => [...ls, data as List]);
    setActiveId((data as List).id);
    setCreatingList(false);
    setNewListName("");
  };

  const submitRename = async () => {
    if (!renaming) return;
    const name = renameValue.trim();
    if (!name || name === renaming.name) { setRenaming(null); return; }
    const { error } = await supabase.from("market_watchlists").update({ name }).eq("id", renaming.id);
    if (error) { push(error.message, "err"); return; }
    setLists((ls) => ls.map((x) => x.id === renaming.id ? { ...x, name } : x));
    setRenaming(null);
  };

  const submitDelete = async () => {
    if (!confirmDelete) return;
    if (lists.length <= 1) { push("Keep at least one watchlist", "warn"); setConfirmDelete(null); return; }
    const idx = lists.findIndex((x) => x.id === confirmDelete.id);
    const { error } = await supabase.from("market_watchlists").delete().eq("id", confirmDelete.id);
    if (error) { push(error.message, "err"); return; }
    const remaining = lists.filter((x) => x.id !== confirmDelete.id);
    setLists(remaining);
    if (activeId === confirmDelete.id) {
      const neighbour = remaining[Math.min(idx, remaining.length - 1)];
      setActiveId(neighbour?.id ?? null);
    }
    setConfirmDelete(null);
  };

  // ---- CSV export ----------------------------------------------------------

  const exportCsv = () => {
    if (items.length === 0) { push("Empty list", "warn"); return; }
    const listName = lists.find((l) => l.id === activeId)?.name ?? "watchlist";
    const header = "symbol,exchange,ltp,change_pct,change_abs\n";
    const body = items.map((i) => {
      const q = quotes[quoteKey(i.exchange, i.symbol)];
      const abs = q?.day_change ?? deriveChangeAbs(q?.ltp, q?.change_pct);
      return [i.symbol, i.exchange, q?.ltp ?? "", q?.change_pct ?? "", abs ?? ""].join(",");
    }).join("\n");
    const blob = new Blob([header + body], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${listName.replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const manualRefresh = async () => {
    setRefreshing(true);
    try { await refetchQuotes(); } finally { setRefreshing(false); }
  };

  // ---- keyboard shortcuts --------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const inField = tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable);
      if (inField) return;
      if (e.key === "/") {
        e.preventDefault();
        setShowFilter(true);
        setTimeout(() => filterInputRef.current?.focus(), 0);
      } else if (e.key.toLowerCase() === "n" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setCreatingList(true);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const idx = lists.findIndex((l) => l.id === activeId);
        if (idx < 0) return;
        const nx = (idx + (e.key === "ArrowRight" ? 1 : -1) + lists.length) % lists.length;
        setActiveId(lists[nx].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lists, activeId, setActiveId]);

  // ---- render --------------------------------------------------------------

  const activeList = lists.find((l) => l.id === activeId);

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
      <Btn size="sm" onClick={() => setShowFilter((v) => !v)} title="filter (/)" aria-label="Filter symbols">
        <Search size={11} />
      </Btn>
      <Btn size="sm" onClick={exportCsv} disabled={items.length === 0} title="Export CSV" aria-label="Export watchlist as CSV">
        <Download size={11} />
      </Btn>
      <Btn size="sm" onClick={manualRefresh} disabled={refreshing || items.length === 0} title="refresh quotes" aria-label="Refresh quotes">
        <RefreshCw size={11} />
      </Btn>
      {onSettings && (
        <Btn size="sm" onClick={onSettings} title="settings" aria-label="Watchlist settings"><Settings2 size={11} /></Btn>
      )}
    </div>
  );

  return (
    <HudPanel flow title="Watchlist" actions={headerActions}>
      {items.length > MAX_SUBSCRIBE_SYMBOLS && (
        <div style={{ padding: "4px 8px", marginBottom: 6, fontSize: 11,
          border: "1px solid var(--warn, #d97706)", color: "var(--warn, #d97706)",
          background: "rgba(217,119,6,0.08)", borderRadius: 2 }}>
          Live ticks are capped at {MAX_SUBSCRIBE_SYMBOLS} symbols · {items.length - MAX_SUBSCRIBE_SYMBOLS} symbol{items.length - MAX_SUBSCRIBE_SYMBOLS === 1 ? "" : "s"} will fall back to REST polling.
        </div>
      )}

      {/* Tabs */}
      <div role="tablist" aria-label="Watchlists"
        style={{ display: "flex", flexWrap: "nowrap", gap: 4, marginBottom: 8,
          borderBottom: "1px solid var(--edge)", paddingBottom: 6, overflowX: "auto" }}>
        {lists.map((l) => {
          const active = l.id === activeId;
          return (
            <button key={l.id} role="tab" aria-selected={active} tabIndex={active ? 0 : -1}
              onClick={() => setActiveId(l.id)}
              style={{
                padding: "3px 8px", fontSize: 11, cursor: "pointer",
                background: active ? "rgba(53,214,237,0.12)" : "transparent",
                color: active ? "var(--accent)" : "var(--text-dim)",
                border: `1px solid ${active ? "var(--accent)" : "var(--edge)"}`,
                borderRadius: 2, display: "inline-flex", alignItems: "center", gap: 4,
                whiteSpace: "nowrap", flexShrink: 0,
              }}
              title={l.name}
            >
              <span>{l.name}</span>
              {active && (
                <>
                  <button type="button" aria-label={`Rename ${l.name}`}
                    onClick={(e) => { e.stopPropagation(); setRenaming(l); setRenameValue(l.name); }}
                    style={{ background: "transparent", border: "none", padding: 0, color: "inherit", opacity: 0.7, cursor: "pointer", display: "inline-flex" }}>
                    <Pencil size={9} />
                  </button>
                  <button type="button" aria-label={`Delete ${l.name}`}
                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(l); }}
                    style={{ background: "transparent", border: "none", padding: 0, color: "inherit", opacity: 0.7, cursor: "pointer", display: "inline-flex" }}>
                    <Trash2 size={9} />
                  </button>
                </>
              )}
            </button>
          );
        })}
        <button onClick={() => setCreatingList(true)} aria-label="New watchlist"
          style={{ padding: "3px 8px", fontSize: 11, cursor: "pointer",
            background: "transparent", color: "var(--text-muted)",
            border: "1px dashed var(--edge)", borderRadius: 2, whiteSpace: "nowrap", flexShrink: 0 }}
          title="new watchlist (n)"
        >+ new</button>
      </div>

      {/* Filter + sort strip */}
      {(showFilter || filter) && (
        <div style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
          <input
            ref={filterInputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter symbols…"
            aria-label="Filter symbols"
            style={{
              flex: 1, padding: "3px 6px", fontSize: 11, background: "transparent",
              color: "var(--text)", border: "1px solid var(--edge)", borderRadius: 2, outline: "none",
            }}
          />
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort by"
            style={{ padding: "3px 6px", fontSize: 11, background: "transparent", color: "var(--text-dim)", border: "1px solid var(--edge)", borderRadius: 2 }}>
            <option value="manual">Manual</option>
            <option value="symbol">A-Z</option>
            <option value="ltp">LTP ↓</option>
            <option value="chg">1D% ↓</option>
          </select>
        </div>
      )}

      {loading ? (
        <div className="hud-label" style={{ fontSize: 11, color: "var(--text-muted)" }}>loading…</div>
      ) : rows.length === 0 ? (
        <div className="hud-label" style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {items.length === 0
            ? (activeList ? `no symbols in ${activeList.name} — search above` : "select a list")
            : "no symbols match the filter"}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minHeight: 0, overflowY: "auto" }}>
          {rows.map((i) => {
            const q = quotes[quoteKey(i.exchange, i.symbol)];
            const abs = q?.day_change ?? (q?.ltp != null && q?.previous_close != null
              ? q.ltp - q.previous_close
              : deriveChangeAbs(q?.ltp, q?.change_pct));
            return (
              <div
                key={i.id}
                ref={(el) => { rowRefs.current[i.id] = el; }}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeItem(i.id); }
                }}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 2px", borderBottom: "1px solid var(--edge)", fontSize: 12, outline: "none" }}
              >
                <Link to={`/market/analysis/${i.symbol}?exchange=${i.exchange}`}
                  style={{ color: "var(--accent)", textDecoration: "none" }}
                  aria-label={`Open ${i.symbol} on ${i.exchange}`}>
                  {i.symbol} <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{i.exchange}</span>
                </Link>
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
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
                    <Return1DCell abs={abs} pct={q?.change_pct ?? null} />
                  </span>
                  {q?.stale && <span style={{ fontSize: 9, color: "var(--warn)" }} aria-label="stale price">stale</span>}
                  {sort === "manual" && !filter && (
                    <>
                      <button onClick={() => reorder(i.id, -1)} className="hud-btn" data-variant="ghost" data-size="sm" aria-label={`Move ${i.symbol} up`} title="move up"><ArrowUp size={10} /></button>
                      <button onClick={() => reorder(i.id, 1)} className="hud-btn" data-variant="ghost" data-size="sm" aria-label={`Move ${i.symbol} down`} title="move down"><ArrowDown size={10} /></button>
                    </>
                  )}
                  <button onClick={() => setTicket({ symbol: i.symbol, exchange: i.exchange as "NSE" | "BSE", side: "BUY" })} className="hud-btn" data-variant="ghost" data-size="sm" aria-label={`Buy ${i.symbol}`} title="Buy"><ShoppingCart size={11} /></button>
                  <button onClick={() => setTicket({ symbol: i.symbol, exchange: i.exchange as "NSE" | "BSE", side: "SELL" })} className="hud-btn" data-variant="ghost" data-size="sm" aria-label={`Sell ${i.symbol}`} title="Sell"><TrendingDown size={11} /></button>
                  <Link to={`/market/analysis/${i.symbol}?exchange=${i.exchange}#alerts`} className="hud-btn" data-variant="ghost" data-size="sm" aria-label={`Alerts for ${i.symbol}`} title="Alerts" style={{ display: "inline-flex" }}><Bell size={11} /></Link>
                  <button onClick={() => removeItem(i.id)} className="hud-btn" data-variant="ghost" data-size="sm" aria-label={`Remove ${i.symbol}`} title="Remove"><Trash2 size={11} /></button>
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

      <HudModal open={creatingList} onClose={() => setCreatingList(false)} title="New watchlist"
        footer={
          <>
            <Btn size="sm" onClick={() => setCreatingList(false)}>Cancel</Btn>
            <Btn size="sm" onClick={submitCreateList} disabled={!newListName.trim()}>Create</Btn>
          </>
        }>
        <input autoFocus value={newListName} onChange={(e) => setNewListName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submitCreateList(); }}
          placeholder={`Watchlist ${lists.length + 1}`}
          style={{ width: "100%", padding: "6px 8px", background: "transparent", color: "var(--text)", border: "1px solid var(--edge)", borderRadius: 2, outline: "none" }} />
      </HudModal>

      <HudModal open={renaming !== null} onClose={() => setRenaming(null)} title="Rename watchlist"
        footer={
          <>
            <Btn size="sm" onClick={() => setRenaming(null)}>Cancel</Btn>
            <Btn size="sm" onClick={submitRename} disabled={!renameValue.trim()}>Save</Btn>
          </>
        }>
        <input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submitRename(); }}
          style={{ width: "100%", padding: "6px 8px", background: "transparent", color: "var(--text)", border: "1px solid var(--edge)", borderRadius: 2, outline: "none" }} />
      </HudModal>

      <HudModal open={confirmDelete !== null} onClose={() => setConfirmDelete(null)} title="Delete watchlist"
        footer={
          <>
            <Btn size="sm" onClick={() => setConfirmDelete(null)}>Cancel</Btn>
            <Btn size="sm" onClick={submitDelete}>Delete</Btn>
          </>
        }>
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
          Delete <b style={{ color: "var(--text)" }}>{confirmDelete?.name}</b> and all its symbols? This can't be undone.
        </div>
      </HudModal>
    </HudPanel>
  );
}
