// Market Positions — active trades: broker sync + manual journal + live P&L.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { HudPanel } from "@/components/hud/HudPanel";
import { HudModal } from "@/components/hud/HudModal";
import { Btn, Chip, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { DataTable, fmtNum, PctCell } from "@/components/hud/DataTable";
import { SymbolSearchInput } from "@/components/market/SymbolSearchInput";
import { supabase } from "@/integrations/supabase/client";
import { useMarketSettings, usePortfolioLastSync, usePositions, useQuotes, useSyncPositions, useTodayRealized } from "@/lib/market/hooks";
import { useMarketOrderMutations } from "@/lib/market/orderHooks";
import { useQueryClient } from "@tanstack/react-query";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { Download, Plus, Repeat, ShoppingCart, Trash2, X } from "lucide-react";
import type { Position, Quote } from "@/lib/market/types";
import { positionPnl, quoteKey, sumNullable } from "@/lib/market/pnl";
import { isFreshTick, useLiveTickStore } from "@/lib/market/liveTickStore";
import { subscribeSymbolsForTicks } from "@/lib/market/useRealtimeTicks";
import { PriceSourceChip } from "@/components/market/PriceSourceChip";
import { OrderTicket } from "@/components/market/OrderTicket";
import { ClosePositionModal } from "@/components/market/ClosePositionModal";
import { useMisSquareOffWarning } from "@/lib/market/useMisSquareOffWarning";

const emptyForm = { symbol: "", exchange: "NSE", side: "long", quantity: "", entry_price: "", stop_loss: "", target: "", journal_notes: "" };

export default function Positions() {
  const push = useUi((s) => s.push);
  const qc = useQueryClient();
  const { data: positions = [], isLoading } = usePositions();
  const { data: settings = [] } = useMarketSettings();
  const { data: lastSyncAt } = usePortfolioLastSync();
  const syncMut = useSyncPositions();
  const { data: realizedToday = [] } = useTodayRealized();
  const { convertPosition } = useMarketOrderMutations();
  const [showForm, setShowForm] = useState(false);
  const [ticket, setTicket] = useState<{ symbol: string; exchange: "NSE" | "BSE"; side: "BUY" | "SELL"; qty?: number } | null>(null);
  const [closingPos, setClosingPos] = useState<Position | null>(null);
  const [convertPos, setConvertPos] = useState<Position | null>(null);
  const [deletePos, setDeletePos] = useState<Position | null>(null);
  const [form, setForm] = useState({ ...emptyForm });

  const open = useMemo(() => positions.filter((p) => !p.closed_at), [positions]);
  const closed = useMemo(() => positions.filter((p) => p.closed_at), [positions]);
  const misWarn = useMisSquareOffWarning(open);
  const keys = useMemo(() => [...new Set(open.map((p) => `${p.exchange}:${p.symbol}`))], [open]);
  useEffect(() => { subscribeSymbolsForTicks(keys); }, [keys]);
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
    // R:R direction guard — protects the journal from typos that would
    // otherwise render a nonsensical "1:N" (e.g. stop above entry on a long).
    const entry = Number(form.entry_price);
    const stop = form.stop_loss ? Number(form.stop_loss) : null;
    const tgt = form.target ? Number(form.target) : null;
    if (stop != null && tgt != null) {
      const bad = form.side === "long"
        ? !(stop < entry && tgt > entry)
        : !(stop > entry && tgt < entry);
      if (bad) {
        push(`Check stop/target: on a ${form.side} the stop must be ${form.side === "long" ? "below" : "above"} entry and target ${form.side === "long" ? "above" : "below"}.`, "warn");
        return;
      }
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
      entry_price: entry,
      stop_loss: stop,
      target: tgt,
      journal_notes: form.journal_notes || null,
    } as any);
    if (error) { push(error.message, "err"); return; }
    setForm({ ...emptyForm });
    setShowForm(false);
    push("Position added", "ok");
    invalidate();
  };

  const doCloseWithPrice = async (p: Position, exit: number) => {
    const gross = p.side === "long" ? (exit - p.entry_price) * p.quantity : (p.entry_price - exit) * p.quantity;
    const { error } = await supabase.from("market_positions")
      .update({ closed_at: new Date().toISOString(), exit_price: exit, pnl: gross, exit_source: "manual" } as any)
      .eq("id", p.id);
    if (error) { push(error.message, "err"); return; }
    push(`Closed ${p.symbol} · P&L ${inr(gross)}`, gross >= 0 ? "ok" : "warn");
    setClosingPos(null);
    invalidate();
  };

  const remove = async (p: Position) => {
    const { error } = await supabase.from("market_positions").delete().eq("id", p.id);
    if (error) { push(error.message, "err"); return; }
    push(`Deleted ${p.symbol}`, "ok");
    setDeletePos(null);
    invalidate();
  };

  const sync = () => {
    syncMut.mutate(undefined, {
      onSuccess: (r: any) => push(`Kotak sync: ${r?.inserted ?? 0} new, ${r?.updated ?? 0} updated${r?.removed ? `, ${r.removed} removed` : ""}`, "ok"),
      onError: (e) => {
        const msg = toSafeError(e, "Sync failed").message;
        push(msg, msg.toLowerCase().includes("session") ? "warn" : "err");
      },
    });
  };

  const totals = useMemo(() => {
    // A position with no resolvable live quote contributes "unknown," not "zero,"
    // to the total — matching pnl.ts semantics.
    let unrealized = 0, unresolved = 0;
    const dayPnls: Array<number | null> = [];
    for (const p of open) {
      const calc = positionPnl({ quantity: p.quantity, entryPrice: p.entry_price, side: p.side, quote: quoteMap.get(quoteKey(p.exchange, p.symbol)) });
      if (calc.unrealized == null) { unresolved++; continue; }
      unrealized += calc.unrealized;
      dayPnls.push(calc.todayPnl);
    }
    const allUnresolved = open.length > 0 && unresolved === open.length;
    const dayOpen = sumNullable(dayPnls);
    const realizedDay = realizedToday.reduce((a, r) => a + (Number(r.realized) || 0), 0);
    // Today = open-MTM + intraday realized (Kite/Groww parity). If neither is
    // available (unresolved + no closes), stay null instead of showing "0".
    const day = dayOpen == null && realizedDay === 0 ? null : (dayOpen ?? 0) + realizedDay;
    const realized = closed.reduce((a, p) => a + (p.pnl ?? 0), 0);
    return { unrealized: allUnresolved ? null : unrealized, day, realized, unresolved, realizedDay };
  }, [open, closed, quoteMap, realizedToday]);

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
          const valid = p.side === "long"
            ? p.stop_loss < p.entry_price && p.target > p.entry_price
            : p.stop_loss > p.entry_price && p.target < p.entry_price;
          if (!valid) return null;
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
          {connected && (
            <>
              <button onClick={(e) => { e.stopPropagation(); setTicket({ symbol: row.original.symbol, exchange: row.original.exchange as "NSE" | "BSE", side: row.original.side === "long" ? "BUY" : "SELL", qty: row.original.quantity }); }} className="hud-btn" data-variant="ghost" data-size="sm" title="Add to position"><ShoppingCart size={11} /></button>
              <button onClick={(e) => { e.stopPropagation(); setTicket({ symbol: row.original.symbol, exchange: row.original.exchange as "NSE" | "BSE", side: row.original.side === "long" ? "SELL" : "BUY", qty: row.original.quantity }); }} className="hud-btn" data-variant="ghost" data-size="sm" title="Exit via broker" style={{ color: "var(--danger)" }}>E</button>
              <button onClick={(e) => { e.stopPropagation(); setConvertPos(row.original); }} className="hud-btn" data-variant="ghost" data-size="sm" title="Convert product (MIS ↔ CNC ↔ NRML)"><Repeat size={11} /></button>
            </>
          )}
          <button onClick={(e) => { e.stopPropagation(); setClosingPos(row.original); }} className="hud-btn" data-variant="ghost" data-size="sm" title="Close (journal only)"><X size={11} /></button>
          <button onClick={(e) => { e.stopPropagation(); setDeletePos(row.original); }} className="hud-btn" data-variant="ghost" data-size="sm" title="Delete"><Trash2 size={11} /></button>
        </span>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [quoteMap]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {misWarn.active && (
        <div style={{
          padding: "8px 12px",
          border: "1px solid var(--warn)",
          background: "color-mix(in oklab, var(--warn) 10%, transparent)",
          color: "var(--warn)",
          fontSize: 12,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <span>
            ⚠ MIS square-off in {misWarn.minutesToCutoff} min — broker will auto-close {misWarn.misOpen} intraday
            position{misWarn.misOpen === 1 ? "" : "s"} at 15:15 IST. Exit or convert to CNC/NRML now.
          </span>
        </div>
      )}
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
        {syncMut.isError && (
          <div className="hud-label" style={{ color: "var(--warn)", marginBottom: 8, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <span>{toSafeError(syncMut.error, "Sync failed").message}</span>
            {toSafeError(syncMut.error, "").message.toLowerCase().includes("session") && <Link to="/market/settings" style={{ color: "var(--accent)" }}>Reconnect →</Link>}
          </div>
        )}
        {lastSyncAt && <div className="hud-label" style={{ color: "var(--text-dim)", marginBottom: 8 }}>Last synced {new Date(lastSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
          <Stat label="Open Positions" value={String(open.length)} />
          <Stat label="Unrealized P&L" value={totals.unrealized == null ? "—" : inr(totals.unrealized)} tone={totals.unrealized == null ? undefined : totals.unrealized >= 0 ? "ok" : "err"} />
          <Stat label="Today" value={totals.day == null ? "—" : inr(totals.day)} tone={totals.day == null ? undefined : totals.day >= 0 ? "ok" : "err"} />
          <Stat label="Today realized" value={inr(totals.realizedDay)} tone={totals.realizedDay === 0 ? undefined : totals.realizedDay >= 0 ? "ok" : "err"} />
          <Stat label="All-time realized" value={inr(totals.realized)} tone={totals.realized >= 0 ? "ok" : "err"} />
        </div>
      </HudPanel>

      {showForm && (
        <HudPanel flow title="New Position" index="MK.P2">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            <div>
              <div style={labelStyle}>Symbol</div>
              <SymbolSearchInput value={form.symbol} onChange={(v) => setForm({ ...form, symbol: v })}
                onSelect={(o) => setForm({ ...form, symbol: o.symbol, exchange: o.exchange })}
                placeholder="RELIANCE" />
            </div>
            <Select label="Exchange" value={form.exchange} options={["NSE", "BSE"]} onChange={(v) => setForm({ ...form, exchange: v })} />
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
      {ticket && (
        <OrderTicket open={ticket !== null} onClose={() => setTicket(null)}
          symbol={ticket.symbol} exchange={ticket.exchange} side={ticket.side} defaultQty={ticket.qty} />
      )}
      {closingPos && (
        <ClosePositionModal
          open={closingPos !== null}
          onClose={() => setClosingPos(null)}
          symbol={closingPos.symbol}
          exchange={closingPos.exchange}
          side={closingPos.side}
          quantity={closingPos.quantity}
          entryPrice={closingPos.entry_price}
          ltp={quoteMap.get(quoteKey(closingPos.exchange, closingPos.symbol))?.ltp ?? null}
          onConfirm={(exit) => doCloseWithPrice(closingPos, exit)}
        />
      )}
      {convertPos && (
        <ConvertPositionModal
          open={convertPos !== null}
          onClose={() => setConvertPos(null)}
          position={convertPos}
          pending={convertPosition.isPending}
          onConfirm={(fromProduct, toProduct) => {
            convertPosition.mutate(
              { symbol: convertPos.symbol, exchange: convertPos.exchange as "NSE" | "BSE", side: convertPos.side === "long" ? "BUY" : "SELL", quantity: convertPos.quantity, fromProduct, toProduct },
              {
                onSuccess: () => { push(`Converted ${convertPos.symbol} ${fromProduct} → ${toProduct}`, "ok"); setConvertPos(null); syncMut.mutate(undefined); },
                onError: (e) => push(toSafeError(e, "Convert failed").message, "err"),
              },
            );
          }}
        />
      )}
      {deletePos && (
        <HudModal
          open={deletePos !== null}
          onClose={() => setDeletePos(null)}
          title="Delete position"
          footer={<><Btn onClick={() => setDeletePos(null)}>cancel</Btn><Btn variant="danger" onClick={() => remove(deletePos)}>delete</Btn></>}
        >
          <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
            Delete {deletePos.symbol} from the journal? Broker-synced rows can return on the next sync if still open.
          </div>
        </HudModal>
      )}
    </div>
  );
}

function ConvertPositionModal({ open, onClose, position, pending, onConfirm }: {
  open: boolean;
  onClose: () => void;
  position: Position;
  pending: boolean;
  onConfirm: (fromProduct: "MIS" | "CNC" | "NRML", toProduct: "MIS" | "CNC" | "NRML") => void;
}) {
  // Default "From" to the position's actual product (now synced from the
  // broker) instead of always guessing MIS — previously guessing wrong
  // meant either a clean broker rejection, or (worse, if both MIS/CNC legs
  // of the same symbol existed) the wrong leg being targeted.
  const [fromProduct, setFromProduct] = useState<"MIS" | "CNC" | "NRML">(position.product ?? "MIS");
  const [toProduct, setToProduct] = useState<"MIS" | "CNC" | "NRML">(position.product === "CNC" ? "MIS" : "CNC");
  if (!open) return null;
  const same = fromProduct === toProduct;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(460px, 96vw)", background: "var(--bg)", border: "1px solid var(--edge-strong)", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="hud-label" style={{ color: "var(--accent)", letterSpacing: "0.2em" }}>Convert Product</div>
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {position.symbol} × {position.quantity} ({position.exchange}, {position.side})
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <div style={labelStyle}>From</div>
            <div style={{ display: "flex", gap: 4 }}>
              {(["MIS", "CNC", "NRML"] as const).map((p) => (
                <Btn key={p} size="sm" variant={fromProduct === p ? "primary" : "ghost"} onClick={() => setFromProduct(p)}>{p}</Btn>
              ))}
            </div>
          </div>
          <div>
            <div style={labelStyle}>To</div>
            <div style={{ display: "flex", gap: 4 }}>
              {(["MIS", "CNC", "NRML"] as const).map((p) => (
                <Btn key={p} size="sm" variant={toProduct === p ? "primary" : "ghost"} onClick={() => setToProduct(p)}>{p}</Btn>
              ))}
            </div>
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
          Broker will convert without exit + re-buy. MIS → CNC/NRML avoids the 15:15 IST auto square-off. Requires available margin for CNC/NRML.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn onClick={onClose}>cancel</Btn>
          <Btn variant="primary" disabled={same || pending} onClick={() => onConfirm(fromProduct, toProduct)}>
            {pending ? "converting…" : "convert"}
          </Btn>
        </div>
      </div>
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
