// Orders — today's broker order book + trades. Cancel/modify pending orders.
import { useMemo, useState } from "react";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudModal } from "@/components/hud/HudModal";
import { RefreshCw, X, Pencil } from "lucide-react";
import { useBrokerOrders, useBrokerTrades, useMarketOrderMutations, type BrokerOrder } from "@/lib/market/orderHooks";
import { OrderTicket } from "@/components/market/OrderTicket";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";

// Broker status strings vary widely (Kotak Neo, Kite-style, AMO variants).
// Match by keyword instead of an exact-set membership. IMPORTANT: check
// "PENDING" / "MODIFY" tokens BEFORE the closed tokens so statuses like
// "CANCEL PENDING" or "MODIFY PENDING" — which are still live, cancellable
// orders — aren't misclassified as done just because they contain the
// substring "CANCEL".
const OPEN_TOKENS = ["PENDING", "OPEN", "TRIGGER", "RECEIVED", "VALIDATION", "MODIFY", "AMO", "PUT ORDER"];
const CLOSED_TOKENS = ["COMPLETE", "EXECUTED", "FILLED", "CANCEL", "REJECT", "EXPIR"];
const isOpen = (s: string) => {
  const up = (s ?? "").toUpperCase();
  if (!up) return false;
  if (OPEN_TOKENS.some((t) => up.includes(t))) return true;
  if (CLOSED_TOKENS.some((t) => up.includes(t))) return false;
  return false;
};

const fmtInr = (n: number | null | undefined, dp = 2) =>
  n == null || !Number.isFinite(n) ? "—" : `₹${n.toFixed(dp)}`;
const fmtNum = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : String(n);

export default function Orders() {
  const push = useUi((s) => s.push);
  const { data: ordersData, isFetching: ordersFetching, error: ordersError, refetch: refetchOrders } = useBrokerOrders();
  const { data: tradesData, isFetching: tradesFetching, error: tradesError, refetch: refetchTrades } = useBrokerTrades();
  const { cancel, modify } = useMarketOrderMutations();
  const [ticket, setTicket] = useState<{ symbol: string; exchange: "NSE" | "BSE"; side: "BUY" | "SELL" } | null>(null);
  const [modifying, setModifying] = useState<BrokerOrder | null>(null);

  const orders = ordersData?.orders ?? [];
  const trades = tradesData?.trades ?? [];
  const source = ordersData?.source ?? tradesData?.source ?? "";

  const { pending, done } = useMemo(() => {
    const p: BrokerOrder[] = [], d: BrokerOrder[] = [];
    for (const o of orders) (isOpen(o.status) ? p : d).push(o);
    // Newest first — matches Kite/Dhan. Broker payload order is unspecified.
    const byTimeDesc = (a: BrokerOrder, b: BrokerOrder) =>
      String(b.order_time ?? "").localeCompare(String(a.order_time ?? ""));
    return { pending: p.sort(byTimeDesc), done: d.sort(byTimeDesc) };
  }, [orders]);


  const doCancel = async (id: string) => {
    if (!confirm("Cancel this order?")) return;
    try { await cancel.mutateAsync(id); push("Cancel requested", "ok"); }
    catch (e) { push(toSafeError(e, "Cancel failed").message, "err"); }
  };

  if (source === "unavailable") {
    return <HudPanel flow title="Broker orders" index="MK.OR">
      <div className="hud-label" style={{ color: "var(--text-dim)" }}>
        Order book requires a Kotak Neo connection. Configure it in Market → Config.
      </div>
    </HudPanel>;
  }

  const refreshAll = () => { refetchOrders(); refetchTrades(); };
  const busy = ordersFetching || tradesFetching;
  const brokerError = ordersError ?? tradesError;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {brokerError && (
        <HudPanel flow title="Broker sync issue" index="MK.ERR">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ color: "var(--danger)", fontSize: 12, lineHeight: 1.45 }}>
              {toSafeError(brokerError, "Could not load Kotak orders/trades").message}
            </div>
            <Btn size="sm" onClick={refreshAll} disabled={busy}>
              <RefreshCw size={11} style={{ marginRight: 4 }} />retry
            </Btn>
          </div>
        </HudPanel>
      )}

      <HudPanel flow title={`Pending · ${pending.length}`} index="MK.OR1" actions={
        <Btn size="sm" onClick={refreshAll} disabled={busy}>
          <RefreshCw size={11} style={{ marginRight: 4 }} />{busy ? "…" : "refresh"}
        </Btn>
      }>
        {pending.length === 0 ? <Empty msg="No pending orders" /> : (
          <OrdersTable rows={pending} onCancel={doCancel} onModify={setModifying} showActions
            cancelingId={cancel.isPending ? cancel.variables ?? null : null}
            modifyingId={modify.isPending ? modify.variables?.order_id ?? null : null} />
        )}
      </HudPanel>

      <HudPanel flow title={`Completed · ${done.length}`} index="MK.OR2">
        {done.length === 0 ? <Empty msg="No completed orders today" /> : <OrdersTable rows={done} onCancel={() => {}} onModify={() => {}} showActions={false} />}
      </HudPanel>

      <HudPanel flow title={`Trades · ${trades.length}`} index="MK.TR">
        {trades.length === 0 ? <Empty msg="No trades yet today" /> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-dim)", borderBottom: "1px solid var(--edge)" }}>
                  <th style={th}>Time</th><th style={th}>Symbol</th><th style={th}>Side</th>
                  <th style={{ ...th, textAlign: "right" }}>Qty</th>
                  <th style={{ ...th, textAlign: "right" }}>Price</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.trade_id} style={{ borderBottom: "1px solid var(--edge)" }}>
                    <td style={td}>{t.trade_time}</td>
                    <td style={td}>{t.symbol}</td>
                    <td style={{ ...td, color: t.side === "BUY" ? "var(--ok)" : "var(--err)" }}>{t.side}</td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtNum(t.quantity)}</td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtInr(t.price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </HudPanel>

      {ticket && (
        <OrderTicket open onClose={() => setTicket(null)}
          symbol={ticket.symbol} exchange={ticket.exchange} side={ticket.side} />
      )}

      {modifying && (
        <ModifyOrderModal
          order={modifying}
          onClose={() => setModifying(null)}
          onSubmit={async (patch) => {
            try {
              await modify.mutateAsync({ order_id: modifying.order_id, ...patch });
              push("Modify requested", "ok");
              setModifying(null);
            } catch (e) { push(toSafeError(e, "Modify failed").message, "err"); }
          }}
          submitting={modify.isPending}
        />
      )}
    </div>
  );
}

