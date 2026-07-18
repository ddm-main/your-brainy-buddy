// Market Holdings — manual CRUD + Kotak sync + live quotes
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { supabase, SAFE_SUPABASE_URL } from "@/integrations/supabase/client";
import { authFetch } from "@/lib/authFetch";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { Plus, RefreshCw, Trash2, Download } from "lucide-react";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { holdingPnl, quoteKey, sumNullable } from "@/lib/market/pnl";
import type { Quote } from "@/lib/market/types";

type Holding = {
  id: string; symbol: string; exchange: string; quantity: number; avg_price: number;
  buy_date: string | null; investment_type: string | null; notes: string | null; source: string;
};
type QuoteMap = Record<string, Quote>;
type ScoreMap = Record<string, { breakout_score: number | null; prebreakout_score: number | null; score_components: any }>;

const empty = { symbol: "", exchange: "NSE", quantity: "", avg_price: "", buy_date: "", investment_type: "long_term", notes: "" };

export default function Holdings() {
  const push = useUi((s) => s.push);
  const [rows, setRows] = useState<Holding[]>([]);
  const [quotes, setQuotes] = useState<QuoteMap>({});
  const [scores, setScores] = useState<ScoreMap>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ ...empty });
  const [showForm, setShowForm] = useState(false);
  const [connected, setConnected] = useState<string | null>(null);

  const callFn = async (name: string, body: Record<string, unknown> = {}) => {
    const url = `${SAFE_SUPABASE_URL}/functions/v1/${name}`;
    const r = await authFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error ?? r.statusText);
    return j;
  };

  const load = async () => {
    const [{ data, error }, { data: st }] = await Promise.all([
      supabase.from("market_holdings").select("*").order("created_at", { ascending: false }),
      supabase.from("market_api_settings").select("active_provider,connection_status").eq("connection_status", "connected").limit(1),
    ]);
    if (error) push(error.message, "err");
    setRows((data ?? []) as Holding[]);
    setConnected((st?.[0] as any)?.active_provider ?? null);
    const symbols = [...new Set((data ?? []).map((h: any) => h.symbol))];
    if (symbols.length > 0) {
      const { data: sc } = await supabase.from("market_stock_scores")
        .select("symbol,breakout_score,prebreakout_score,score_components")
        .in("symbol", symbols);
      const map: ScoreMap = {};
      for (const s of (sc ?? []) as any[]) map[s.symbol] = s;
      setScores(map);
    }
  };

  const refreshQuotes = async (holdings: Holding[], opts: { silent?: boolean } = {}) => {
    if (holdings.length === 0) return;
    if (!opts.silent) setBusy("quotes");
    try {
      const symbols = Array.from(new Set(holdings.map((h) => `${h.exchange}:${h.symbol}`)));
      const r = await callFn("market-quotes", { symbols });
      const map: QuoteMap = {};
      for (const q of r?.quotes ?? []) {
        map[quoteKey(q.exchange, q.symbol)] = q;
      }
      setQuotes(map);
    } catch (e) {
      // background polls fail silently — a toast every 30s would be noise
      if (!opts.silent) push(toSafeError(e, "Quotes failed").message, "err");
    } finally { if (!opts.silent) setBusy(null); }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { if (rows.length) refreshQuotes(rows); /* eslint-disable-next-line */ }, [rows.length]);
  // Live-ish quotes: poll every 30s while the tab is visible.
  useEffect(() => {
    if (rows.length === 0) return;
    const id = window.setInterval(() => {
      if (!document.hidden) refreshQuotes(rows, { silent: true });
    }, 30_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line
  }, [rows]);

  const add = async () => {
    if (!form.symbol.trim() || !form.quantity || !form.avg_price) { push("Symbol, quantity, avg price required", "warn"); return; }
    const { data: session } = await supabase.auth.getSession();
    const userId = session.session?.user.id;
    if (!userId) { push("Sign in required", "err"); return; }
    const payload = {
      user_id: userId,
      symbol: form.symbol.trim().toUpperCase(),
      exchange: form.exchange,
      quantity: Number(form.quantity),
      avg_price: Number(form.avg_price),
      buy_date: form.buy_date || null,
      investment_type: form.investment_type || null,
      notes: form.notes || null,
      source: "manual" as const,
    };
    const { error } = await supabase.from("market_holdings").insert(payload as any);
    if (error) { push(error.message, "err"); return; }
    setForm({ ...empty });
    setShowForm(false);
    push("Holding added", "ok");
    await load();
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this holding?")) return;
    const { error } = await supabase.from("market_holdings").delete().eq("id", id);
    if (error) { push(error.message, "err"); return; }
    push("Deleted", "ok");
    await load();
  };

  const sync = async () => {
    setBusy("sync");
    try {
      const r = await callFn("market-sync-holdings", {});
      push(`Kotak sync: ${r?.inserted ?? 0} new, ${r?.updated ?? 0} updated${r?.removed ? `, ${r.removed} removed` : ""}`, "ok");
      await load();
    } catch (e) { push(toSafeError(e, "Sync failed").message, "err"); }
    finally { setBusy(null); }
  };

  const totals = useMemo(() => {
    let invested = 0, current = 0;
    const dayPnls: Array<number | null> = [];
    for (const h of rows) {
      const calc = holdingPnl({ quantity: h.quantity, avgPrice: h.avg_price, quote: quotes[quoteKey(h.exchange, h.symbol)] });
      invested += calc.invested;
      current += calc.current;
      dayPnls.push(calc.todayPnl);
    }
    const dayPnl = sumNullable(dayPnls);
    return { invested, current, pnl: current - invested, pnlPct: invested ? ((current - invested) / invested) * 100 : 0, dayPnl };
  }, [rows, quotes]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel flow title="Portfolio Summary" index="MK.H1" actions={
        <div style={{ display: "flex", gap: 6 }}>
          <Btn size="sm" onClick={() => refreshQuotes(rows)} disabled={busy !== null}>
            <RefreshCw size={11} style={{ marginRight: 4 }} /> refresh quotes
          </Btn>
          {connected === "kotak_neo" && (
            <Btn size="sm" onClick={sync} disabled={busy !== null}>
              <Download size={11} style={{ marginRight: 4 }} /> {busy === "sync" ? "syncing…" : "sync from Kotak"}
            </Btn>
          )}
        </div>
      }>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
          <Stat label="Invested" value={inr(totals.invested)} />
          <Stat label="Current Value" value={inr(totals.current)} />
          <Stat label="Total P&L" value={inr(totals.pnl)} tone={totals.pnl >= 0 ? "ok" : "err"} />
          <Stat label="Return %" value={`${totals.pnlPct.toFixed(2)}%`} tone={totals.pnlPct >= 0 ? "ok" : "err"} />
          <Stat label="Today's P&L" value={totals.dayPnl == null ? "—" : inr(totals.dayPnl)} tone={totals.dayPnl == null ? undefined : totals.dayPnl >= 0 ? "ok" : "err"} />
          <Stat label="Holdings" value={rows.length.toString()} />
        </div>
      </HudPanel>

      <HudPanel flow title="Holdings" index="MK.H2" actions={
        <Btn size="sm" onClick={() => setShowForm((v) => !v)}>
          <Plus size={11} style={{ marginRight: 4 }} /> {showForm ? "cancel" : "add"}
        </Btn>
      }>
        {!connected && rows.length === 0 && (
          <div style={{ padding: 12, border: "1px dashed var(--edge)", fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }}>
            No holdings yet.{" "}
            <Link to="/market/settings" style={{ color: "var(--accent)" }}>Connect Kotak Neo</Link>{" "}
            to auto-sync, or click <b>add</b> to enter manually.
          </div>
        )}

        {showForm && (
          <div style={{ padding: 12, border: "1px solid var(--edge)", marginBottom: 12, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            <Input label="Symbol" value={form.symbol} onChange={(v) => setForm({ ...form, symbol: v })} placeholder="RELIANCE" />
            <Select label="Exchange" value={form.exchange} options={["NSE", "BSE"]} onChange={(v) => setForm({ ...form, exchange: v })} />
            <Input label="Quantity" value={form.quantity} onChange={(v) => setForm({ ...form, quantity: v })} type="number" />
            <Input label="Avg Buy Price" value={form.avg_price} onChange={(v) => setForm({ ...form, avg_price: v })} type="number" />
            <Input label="Buy Date" value={form.buy_date} onChange={(v) => setForm({ ...form, buy_date: v })} type="date" />
            <Select label="Type" value={form.investment_type} options={["long_term", "short_term", "swing", "positional"]} onChange={(v) => setForm({ ...form, investment_type: v })} />
            <Input label="Notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} />
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <Btn onClick={add} variant="primary">Save</Btn>
            </div>
          </div>
        )}

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-dim)" }}>
                {["Symbol", "Qty", "Avg Buy", "LTP", "Invested", "Current", "P&L", "P&L %", "Today", "Breakout", "Source", ""].map((h) => (
                  <th key={h} style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)", fontWeight: 400, textTransform: "uppercase", letterSpacing: "0.1em", fontSize: 10 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => {
                const q = quotes[quoteKey(h.exchange, h.symbol)];
                const calc = holdingPnl({ quantity: h.quantity, avgPrice: h.avg_price, quote: q });
                return (
                  <tr key={h.id} style={{ borderBottom: "1px solid var(--edge)" }}>
                    <td style={td}>
                      <Link to={`/market/analysis/${h.symbol}`} style={{ color: "var(--accent)", textDecoration: "none" }}>{h.symbol}</Link>
                      <span style={{ color: "var(--text-dim)", marginLeft: 4, fontSize: 10 }}>{h.exchange}</span>
                    </td>
                    <td style={td}>{h.quantity}</td>
                    <td style={td}>{Number(h.avg_price).toFixed(2)}</td>
                    <td style={td}>{q?.ltp ? calc.ltp.toFixed(2) : "—"}</td>
                    <td style={td}>{inr(calc.invested)}</td>
                    <td style={td}>{inr(calc.current)}</td>
                    <td style={{ ...td, color: calc.totalPnl >= 0 ? "var(--ok)" : "var(--danger)" }}>{inr(calc.totalPnl)}</td>
                    <td style={{ ...td, color: calc.totalPnlPct >= 0 ? "var(--ok)" : "var(--danger)" }}>{calc.totalPnlPct.toFixed(2)}%</td>
                    <td style={{ ...td, color: (calc.todayPnl ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }} title={q?.stale ? "Quote is stale; today's P&L unavailable" : undefined}>{calc.todayPnl == null ? "—" : inr(calc.todayPnl)}</td>
                    <td style={td}>
                      <ScoreBadge score={scores[h.symbol]?.breakout_score} components={scores[h.symbol]?.score_components?.breakout} label="breakout components" />
                    </td>
                    <td style={td}><Chip tone={q?.stale ? "warn" : h.source === "manual" ? "neutral" : "accent"}>{q?.stale ? "stale" : h.source}</Chip></td>
                    <td style={td}>
                      <button onClick={() => remove(h.id)} className="hud-btn" data-variant="ghost" data-size="sm" title="Delete">
                        <Trash2 size={11} />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={12} style={{ padding: 20, textAlign: "center", color: "var(--text-dim)" }}>No holdings yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </HudPanel>
    </div>
  );
}

const td: React.CSSProperties = { padding: "6px 8px", verticalAlign: "middle" };
function inr(n: number): string { return `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "err" }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--danger)" : "var(--accent)";
  return (
    <div style={{ padding: 10, border: "1px solid var(--edge)" }}>
      <div className="hud-label" style={{ color: "var(--text-dim)" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 20, color }}>{value}</div>
    </div>
  );
}
function Input({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} type={type} style={{ ...inputStyle, width: "100%" }} />
    </div>
  );
}
function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, width: "100%" }}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}
