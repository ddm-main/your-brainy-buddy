// Orders — today's broker order book + trades. Cancel/modify pending orders.
import { useMemo, useState } from "react";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn } from "@/components/hud/HudControls";
import { RefreshCw, X } from "lucide-react";
import { useBrokerOrders, useBrokerTrades, useMarketOrderMutations, type BrokerOrder } from "@/lib/market/orderHooks";
import { OrderTicket } from "@/components/market/OrderTicket";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";

const OPEN_STATUSES = new Set(["OPEN", "PENDING", "TRIGGER_PENDING", "OPEN_PENDING", "PUT ORDER REQ RECEIVED"]);
const isOpen = (s: string) => OPEN_STATUSES.has(s.toUpperCase());

export default function Orders() {
  const push = useUi((s) => s.push);
  const { data: ordersData, isFetching: ordersFetching, refetch: refetchOrders } = useBrokerOrders();
  const { data: tradesData, isFetching: tradesFetching, refetch: refetchTrades } = useBrokerTrades();
  const { cancel } = useMarketOrderMutations();
  const [ticket, setTicket] = useState<{ symbol: string; exchange: "NSE" | "BSE"; side: "BUY" | "SELL" } | null>(null);

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
        {pending.length === 0 ? <Empty msg="No pending orders" /> : <OrdersTable rows={pending} onCancel={doCancel} showCancel />}
      </HudPanel>

      <HudPanel flow title={`Completed · ${done.length}`} index="MK.OR2">
        {done.length === 0 ? <Empty msg="No completed orders today" /> : <OrdersTable rows={done} onCancel={() => {}} showCancel={false} />}
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
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{t.quantity}</td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>₹{t.price?.toFixed?.(2)}</td>
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
    </div>
  );
}

const th: React.CSSProperties = { padding: "6px 8px", fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase" };
const td: React.CSSProperties = { padding: "6px 8px" };

function Empty({ msg }: { msg: string }) {
  return <div className="hud-label" style={{ color: "var(--text-dim)" }}>{msg}</div>;
}

function OrdersTable({ rows, onCancel, showCancel }: { rows: BrokerOrder[]; onCancel: (id: string) => void; showCancel: boolean }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-dim)", borderBottom: "1px solid var(--edge)" }}>
            <th style={th}>Time</th><th style={th}>Symbol</th><th style={th}>Side</th><th style={th}>Product</th>
            <th style={{ ...th, textAlign: "right" }}>Qty · Filled</th>
            <th style={{ ...th, textAlign: "right" }}>Price</th>
            <th style={th}>Status</th>
            {showCancel && <th style={th} />}
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.order_id} style={{ borderBottom: "1px solid var(--edge)" }}>
              <td style={td}>{o.order_time}</td>
              <td style={td}>{o.symbol}</td>
              <td style={{ ...td, color: o.side === "BUY" ? "var(--ok)" : "var(--err)" }}>{o.side}</td>
              <td style={td}>{o.product}</td>
              <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{o.quantity} · {o.filled_qty}</td>
              <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{o.price ? `₹${o.price.toFixed(2)}` : "MKT"}</td>
              <td style={td}>{o.status}</td>
              {showCancel && (
                <td style={{ ...td, textAlign: "right" }}>
                  <Btn size="sm" variant="danger" onClick={() => onCancel(o.order_id)}>
                    <X size={11} style={{ marginRight: 4 }} />cancel
                  </Btn>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
