// Watchlist widget for the Overview dashboard.
// Multi-list: users get up to N named lists (tabs below the header). The
// symbol search sits inline in the panel header, so no vertical space is
// spent on a separate row.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useUi } from "@/store/uiStore";
import { ArrowDown, ArrowUp, ArrowUpDown, Pencil, ShoppingCart, Trash2 } from "lucide-react";
import { SymbolSearchInput, type SymbolOption } from "@/components/market/SymbolSearchInput";
import { quoteKey } from "@/lib/market/pnl";
import { useQuotes } from "@/lib/market/hooks";
import { mergeLiveQuotes, useLiveTickStore, useTicksRevision} from "@/lib/market/liveTickStore";
import { subscribeSymbolsForTicks } from "@/lib/market/useRealtimeTicks";
import type { Quote } from "@/lib/market/types";
import { OrderTicket } from "@/components/market/OrderTicket";
import { currentUserId } from "@/lib/useSession";

type SortMode = "manual" | "symbol" | "price-desc" | "price-asc" | "return-desc" | "return-asc";
const SORT_KEY_PREFIX = "market.watchlist.sort.";
const SORT_OPTIONS: Array<{ mode: SortMode; label: string }> = [
  { mode: "manual", label: "Manual" },
  { mode: "symbol", label: "Symbol A→Z" },
  { mode: "price-desc", label: "Price ↓" },
  { mode: "price-asc", label: "Price ↑" },
  { mode: "return-desc", label: "1D Return ↓" },
  { mode: "return-asc", label: "1D Return ↑" },
];
const LEGACY_SORT_MAP: Record<string, SortMode> = {
  changeDesc: "return-desc",
  changeAsc: "return-asc",
};

type Item = { id: string; watchlist_id: string; symbol: string; exchange: string };
type List = { id: string; name: string };

const ACTIVE_KEY = "market.watchlist.activeId";
const MIN_LISTS = 1;