const th: React.CSSProperties = { padding: "6px 8px", fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase" };
const td: React.CSSProperties = { padding: "6px 8px" };

function Empty({ msg }: { msg: string }) {
  return <div className="hud-label" style={{ color: "var(--text-dim)" }}>{msg}</div>;
}

function OrdersTable({ rows, onCancel, onModify, showActions, cancelingId = null, modifyingId = null }: {
  rows: BrokerOrder[]; onCancel: (id: string) => void; onModify: (o: BrokerOrder) => void; showActions: boolean;
  // Which single row (if any) has an in-flight cancel/modify mutation —
  // cancel/modify are shared mutation instances, so isPending alone can't
  // tell rows apart; previously no row disabled its buttons during an
  // in-flight request at all (unlike OrderTicket's Place button), so a
  // double-click before the first request settled could fire a second
  // concurrent cancel/modify on the same row.
  cancelingId?: string | null; modifyingId?: string | null;
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-dim)", borderBottom: "1px solid var(--edge)" }}>
            <th style={th}>Time</th><th style={th}>Symbol</th><th style={th}>Side</th><th style={th}>Product</th>
            <th style={{ ...th, textAlign: "right" }}>Qty · Filled</th>
            <th style={{ ...th, textAlign: "right" }}>Price</th>
            <th style={th}>Status</th>
            {showActions && <th style={th} />}
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.order_id} style={{ borderBottom: "1px solid var(--edge)" }}>
              <td style={td}>{o.order_time}</td>
              <td style={td}>{o.symbol}</td>
              <td style={{ ...td, color: o.side === "BUY" ? "var(--ok)" : "var(--err)" }}>{o.side}</td>
              <td style={td}>{o.product}</td>
              <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtNum(o.quantity)} · {fmtNum(o.filled_qty)}</td>
              <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{o.price && Number.isFinite(o.price) ? fmtInr(o.price) : "MKT"}</td>
              <td style={td}>{o.status}</td>
              {showActions && (
                <td style={{ ...td, textAlign: "right" }}>
                  <div style={{ display: "inline-flex", gap: 4 }}>
                    <Btn size="sm" onClick={() => onModify(o)} title="Modify order" disabled={modifyingId === o.order_id || cancelingId === o.order_id}>
                      <Pencil size={11} style={{ marginRight: 4 }} />modify
                    </Btn>
                    <Btn size="sm" variant="danger" onClick={() => onCancel(o.order_id)} disabled={cancelingId === o.order_id || modifyingId === o.order_id}>
                      <X size={11} style={{ marginRight: 4 }} />{cancelingId === o.order_id ? "cancelling…" : "cancel"}
                    </Btn>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModifyOrderModal({
  order, onClose, onSubmit, submitting,
}: {
  order: BrokerOrder;
  onClose: () => void;
  onSubmit: (patch: { quantity?: number; price?: number; orderType?: "MARKET" | "LIMIT" | "SL" | "SL-M"; triggerPrice?: number; validity?: "DAY" | "IOC" }) => void;
  submitting: boolean;
}) {
  const initialType = (order as any).order_type as "MARKET" | "LIMIT" | "SL" | "SL-M" | undefined;
  const initialValidity = ((order as any).validity as "DAY" | "IOC" | undefined) ?? "DAY";
  const initialTrigger = (order as any).trigger_price as number | undefined;
  const [qty, setQty] = useState(String(order.quantity ?? ""));
  const [price, setPrice] = useState(order.price ? String(order.price) : "");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT" | "SL" | "SL-M">(initialType ?? "LIMIT");
  const [trigger, setTrigger] = useState(initialTrigger ? String(initialTrigger) : "");
  const [validity, setValidity] = useState<"DAY" | "IOC">(initialValidity);
  const showPrice = orderType === "LIMIT" || orderType === "SL";
  const showTrigger = orderType === "SL" || orderType === "SL-M";
  const submit = () => {
    const q = Number(qty), p = Number(price), t = Number(trigger);
    const patch: Parameters<typeof onSubmit>[0] = {};
    if (q > 0 && q !== order.quantity) patch.quantity = q;
    if (showPrice && p > 0 && (order.price == null || Math.abs(p - order.price) > 1e-4)) patch.price = p;
    if (showTrigger && t > 0 && (!initialTrigger || Math.abs(t - initialTrigger) > 1e-4)) patch.triggerPrice = t;
    if (initialType && orderType !== initialType) patch.orderType = orderType;
    if (initialValidity && validity !== initialValidity) patch.validity = validity;
    if (showPrice && !p) { alert("Price required for LIMIT / SL"); return; }
    if (showTrigger && !t) { alert("Trigger price required for SL / SL-M"); return; }
    if (Object.keys(patch).length === 0) { onClose(); return; }
    onSubmit(patch);
  };

  return (
    <HudModal open onClose={onClose} width={420}
      title={<>Modify · {order.symbol}</>}
      footer={<>
        <Btn onClick={onClose} disabled={submitting}>Cancel</Btn>
        <Btn variant="primary" onClick={submit} disabled={submitting}>{submitting ? "Sending…" : "Modify"}</Btn>
      </>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label>
          <span style={labelStyle}>Order type</span>
          <select style={inputStyle} value={orderType} onChange={(e) => setOrderType(e.target.value as any)}>
            <option value="MARKET">MARKET</option>
            <option value="LIMIT">LIMIT</option>
            <option value="SL">SL</option>
            <option value="SL-M">SL-M</option>
          </select>
        </label>
        <label>
          <span style={labelStyle}>Quantity</span>
          <input style={inputStyle} type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        {showPrice && (
          <label>
            <span style={labelStyle}>Limit price</span>
            <input style={inputStyle} type="number" step="0.05" value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
        )}
        {showTrigger && (
          <label>
            <span style={labelStyle}>Trigger price</span>
            <input style={inputStyle} type="number" step="0.05" value={trigger} onChange={(e) => setTrigger(e.target.value)} />
          </label>
        )}
        <label>
          <span style={labelStyle}>Validity</span>
          <select style={inputStyle} value={validity} onChange={(e) => setValidity(e.target.value as "DAY" | "IOC")}>
            <option value="DAY">DAY</option>
            <option value="IOC">IOC (Immediate-or-Cancel)</option>
          </select>
        </label>
        <div className="hud-label" style={{ color: "var(--text-dim)", fontSize: 10 }}>
          Only changed fields are sent to the broker.
        </div>
      </div>
    </HudModal>
  );
}


