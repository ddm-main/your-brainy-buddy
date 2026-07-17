// Market Watchlist — multiple lists, add symbols, live quotes
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { supabase, SAFE_SUPABASE_URL } from "@/integrations/supabase/client";
import { authFetch } from "@/lib/authFetch";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { Plus, RefreshCw, Trash2 } from "lucide-react";

type Watchlist = { id: string; name: string; color: string | null };
type Item = { id: string; watchlist_id: string; symbol: string; exchange: string; priority: number | null; notes: string | null; tags: string[] | null };
type QuoteMap = Record<string, { ltp: number; change_pct: number | null }>;

export default function Watchlist() {
  const push = useUi((s) => s.push);
  const [lists, setLists] = useState<Watchlist[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [quotes, setQuotes] = useState<QuoteMap>({});
  const [active, setActive] = useState<string | null>(null);
  const [newList, setNewList] = useState("");
  const [newSym, setNewSym] = useState("");
  const [newEx, setNewEx] = useState("NSE");
  const [busy, setBusy] = useState<string | null>(null);

  const callFn = async (name: string, body: Record<string, unknown> = {}) => {
    const url = `${SAFE_SUPABASE_URL}/functions/v1/${name}`;
    const r = await authFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error ?? r.statusText);
    return j;
  };

  const load = async () => {
    const [{ data: wl, error: e1 }, { data: it, error: e2 }] = await Promise.all([
      supabase.from("market_watchlists").select("*").order("created_at", { ascending: true }),
      supabase.from("market_watchlist_items").select("*").order("priority", { ascending: false }),
    ]);
    if (e1) push(e1.message, "err");
    if (e2) push(e2.message, "err");
    const l = (wl ?? []) as Watchlist[];
    setLists(l);
    setItems((it ?? []) as Item[]);
    if (!active && l.length) setActive(l[0].id);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const activeItems = useMemo(() => items.filter((i) => i.watchlist_id === active), [items, active]);

  const refreshQuotes = async () => {
    if (activeItems.length === 0) return;
    setBusy("quotes");
    try {
      const symbols = activeItems.map((i) => `${i.exchange}:${i.symbol}`);
      const r = await callFn("market-quotes", { symbols });
      const map: QuoteMap = {};
      for (const q of r?.quotes ?? []) map[`${q.exchange}:${q.symbol}`] = { ltp: q.ltp, change_pct: q.change_pct };
      setQuotes(map);
    } catch (e) { push(toSafeError(e, "Quotes failed").message, "err"); }
    finally { setBusy(null); }
  };
  useEffect(() => { if (activeItems.length) refreshQuotes(); /* eslint-disable-next-line */ }, [active, activeItems.length]);

  const createList = async () => {
    if (!newList.trim()) return;
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    const { data, error } = await supabase.from("market_watchlists")
      .insert({ name: newList.trim(), user_id: u.user.id } as any).select().single();
    if (error) { push(error.message, "err"); return; }
    setNewList("");
    await load();
    setActive((data as any).id);
  };

  const deleteList = async (id: string) => {
    if (!confirm("Delete this watchlist and all its items?")) return;
    const { error } = await supabase.from("market_watchlists").delete().eq("id", id);
    if (error) { push(error.message, "err"); return; }
    if (active === id) setActive(null);
    await load();
  };

  const addItem = async () => {
    if (!active || !newSym.trim()) return;
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    const { error } = await supabase.from("market_watchlist_items").insert({
      user_id: u.user.id, watchlist_id: active,
      symbol: newSym.trim().toUpperCase(), exchange: newEx,
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
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel title="Watchlists" index="MK.W1">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          {lists.map((l) => (
            <button key={l.id} onClick={() => setActive(l.id)} className="hud-btn"
              data-variant={active === l.id ? "primary" : "ghost"} data-size="sm">
              {l.name} <span style={{ marginLeft: 6, opacity: 0.6 }}>{items.filter((i) => i.watchlist_id === l.id).length}</span>
            </button>
          ))}
          <input value={newList} onChange={(e) => setNewList(e.target.value)} placeholder="New watchlist name"
            style={{ ...inputStyle, minWidth: 200 }} onKeyDown={(e) => e.key === "Enter" && createList()} />
          <Btn size="sm" onClick={createList}><Plus size={11} /></Btn>
          {active && (
            <Btn size="sm" variant="danger" onClick={() => deleteList(active)}>
              <Trash2 size={11} style={{ marginRight: 4 }} /> delete list
            </Btn>
          )}
        </div>

        {active && (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 12 }}>
              <div style={{ flex: 1, maxWidth: 240 }}>
                <div style={labelStyle}>Symbol</div>
                <input value={newSym} onChange={(e) => setNewSym(e.target.value)} placeholder="RELIANCE"
                  style={inputStyle} onKeyDown={(e) => e.key === "Enter" && addItem()} />
              </div>
              <div style={{ maxWidth: 120 }}>
                <div style={labelStyle}>Exchange</div>
                <select value={newEx} onChange={(e) => setNewEx(e.target.value)} style={{ ...inputStyle, padding: "6px 4px" }}>
                  <option>NSE</option><option>BSE</option>
                </select>
              </div>
              <Btn onClick={addItem}><Plus size={11} style={{ marginRight: 4 }} /> add</Btn>
              <Btn onClick={refreshQuotes} disabled={busy !== null}>
                <RefreshCw size={11} style={{ marginRight: 4 }} /> refresh
              </Btn>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-dim)" }}>
                    {["Symbol", "LTP", "Day %", "Priority", "Notes", ""].map((h) => (
                      <th key={h} style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)", fontWeight: 400, textTransform: "uppercase", letterSpacing: "0.1em", fontSize: 10 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeItems.map((i) => {
                    const q = quotes[`${i.exchange}:${i.symbol}`];
                    return (
                      <tr key={i.id} style={{ borderBottom: "1px solid var(--edge)" }}>
                        <td style={{ padding: "6px 8px" }}>
                          <Link to={`/market/analysis/${i.symbol}`} style={{ color: "var(--accent)", textDecoration: "none" }}>{i.symbol}</Link>
                          <span style={{ color: "var(--text-dim)", marginLeft: 4, fontSize: 10 }}>{i.exchange}</span>
                        </td>
                        <td style={{ padding: "6px 8px" }}>{q ? q.ltp.toFixed(2) : "—"}</td>
                        <td style={{ padding: "6px 8px", color: (q?.change_pct ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}>
                          {q?.change_pct == null ? "—" : `${q.change_pct >= 0 ? "+" : ""}${q.change_pct.toFixed(2)}%`}
                        </td>
                        <td style={{ padding: "6px 8px" }}>{i.priority ?? 0}</td>
                        <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{i.notes ?? ""}</td>
                        <td style={{ padding: "6px 8px" }}>
                          <button onClick={() => removeItem(i.id)} className="hud-btn" data-variant="ghost" data-size="sm"><Trash2 size={11} /></button>
                        </td>
                      </tr>
                    );
                  })}
                  {activeItems.length === 0 && (
                    <tr><td colSpan={6} style={{ padding: 20, textAlign: "center", color: "var(--text-dim)" }}>Empty watchlist — add a symbol above.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {lists.length === 0 && (
          <div style={{ padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>
            No watchlists yet — create one above.
          </div>
        )}
      </HudPanel>
    </div>
  );
}