export function WatchlistPanel({
  readyCount, nearCount, weakCount,
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
  const [sortOpen, setSortOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);

  const loadLists = async () => {
    const uid = await currentUserId();
    if (!uid) { setLoading(false); return; }
    const { data: wl, error } = await supabase.from("market_watchlists")
      .select("id,name").order("created_at", { ascending: true });
    if (error) { push(error.message, "err"); setLoading(false); return; }
    let rows = (wl ?? []) as List[];
    if (rows.length < MIN_LISTS) {
      const toCreate: Array<{ user_id: string; name: string }> = [
        { user_id: uid, name: "Default" },
      ];
      const { data: inserted, error: e2 } = await supabase.from("market_watchlists")
        .insert(toCreate as any).select("id,name");
      if (e2) { push(e2.message, "err"); }
      else rows = [...rows, ...((inserted ?? []) as List[])];
    }
    setLists(rows);
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
  const { data: quotesData, dataUpdatedAt: quotesUpdatedAt, isError: quotesError } = useQuotes(quoteKeys);
  const [sortMode, setSortMode] = useState<SortMode>("manual");
  useEffect(() => {
    if (!activeId) return;
    const stored = localStorage.getItem(SORT_KEY_PREFIX + activeId);
    if (!stored) { setSortMode("manual"); return; }
    const migrated = LEGACY_SORT_MAP[stored] ?? stored;
    const valid = SORT_OPTIONS.some((o) => o.mode === migrated);
    setSortMode(valid ? (migrated as SortMode) : "manual");
  }, [activeId]);

  const selectSort = (m: SortMode) => {
    setSortMode(m);
    if (activeId) localStorage.setItem(SORT_KEY_PREFIX + activeId, m);
    setSortOpen(false);
  };

  // Close sort menu on outside click / Escape.
  useEffect(() => {
    if (!sortOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!sortMenuRef.current) return;
      if (!sortMenuRef.current.contains(e.target as Node)) setSortOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSortOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [sortOpen]);

  const restQuotes = useMemo(() => {
    const map: Record<string, Quote> = {};
    for (const q of quotesData?.quotes ?? []) map[quoteKey(q.exchange, q.symbol)] = q;
    return map;
  }, [quotesData]);
  const _ticksRev_liveTicks = useTicksRevision();
  const liveTicks = useLiveTickStore.getState().ticks;
  void _ticksRev_liveTicks; // re-render on any tick flush; read fresh map above
  const quotes = useMemo(() => mergeLiveQuotes(restQuotes, liveTicks, quotesUpdatedAt), [restQuotes, liveTicks, quotesUpdatedAt]);
  const batchProvider = quotesData?.provider ?? null;

  const addVerified = async (opt: SymbolOption) => {
    if (!activeId) return;
    setAdding(true);
    try {
      const uid = await currentUserId();
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
    const { error } = await supabase.from("market_watchlist_items").delete().eq("id", id);
    if (error) { push(error.message, "err"); return; }
    await loadItems(activeId);
  };

  const addList = async () => {
    const name = window.prompt("Name this watchlist:", `Watchlist ${lists.length + 1}`)?.trim();
    if (!name) return;
    const uid = await currentUserId();
    if (!uid) return;
    const { data, error } = await supabase.from("market_watchlists")
      .insert({ user_id: uid, name } as any).select("id,name").single();
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

  const activeSort = SORT_OPTIONS.find((o) => o.mode === sortMode) ?? SORT_OPTIONS[0];
  const sortIcon = sortMode.endsWith("-desc") ? <ArrowDown size={11} />
    : sortMode.endsWith("-asc") ? <ArrowUp size={11} />
    : <ArrowUpDown size={11} />;

  // Compact input override for the header search — cuts the input from the
  // default HUD height (~30px) down to ~22px so it aligns with the small
  // buttons next to it.
  const compactSearchStyle: React.CSSProperties = {
    height: 22, padding: "0 6px", fontSize: 11, lineHeight: "22px",
  };

  const headerActions = (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, justifyContent: "flex-end" }}>
      <div style={{ width: 150 }}>
        <SymbolSearchInput value={newSym} onChange={setNewSym}
          placeholder={adding ? "adding…" : "add symbol…"}
          onSelect={addVerified} disabled={adding || !activeId}
          inputStyle={compactSearchStyle} />
      </div>
      {(readyCount != null || nearCount != null || weakCount != null) && (
        <div style={{ display: "flex", gap: 3 }}>
          {readyCount ? <Chip tone="ok">{readyCount} ready</Chip> : null}
          {nearCount ? <Chip tone="warn">{nearCount} near</Chip> : null}
          {weakCount ? <Chip tone="err">{weakCount} weak</Chip> : null}
        </div>
      )}
      {quotesError && <Chip tone="warn">stale</Chip>}
      <div ref={sortMenuRef} style={{ position: "relative" }}>
        <Btn size="sm" onClick={() => setSortOpen((v) => !v)} title={`Sort: ${activeSort.label}`}>
          {sortIcon}
        </Btn>
        {sortOpen && (
          <div
            className="hud-scroll"
            style={{
              position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 100,
              background: "var(--bg)", border: "1px solid var(--edge-strong)",
              minWidth: 150, padding: 4,
            }}
          >
            {SORT_OPTIONS.map((o) => (
              <div key={o.mode}
                onClick={() => selectSort(o.mode)}
                style={{
                  padding: "5px 8px", fontSize: 11, cursor: "pointer",
                  background: o.mode === sortMode ? "rgba(53,214,237,0.12)" : "transparent",
                  color: o.mode === sortMode ? "var(--accent)" : "var(--text)",
                }}
              >
                {o.label}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const activeList = lists.find((l) => l.id === activeId);

  const sortedItems = useMemo(() => {
    if (sortMode === "manual") return items;
    const q = (it: Item) => quotes[quoteKey(it.exchange, it.symbol)];
    const changeOf = (it: Item) => {
      const x = q(it);
      if (x?.change_pct != null) return x.change_pct;
      if (x?.ltp != null && x?.previous_close != null && x.previous_close !== 0)
        return ((x.ltp - x.previous_close) / x.previous_close) * 100;
      return null;
    };
    const priceOf = (it: Item) => q(it)?.ltp ?? null;
    const arr = [...items];
    if (sortMode === "symbol") { arr.sort((a, b) => a.symbol.localeCompare(b.symbol)); return arr; }
    const isPrice = sortMode.startsWith("price");
    const dir = sortMode.endsWith("-desc") ? -1 : 1;
    const value = isPrice ? priceOf : changeOf;
    arr.sort((a, b) => {
      const av = value(a); const bv = value(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    });
    return arr;
  }, [items, quotes, sortMode]);


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
          {sortedItems.map((i) => {
            const q = quotes[quoteKey(i.exchange, i.symbol)];
            const abs = q?.day_change ?? (q?.ltp != null && q?.previous_close != null ? q.ltp - q.previous_close : null);
            const pct = q?.change_pct ?? (q?.ltp != null && q?.previous_close != null && q.previous_close !== 0
              ? ((q.ltp - q.previous_close) / q.previous_close) * 100 : null);
            const changeColor = abs == null ? "var(--text-muted)" : abs > 0 ? "var(--ok, #10b981)" : abs < 0 ? "var(--err, #ef4444)" : "var(--text-dim)";
            const sign = (n: number) => (n > 0 ? "+" : "");
            // Prefer the batch-level provider summary (which reflects the
            // active read provider) over each row's individual source — the
            // per-row source can be "cache" or "yahoo" even when Kotak is
            // the primary provider and simply doesn't have a token for a
            // specific symbol.
            const providerLabel = q?.source
              ? `via ${q.source}${batchProvider && batchProvider !== q.source ? ` (batch: ${batchProvider})` : ""}`
              : batchProvider ? `via ${batchProvider}` : null;
            const tooltip = [
              q?.previous_close != null
                ? `prev close ₹${q.previous_close.toFixed(2)}${q.previous_close_as_of ? ` (as of ${q.previous_close_as_of})` : ""}`
                : null,
              providerLabel,
            ].filter(Boolean).join(" · ") || undefined;
            return (
              <div key={i.id}
                title={tooltip}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 68px 108px auto",
                  alignItems: "center",
                  gap: 8,
                  padding: "5px 2px",
                  borderBottom: "1px solid var(--edge)",
                  fontSize: 12,
                }}
              >
                <Link to={`/market/analysis/${i.symbol}?exchange=${i.exchange}`}
                  style={{ color: "var(--accent)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {i.symbol} <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{i.exchange}</span>
                </Link>
                <span style={{
                  fontVariantNumeric: "tabular-nums", textAlign: "right",
                  color: "var(--text)",
                }}>
                  {q ? q.ltp.toFixed(2) : "—"}
                </span>
                <span style={{
                  fontVariantNumeric: "tabular-nums", textAlign: "right",
                  color: changeColor, fontSize: 11,
                }}>
                  {abs != null && pct != null
                    ? `${sign(abs)}${abs.toFixed(2)} (${sign(pct)}${pct.toFixed(2)}%)`
                    : "—"}
                </span>
                <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  {q?.stale && <span style={{ fontSize: 9, color: "var(--warn)" }}>stale</span>}
                  <button onClick={() => setTicket({ symbol: i.symbol, exchange: i.exchange as "NSE" | "BSE", side: "BUY" })} className="hud-btn" data-variant="ghost" data-size="sm" title="Buy"><ShoppingCart size={11} /></button>
                  <button onClick={() => removeItem(i.id)} className="hud-btn" data-variant="ghost" data-size="sm" title="Remove"><Trash2 size={11} /></button>
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
