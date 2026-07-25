// Market Holdings — manual CRUD + Kotak sync + live quotes
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { HudPanel } from "@/components/hud/HudPanel";
import { HudModal } from "@/components/hud/HudModal";
import { Btn, Chip, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { Plus, RefreshCw, Trash2, Download, ShoppingCart } from "lucide-react";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { SymbolSearchInput } from "@/components/market/SymbolSearchInput";
import { approxAnnualizedReturnPct, holdingPnl, quoteKey, sumNullable } from "@/lib/market/pnl";
import { useHoldings, useMarketSettings, usePortfolioLastSync, useQuotes, useSyncHoldings } from "@/lib/market/hooks";
import { mergeLiveQuotes, useLiveTickStore } from "@/lib/market/liveTickStore";
import { subscribeSymbolsForTicks } from "@/lib/market/useRealtimeTicks";
import { PriceSourceChip } from "@/components/market/PriceSourceChip";
import { PortfolioAllocation } from "@/components/market/PortfolioAllocation";
import { OrderTicket } from "@/components/market/OrderTicket";

type Holding = {
  id: string; symbol: string; exchange: string; quantity: number; avg_price: number;
  buy_date: string | null; investment_type: string | null; notes: string | null; source: string;
  settled_qty?: number | null; t1_qty?: number | null; pledged_qty?: number | null;
};
type ScoreMap = Record<string, { breakout_score: number | null; prebreakout_score: number | null; score_components: any }>;

const empty = { symbol: "", exchange: "NSE", quantity: "", avg_price: "", buy_date: "", investment_type: "long_term", notes: "" };

export default function Holdings() {
  const push = useUi((s) => s.push);
  const qc = useQueryClient();
  const { data: rows = [] } = useHoldings();
  const { data: settings = [] } = useMarketSettings();
  const { data: lastSyncAt } = usePortfolioLastSync();
  const syncMut = useSyncHoldings();
  const [scores, setScores] = useState<ScoreMap>({});
  const [sectors, setSectors] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ ...empty });
  const [showForm, setShowForm] = useState(false);
  const connected = settings.some((s) => s.active_provider === "kotak_neo" && s.connection_status === "connected");
  const [ticket, setTicket] = useState<{ symbol: string; exchange: "NSE" | "BSE"; side: "BUY" | "SELL"; qty?: number } | null>(null);
  const [deleteHolding, setDeleteHolding] = useState<Holding | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["market", "holdings"] });

  useEffect(() => {
    const data = rows;
    const symbols = [...new Set(data.map((h: any) => h.symbol))];
    let active = true;
    const run = async () => {
    if (symbols.length > 0) {
      // Keyed by symbol:exchange (quoteKey), not bare symbol — a symbol can
      // legitimately exist on both NSE and BSE with different rows in these
      // tables; a bare-symbol key let a BSE holding silently pick up the
      // NSE row's sector/score (or vice versa) whichever was iterated last.
      const [{ data: sc }, { data: st2 }] = await Promise.all([
        supabase.from("market_stock_scores")
          .select("symbol,exchange,breakout_score,prebreakout_score,score_components")
          .in("symbol", symbols),
        supabase.from("market_stocks").select("symbol,exchange,sector").in("symbol", symbols),
      ]);
      if (!active) return;
      const map: ScoreMap = {};
      for (const s of (sc ?? []) as any[]) map[quoteKey(s.exchange, s.symbol)] = s;
      setScores(map);
      const secMap: Record<string, string | null> = {};
      for (const s of (st2 ?? []) as any[]) secMap[quoteKey(s.exchange, s.symbol)] = s.sector ?? null;
      setSectors(secMap);
    } else { setScores({}); setSectors({}); }
    };
    run();
    return () => { active = false; };
  }, [rows]);

  // Live quotes: same shared 1s market-hours hook every other page uses.
  const quoteKeys = useMemo(() => rows.map((h) => `${h.exchange}:${h.symbol}`), [rows]);
  useEffect(() => { subscribeSymbolsForTicks(quoteKeys); }, [quoteKeys]);
  const { data: quotesData, isFetching: quotesFetching, refetch: refetchQuotes } = useQuotes(quoteKeys);
  const restQuotes = useMemo(() => {
    const map: Record<string, import("@/lib/market/types").Quote> = {};
    for (const q of quotesData?.quotes ?? []) map[quoteKey(q.exchange, q.symbol)] = q;
    return map;
  }, [quotesData]);
  const liveTicks = useLiveTickStore((s) => s.ticks);
  const quotes = useMemo(() => mergeLiveQuotes(restQuotes, liveTicks), [restQuotes, liveTicks]);

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
    invalidate();
  };

  const remove = async (row: Holding) => {
    const { error } = await supabase.from("market_holdings").delete().eq("id", row.id);
    if (error) { push(error.message, "err"); return; }
    push(`Deleted ${row.symbol}`, "ok");
    setDeleteHolding(null);
    invalidate();
  };

  const sync = async () => {
    setBusy("sync");
    syncMut.mutate(undefined, {
      onSuccess: (r) => {
        push(`Kotak sync: ${r?.inserted ?? 0} new, ${r?.updated ?? 0} updated${r?.removed ? `, ${r.removed} removed` : ""}`, "ok");
        setBusy(null);
      },
      onError: (e) => { push(toSafeError(e, "Sync failed").message, "err"); setBusy(null); },
    });
  };

  const totals = useMemo(() => {
    // A holding with no resolvable live price is excluded from current/P&L
    // (unknown, not zero) — `invested` uses the same resolved-only basis
    // (knownInvested) so Current − Invested always equals the displayed P&L;
    // previously `invested` summed every holding unconditionally while
    // current/P&L excluded unresolved ones, so the three numbers on screen
    // could silently disagree whenever some (not all) holdings lacked a quote.
    let current = 0, knownInvested = 0, unresolved = 0;
    const dayPnls: Array<number | null> = [];
    for (const h of rows) {
      const calc = holdingPnl({ quantity: h.quantity, avgPrice: h.avg_price, quote: quotes[quoteKey(h.exchange, h.symbol)] });
      if (calc.current == null) { unresolved++; continue; }
      knownInvested += calc.invested;
      current += calc.current;
      dayPnls.push(calc.todayPnl);
    }
    const dayPnl = sumNullable(dayPnls);
    const prevValue = dayPnl == null ? null : current - dayPnl;
    const dayPnlPct = dayPnl == null || !prevValue ? null : (dayPnl / Math.abs(prevValue)) * 100;
    const allUnresolved = rows.length > 0 && unresolved === rows.length;
    const pnl = allUnresolved ? null : current - knownInvested;
    const pnlPct = pnl == null ? null : knownInvested ? (pnl / Math.abs(knownInvested)) * 100 : null;
    return {
      invested: allUnresolved ? null : knownInvested,
      current: allUnresolved ? null : current,
      pnl, pnlPct, dayPnl, dayPnlPct, unresolved,
    };
  }, [rows, quotes]);

  const allocationInput = useMemo(
    () => rows.map((h) => ({
      symbol: h.symbol,
      exchange: h.exchange,
      currentValue: holdingPnl({ quantity: h.quantity, avgPrice: h.avg_price, quote: quotes[quoteKey(h.exchange, h.symbol)] }).current ?? 0,
    })),
    [rows, quotes],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel flow title="Portfolio Summary" index="MK.H1" actions={
        <div style={{ display: "flex", gap: 6 }}>
          <Btn size="sm" onClick={() => refetchQuotes()} disabled={busy !== null}>
            <RefreshCw size={11} style={{ marginRight: 4 }} /> {quotesFetching ? "refreshing…" : "refresh quotes"}
          </Btn>
          {connected && (
            <Btn size="sm" onClick={sync} disabled={busy !== null}>
              <Download size={11} style={{ marginRight: 4 }} /> {busy === "sync" ? "syncing…" : "sync from Kotak"}
            </Btn>
          )}
        </div>
      }>
        {lastSyncAt && <div className="hud-label" style={{ color: "var(--text-dim)", marginBottom: 8 }}>Last synced {new Date(lastSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
          <Stat label="Invested" value={totals.invested == null ? "—" : inr(totals.invested)} />
          <Stat label="Current Value" value={totals.current == null ? "—" : inr(totals.current)} />
          <Stat label="Total P&L" value={totals.pnl == null ? "—" : inr(totals.pnl)} tone={totals.pnl == null ? undefined : totals.pnl >= 0 ? "ok" : "err"} />
          <Stat label="Return %" value={totals.pnlPct == null ? "—" : `${totals.pnlPct.toFixed(2)}%`} tone={totals.pnlPct == null ? undefined : totals.pnlPct >= 0 ? "ok" : "err"} />
          <Stat
            label="Today's P&L"
            value={totals.dayPnl == null ? "—" : `${inr(totals.dayPnl)}${totals.dayPnlPct != null ? ` (${totals.dayPnlPct >= 0 ? "+" : ""}${totals.dayPnlPct.toFixed(2)}%)` : ""}`}
            tone={totals.dayPnl == null ? undefined : totals.dayPnl >= 0 ? "ok" : "err"}
          />
          <Stat label="Holdings" value={rows.length.toString()} />
        </div>
      </HudPanel>

      {rows.length > 0 && (
        <HudPanel flow title="Sector Allocation" index="MK.H1B">
          <PortfolioAllocation holdings={allocationInput} sectorBySymbol={sectors} />
        </HudPanel>
      )}

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
            <div>
              <div style={labelStyle}>Symbol</div>
              <SymbolSearchInput value={form.symbol} onChange={(v) => setForm({ ...form, symbol: v })}
                onSelect={(o) => setForm({ ...form, symbol: o.symbol, exchange: o.exchange })}
                placeholder="RELIANCE" />
            </div>
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
                {["Symbol", "Qty", "Avg Buy", "LTP", "Invested", "Current", "P&L", "P&L %", "Today", "Today %", "Ann. Return*", "Breakout", "Source", ""].map((h) => (
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
                      <Link to={`/market/analysis/${h.symbol}?exchange=${h.exchange}`} style={{ color: "var(--accent)", textDecoration: "none" }}>{h.symbol}</Link>
                      <span style={{ color: "var(--text-dim)", marginLeft: 4, fontSize: 10 }}>{h.exchange}</span>
                    </td>
                    <td style={td} title={`Settled: ${h.settled_qty ?? "—"}, T1: ${h.t1_qty ?? "—"}, pledged: ${h.pledged_qty ?? "—"}`}>
                      {h.quantity}
                      {(h.t1_qty || h.pledged_qty) ? <div className="hud-label" style={{ color: "var(--text-dim)", fontSize: 9 }}>T1 {h.t1_qty ?? 0} · Pledged {h.pledged_qty ?? 0}</div> : null}
                    </td>
                    <td style={td}>{Number(h.avg_price).toFixed(2)}</td>
                    <td style={td}>{calc.ltp != null ? calc.ltp.toFixed(2) : "—"}</td>
                    <td style={td}>{inr(calc.invested)}</td>
                    <td style={td}>{calc.current == null ? "—" : inr(calc.current)}</td>
                    <td style={{ ...td, color: calc.totalPnl == null ? "var(--text-dim)" : calc.totalPnl >= 0 ? "var(--ok)" : "var(--danger)" }}>{calc.totalPnl == null ? "—" : inr(calc.totalPnl)}</td>
                    <td style={{ ...td, color: calc.totalPnlPct == null ? "var(--text-dim)" : calc.totalPnlPct >= 0 ? "var(--ok)" : "var(--danger)" }}>{calc.totalPnlPct == null ? "—" : `${calc.totalPnlPct.toFixed(2)}%`}</td>
                    <td style={{ ...td, color: (calc.todayPnl ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }} title={q?.stale ? "Quote is stale; today's P&L unavailable" : undefined}>{calc.todayPnl == null ? "—" : inr(calc.todayPnl)}</td>
                    <td style={{ ...td, color: (calc.todayPnlPct ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}>{calc.todayPnlPct == null ? "—" : `${calc.todayPnlPct.toFixed(2)}%`}</td>
                    <td style={td} title="Approximate — assumes a single lump-sum buy on Buy Date, not a true XIRR">
                      {(() => {
                        const ann = calc.totalPnlPct == null ? null : approxAnnualizedReturnPct(calc.totalPnlPct, h.buy_date);
                        return ann == null ? "—" : `${ann >= 0 ? "+" : ""}${ann.toFixed(1)}%`;
                      })()}
                    </td>
                    <td style={td}>
                      <ScoreBadge score={scores[quoteKey(h.exchange, h.symbol)]?.breakout_score} components={scores[quoteKey(h.exchange, h.symbol)]?.score_components?.breakout} label="breakout components" />
                    </td>
                    <td style={td}><Chip tone={q?.stale ? "warn" : h.source === "manual" ? "neutral" : "accent"}>{q?.stale ? "stale" : h.source}</Chip></td>
                    <td style={td}>
                      <span style={{ display: "inline-flex", gap: 4 }}>
                        {connected && (
                          <>
                            <button onClick={() => setTicket({ symbol: h.symbol, exchange: h.exchange as "NSE" | "BSE", side: "BUY" })} className="hud-btn" data-variant="ghost" data-size="sm" title="Buy more"><ShoppingCart size={11} /></button>
                            <button onClick={() => setTicket({ symbol: h.symbol, exchange: h.exchange as "NSE" | "BSE", side: "SELL", qty: h.quantity })} className="hud-btn" data-variant="ghost" data-size="sm" title="Sell" style={{ color: "var(--danger)" }}>S</button>
                          </>
                        )}
                        <button onClick={() => setDeleteHolding(h)} className="hud-btn" data-variant="ghost" data-size="sm" title="Delete">
                          <Trash2 size={11} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={14} style={{ padding: 20, textAlign: "center", color: "var(--text-dim)" }}>No holdings yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {rows.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 10, color: "var(--text-muted)" }}>
            * Approximate annualized return since Buy Date — a single lump-sum estimate, not a true XIRR (would need per-lot buy history).
          </div>
        )}
      </HudPanel>
      {ticket && (
        <OrderTicket open={ticket !== null} onClose={() => setTicket(null)}
          symbol={ticket.symbol} exchange={ticket.exchange} side={ticket.side} defaultQty={ticket.qty} />
      )}
      {deleteHolding && (
        <HudModal open={deleteHolding !== null} onClose={() => setDeleteHolding(null)} title="Delete holding" footer={<><Btn onClick={() => setDeleteHolding(null)}>cancel</Btn><Btn variant="danger" onClick={() => remove(deleteHolding)}>delete</Btn></>}>
          <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>Delete {deleteHolding.symbol}? Broker-synced holdings can return on the next Kotak sync if still held.</div>
        </HudModal>
      )}
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
