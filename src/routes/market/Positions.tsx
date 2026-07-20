// Market Positions — active trades: broker sync + manual journal + live P&L.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { DataTable, fmtNum, PctCell } from "@/components/hud/DataTable";
import { supabase } from "@/integrations/supabase/client";
import { useMarketSettings, usePositions, useQuotes, useSyncPositions } from "@/lib/market/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { Download, Plus, Trash2, X } from "lucide-react";
import type { Position, Quote } from "@/lib/market/types";
import { positionPnl, quoteKey, sumNullable } from "@/lib/market/pnl";
import { isFreshTick, useLiveTickStore } from "@/lib/market/liveTickStore";

const emptyForm = { symbol: "", exchange: "NSE", side: "long", quantity: "", entry_price: "", stop_loss: "", target: "", journal_notes: "" };

export default function Positions() {
  const push = useUi((s) => s.push);
  const qc = useQueryClient();
  const { data: positions = [], isLoading } = usePositions();
  const { data: settings = [] } = useMarketSettings();
  const syncMut = useSyncPositions();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });

  const open = useMemo(() => positions.filter((p) => !p.closed_at), [positions]);
  const closed = useMemo(() => positions.filter((p) => p.closed_at), [positions]);
  const keys = useMemo(() => [...new Set(open.map((p) => `${p.exchange}:${p.symbol}`))], [open]);
  const { data: quotesData } = useQuotes(keys);
  const liveTicks = useLiveTickStore((s) => s.ticks);
  const quoteMap = useMemo(() => {
    const m = new Map<string, Quote>();
    for (const q of quotesData?.quotes ?? []) m.set(quoteKey(q.exchange, q.symbol), q);
    for (const [key, tick] of Object.entries(liveTicks)) {
      if (!isFreshTick(tick)) continue;
      const base = m.get(key);
      m.set(key, base ? { ...base, ltp: tick.ltp, change_pct: tick.change_pct } : ({ ltp: tick.ltp, change_pct: tick.change_pct } as Quote));
    }
    return m;
  }, [quotesData, liveTicks]);

  const connected = settings.some((s) => s.active_provider === "kotak_neo" && s.connection_status === "connected");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["market", "positions"] });

  const add = async () => {
    if (!form.symbol.trim() || !form.quantity || !form.entry_price) {
      push("Symbol, quantity, entry price required", "warn");
      return;
    }
    const { data: session } = await supabase.auth.getSession();
    const userId = session.session?.user.id;
    if (!userId) { push("Sign in required", "err"); return; }
    const { error } = await supabase.from("market_positions").insert({
      user_id: userId,
      symbol: form.symbol.trim().toUpperCase(),
      exchange: form.exchange,
      side: form.side,
      quantity: Number(form.quantity),
      entry_price: Number(form.entry_price),
      stop_loss: form.stop_loss ? Number(form.stop_loss) : null,
      target: form.target ? Number(form.target) : null,
      journal_notes: form.journal_notes || null,
    } as any);
    if (error) { push(error.message, "err"); return; }
    setForm({ ...emptyForm });
    setShowForm(false);
    push("Position added", "ok");
    invalidate();
  };

  const closePosition = async (p: Position) => {
    const q = quoteMap.get(quoteKey(p.exchange, p.symbol));
    const exitStr = prompt(`Exit price for ${p.symbol}?`, q?.ltp ? String(q.ltp) : "");
    if (exitStr == null) return;
    const exit = Number(exitStr);
    if (!Number.isFinite(exit) || exit <= 0) { push("Invalid exit price", "warn"); return; }
    const gross = p.side === "long" ? (exit - p.entry_price) * p.quantity : (p.entry_price - exit) * p.quantity;
    const { error } = await supabase.from("market_positions")
      .update({ closed_at: new Date().toISOString(), exit_price: exit, pnl: gross })
      .eq("id", p.id);
    if (error) { push(error.message, "err"); return; }
    push(`Closed ${p.symbol} · P&L ${inr(gross)}`, gross >= 0 ? "ok" : "warn");
    invalidate();
  };

  const remove = async (p: Position) => {
    if (!confirm(`Delete position ${p.symbol}?`)) return;
    const { error } = await supabase.from("market_positions").delete().eq("id", p.id);
    if (error) { push(error.message, "err"); return; }
    invalidate();
  };

  const sync = () => {
    syncMut.mutate(undefined, {
      onSuccess: (r: any) => push(`Synced ${r?.inserted ?? 0} positions from Kotak`, "ok"),
      onError: (e) => push(toSafeError(e, "Sync failed").message, "err"),
    });
  };

  const totals = useMemo(() => {
    let unrealized = 0;
    const dayPnls: Array<number | null> = [];
    for (const p of open) {
      const calc = positionPnl({ quantity: p.quantity, entryPrice: p.entry_price, side: p.side, quote: quoteMap.get(quoteKey(p.exchange, p.symbol)) });
      if (calc.unrealized != null) unrealized += calc.unrealized;
      dayPnls.push(calc.todayPnl);
    }
    const day = sumNullable(dayPnls);
    const realized = closed.reduce((a, p) => a + (p.pnl ?? 0), 0);
    return { unrealized, day, realized };
  }, [open, closed, quoteMap]);

  const columns = useMemo<ColumnDef<Position, any>[]>(() => [
    {
      header: "Symbol",
      accessorKey: "symbol",
      cell: ({ row }) => (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <Link to={`/market/analysis/${row.original.symbol}?exchange=${row.original.exchange}`} style={{ color: "var(--accent)", textDecoration: "none" }}>
            {row.original.symbol}
          </Link>
          <Chip tone={row.original.side === "long" ? "ok" : "warn"}>{row.original.side}</Chip>
        </span>
      ),
    },
    { header: "Qty", accessorKey: "quantity", meta: { align: "right" } },
    { header: "Entry", accessorKey: "entry_price", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue()) },
    {
      header: "LTP", id: "ltp", meta: { align: "right" },
      accessorFn: (p) => quoteMap.get(quoteKey(p.exchange, p.symbol))?.ltp ?? null,
      cell: ({ getValue }) => fmtNum(getValue()),
    },
    {
      header: "P&L", id: "pnl", meta: { align: "right" },
      accessorFn: (p) => {
        return positionPnl({ quantity: p.quantity, entryPrice: p.entry_price, side: p.side, quote: quoteMap.get(quoteKey(p.exchange, p.symbol)) }).unrealized;
      },
      cell: ({ getValue }) => {
        const v = getValue() as number | null;
        if (v == null) return "—";
        return <span style={{ color: v >= 0 ? "var(--ok)" : "var(--danger)" }}>{inr(v)}</span>;
      },
    },
    {
      header: "P&L %", id: "pnlPct", meta: { align: "right" },
      accessorFn: (p) => {
        return positionPnl({ quantity: p.quantity, entryPrice: p.entry_price, side: p.side, quote: quoteMap.get(quoteKey(p.exchange, p.symbol)) }).unrealizedPct;
      },
      cell: ({ getValue }) => <PctCell value={getValue() as number | null} />,
    },
    { header: "Stop", accessorKey: "stop_loss", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue()) },
    { header: "Target", accessorKey: "target", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue()) },
    {
      header: "R:R", id: "rr", meta: { align: "right" },
      accessorFn: (p) => {
        if (p.stop_loss == null || p.target == null) return null;
        const risk = Math.abs(p.entry_price - p.stop_loss);
        const reward = Math.abs(p.target - p.entry_price);
        return risk > 0 ? reward / risk : null;
      },
      cell: ({ getValue }) => {
        const v = getValue() as number | null;
        return v == null ? "—" : `1:${v.toFixed(1)}`;
      },
    },
    {
      header: "Days", id: "days", meta: { align: "right" },
      accessorFn: (p) => Math.max(0, Math.floor((Date.now() - new Date(p.opened_at).getTime()) / 86_400_000)),
    },
    {
      header: "", id: "actions", enableSorting: false,
      cell: ({ row }) => (
        <span style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
          <button onClick={(e) => { e.stopPropagation(); closePosition(row.original); }} className="hud-btn" data-variant="ghost" data-size="sm" title="Close position"><X size={11} /></button>
          <button onClick={(e) => { e.stopPropagation(); remove(row.original); }} className="hud-btn" data-variant="ghost" data-size="sm" title="Delete"><Trash2 size={11} /></button>
        </span>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [quoteMap]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel flow title="Positions Summary" index="MK.P1" actions={
        <div style={{ display: "flex", gap: 6 }}>
          {connected && (
            <Btn size="sm" onClick={sync} disabled={syncMut.isPending}>
              <Download size={11} style={{ marginRight: 4 }} /> {syncMut.isPending ? "syncing…" : "sync from Kotak"}
            </Btn>
          )}
          <Btn size="sm" onClick={() => setShowForm((v) => !v)}>
            <Plus size={11} style={{ marginRight: 4 }} /> {showForm ? "cancel" : "add"}
          </Btn>
        </div>
      }>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
          <Stat label="Open Positions" value={String(open.length)} />
          <Stat label="Unrealized P&L" value={inr(totals.unrealized)} tone={totals.unrealized >= 0 ? "ok" : "err"} />
          <Stat label="Today" value={totals.day == null ? "—" : inr(totals.day)} tone={totals.day == null ? undefined : totals.day >= 0 ? "ok" : "err"} />
          <Stat label="Realized (closed)" value={inr(totals.realized)} tone={totals.realized >= 0 ? "ok" : "err"} />
        </div>
      </HudPanel>

      {showForm && (
        <HudPanel flow title="New Position" index="MK.P2">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            <Input label="Symbol" value={form.symbol} onChange={(v) => setForm({ ...form, symbol: v })} placeholder="RELIANCE" />
            <Select label="Side" value={form.side} options={["long", "short"]} onChange={(v) => setForm({ ...form, side: v })} />
            <Input label="Quantity" value={form.quantity} onChange={(v) => setForm({ ...form, quantity: v })} type="number" />
            <Input label="Entry Price" value={form.entry_price} onChange={(v) => setForm({ ...form, entry_price: v })} type="number" />
            <Input label="Stop Loss" value={form.stop_loss} onChange={(v) => setForm({ ...form, stop_loss: v })} type="number" />
            <Input label="Target" value={form.target} onChange={(v) => setForm({ ...form, target: v })} type="number" />
            <Input label="Journal Notes" value={form.journal_notes} onChange={(v) => setForm({ ...form, journal_notes: v })} />
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <Btn onClick={add} variant="primary">Save</Btn>
            </div>
          </div>
        </HudPanel>
      )}

      <HudPanel flow title="Open Positions" index="MK.P3">
        <DataTable
          columns={columns}
          data={open}
          emptyLabel={isLoading ? "loading…" : "no open positions"}
          emptyHint={connected ? "sync from Kotak or add manually" : "connect Kotak Neo in Settings to sync"}
        />
      </HudPanel>

      {closed.length > 0 && (
        <HudPanel flow title="Closed Positions" index="MK.P4">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-dim)" }}>
                  {["Symbol", "Side", "Qty", "Entry", "Exit", "P&L", "Closed"].map((h) => (
                    <th key={h} style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)", fontWeight: 400, textTransform: "uppercase", letterSpacing: "0.1em", fontSize: 10 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {closed.map((p) => (
                  <tr key={p.id} style={{ borderBottom: "1px solid var(--edge)" }}>
                    <td style={td}>{p.symbol}</td>
                    <td style={td}>{p.side}</td>
                    <td style={td}>{p.quantity}</td>
                    <td style={td}>{fmtNum(p.entry_price)}</td>
                    <td style={td}>{fmtNum(p.exit_price)}</td>
                    <td style={{ ...td, color: (p.pnl ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}>{p.pnl == null ? "—" : inr(p.pnl)}</td>
                    <td style={td}>{p.closed_at ? new Date(p.closed_at).toLocaleDateString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </HudPanel>
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
