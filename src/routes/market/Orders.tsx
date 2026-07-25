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
// Match by keyword instead of an exact-set membership so we don't misclassify
// a live pending order as "completed" just because the broker returned a
// slightly different phrasing (e.g. "AFTER MARKET ORDER REQ RECEIVED").
const CLOSED_TOKENS = ["COMPLETE", "EXECUTED", "FILLED", "CANCEL", "REJECT", "EXPIR"];
const isOpen = (s: string) => {
  const up = (s ?? "").toUpperCase();
  if (!up) return false;
  if (CLOSED_TOKENS.some((t) => up.includes(t))) return false;
  return (
    up.includes("PENDING") || up.includes("OPEN") || up.includes("TRIGGER") ||
    up.includes("RECEIVED") || up.includes("VALIDATION") || up.includes("MODIFY") ||
    up.includes("AMO") || up.includes("PUT ORDER")
  );
};
const fmtInr = (n: number | null | undefined, dp = 2) =>
  n == null || !Number.isFinite(n) ? "—" : `₹${n.toFixed(dp)}`;
const fmtNum = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : String(n);

export default function Orders() {
  const push = useUi((s) => s.push);
  const { data: ordersData, isFetching: ordersFetching, refetch: refetchOrders } = useBrokerOrders();
  const { data: tradesData, isFetching: tradesFetching, refetch: refetchTrades } = useBrokerTrades();
  const { cancel, modify } = useMarketOrderMutations();
  const [ticket, setTicket] = useState<{ symbol: string; exchange: "NSE" | "BSE"; side: "BUY" | "SELL" } | null>(null);
  const [modifying, setModifying] = useState<BrokerOrder | null>(null);

  const orders = ordersData?.orders ?? [];
  const trades = tradesData?.trades ?? [];
  const source = ordersData?.source ?? tradesData?.source ?? "";

  const { pending, done } = useMemo(() => {
    const p: BrokerOrder[] = [], d: BrokerOrder[] = [];
    for (const o of orders) (isOpen(o.status) ? p : d).push(o);
    return { pending: p, done: d };
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel flow title={`Pending · ${pending.length}`} index="MK.OR1" actions={
        <Btn size="sm" onClick={refreshAll} disabled={busy}>
          <RefreshCw size={11} style={{ marginRight: 4 }} />{busy ? "…" : "refresh"}
        </Btn>
      }>
        {pending.length === 0 ? <Empty msg="No pending orders" /> : (
          <OrdersTable rows={pending} onCancel={doCancel} onModify={setModifying} showActions />
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

function OrdersTable({ rows, onCancel, onModify, showActions }: {
  rows: BrokerOrder[]; onCancel: (id: string) => void; onModify: (o: BrokerOrder) => void; showActions: boolean;
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
                    <Btn size="sm" onClick={() => onModify(o)} title="Modify order">
                      <Pencil size={11} style={{ marginRight: 4 }} />modify
                    </Btn>
                    <Btn size="sm" variant="danger" onClick={() => onCancel(o.order_id)}>
                      <X size={11} style={{ marginRight: 4 }} />cancel
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
  onSubmit: (patch: { quantity?: number; price?: number; orderType?: "MARKET" | "LIMIT" | "SL" | "SL-M"; triggerPrice?: number }) => void;
  submitting: boolean;
}) {
  const [qty, setQty] = useState(String(order.quantity ?? ""));
  const [price, setPrice] = useState(order.price ? String(order.price) : "");
  const submit = () => {
    const q = Number(qty), p = Number(price);
    const patch: Parameters<typeof onSubmit>[0] = {};
    if (q > 0 && q !== order.quantity) patch.quantity = q;
    if (p > 0 && p !== order.price) patch.price = p;
    if (Object.keys(patch).length === 0) { onClose(); return; }
    onSubmit(patch);
  };
  return (
    <HudModal open onClose={onClose} width={380}
      title={<>Modify · {order.symbol}</>}
      footer={<>
        <Btn onClick={onClose} disabled={submitting}>Cancel</Btn>
        <Btn variant="primary" onClick={submit} disabled={submitting}>{submitting ? "Sending…" : "Modify"}</Btn>
      </>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label>
          <span style={labelStyle}>Quantity</span>
          <input style={inputStyle} type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        <label>
          <span style={labelStyle}>Limit price</span>
          <input style={inputStyle} type="number" step="0.05" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="MKT" />
        </label>
        <div className="hud-label" style={{ color: "var(--text-dim)", fontSize: 10 }}>
          Only fields you change are sent. Order type / trigger stays the same.
        </div>
      </div>
    </HudModal>
  );
}

