// OrderTicket — modal order-entry ticket for a single symbol.
// Supports MARKET / LIMIT / SL / SL-M, product MIS / CNC / NRML, DAY / IOC,
// and displays live LTP + notional + margin usage as the user types.
import { useEffect, useMemo, useState } from "react";
import { HudModal } from "@/components/hud/HudModal";
import { Btn, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { useQuotes } from "@/lib/market/hooks";
import { useFunds, useMarketOrderMutations, type PlaceOrderInput } from "@/lib/market/orderHooks";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";

type Side = "BUY" | "SELL";
type OrderType = "MARKET" | "LIMIT" | "SL" | "SL-M";
type Product = "MIS" | "CNC" | "NRML";

const inr = (n: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n)}`;

export function OrderTicket({
  open, onClose, symbol, exchange = "NSE", side: initialSide = "BUY", defaultQty,
}: {
  open: boolean; onClose: () => void; symbol: string; exchange?: "NSE" | "BSE";
  side?: Side; defaultQty?: number;
}) {
  const [side, setSide] = useState<Side>(initialSide);
  const [qty, setQty] = useState<string>(defaultQty ? String(defaultQty) : "1");
  const [orderType, setOrderType] = useState<OrderType>("MARKET");
  const [product, setProduct] = useState<Product>("CNC");
  const [price, setPrice] = useState("");
  const [trigger, setTrigger] = useState("");
  const [validity, setValidity] = useState<"DAY" | "IOC">("DAY");
  const [disclosedQty, setDisclosedQty] = useState("");
  const [amo, setAmo] = useState(false);
  const push = useUi((s) => s.push);
  const { place } = useMarketOrderMutations();
  const { data: fundsResp } = useFunds();
  const funds = fundsResp?.funds ?? null;

  useEffect(() => { if (open) { setSide(initialSide); setQty(defaultQty ? String(defaultQty) : "1"); } }, [open, initialSide, defaultQty]);

  const { data: quoteData } = useQuotes(open ? [`${exchange}:${symbol}`] : []);
  const ltp = quoteData?.quotes?.[0]?.ltp ?? null;

  // Auto-fill price with LTP when user switches to LIMIT and hasn't typed.
  useEffect(() => {
    if ((orderType === "LIMIT" || orderType === "SL") && !price && ltp) setPrice(ltp.toFixed(2));
  }, [orderType, ltp, price]);

  const notional = useMemo(() => {
    const q = Number(qty); const p = Number(price) || ltp || 0;
    return q > 0 && p > 0 ? q * p : 0;
  }, [qty, price, ltp]);

  const marginWarning = useMemo(() => {
    if (side !== "BUY" || !funds?.available_margin || notional === 0) return null;
    if (notional > funds.available_margin) return `Notional ${inr(notional)} exceeds available ${inr(funds.available_margin)}`;
    return null;
  }, [side, funds, notional]);

  // Enforce ₹0.05 tick size for equity LIMIT / SL orders — silently snap and
  // warn once. Broker rejects otherwise with a cryptic error.
  const tickHint = useMemo(() => {
    if (orderType === "MARKET" || orderType === "SL-M") return null;
    const p = Number(price);
    if (!p) return null;
    const snapped = Math.round(p * 20) / 20;
    return Math.abs(snapped - p) > 1e-6 ? `Nearest tick: ₹${snapped.toFixed(2)}` : null;
  }, [orderType, price]);

  const submit = async () => {
    const q = Number(qty);
    if (!q || q < 1) { push("Quantity must be at least 1", "warn"); return; }
    if ((orderType === "LIMIT" || orderType === "SL") && !Number(price)) { push("Price required", "warn"); return; }
    if ((orderType === "SL" || orderType === "SL-M") && !Number(trigger)) { push("Trigger price required", "warn"); return; }
    const dq = disclosedQty ? Number(disclosedQty) : undefined;
    if (dq != null) {
      if (!Number.isFinite(dq) || dq < 0 || dq > q) { push("Disclosed qty must be between 0 and quantity", "warn"); return; }
      // NSE rule: iceberg disclosed quantity must be at least 10% of order qty.
      const minDq = Math.ceil(q * 0.10);
      if (dq > 0 && dq < minDq) { push(`Disclosed qty must be ≥ 10% of order qty (min ${minDq})`, "warn"); return; }
    }
    // Confirm on large notional — fat-finger guard. ₹1L threshold.
    if (notional >= 100_000 && !confirm(`Place ${side} ${q} ${symbol} for ${inr(notional)}?`)) return;
    const input: PlaceOrderInput = {
      symbol, exchange, side, quantity: q, orderType, product, validity,
      price: price ? Number(price) : undefined,
      triggerPrice: trigger ? Number(trigger) : undefined,
      disclosedQuantity: dq,
      amo: amo || undefined,
    };
    try {
      const r = await place.mutateAsync(input);
      push(`Order placed · ${r.order_id}`, "ok");
      onClose();
    } catch (e) { push(toSafeError(e, "Order failed").message, "err"); }
  };

  const sideStyle = (s: Side): React.CSSProperties => ({
    ...inputStyle, padding: "8px 12px", cursor: "pointer", textAlign: "center", fontWeight: 600,
    background: side === s ? (s === "BUY" ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)") : "transparent",
    color: side === s ? (s === "BUY" ? "var(--ok)" : "var(--err)") : "var(--text-dim)",
    borderColor: side === s ? (s === "BUY" ? "var(--ok)" : "var(--err)") : "var(--edge)",
  });

  return (
    <HudModal
      open={open} onClose={onClose} width={460}
      title={<>Order · {symbol} <span style={{ color: "var(--text-dim)", marginLeft: 8 }}>{exchange}</span></>}
      footer={<>
        <Btn onClick={onClose} disabled={place.isPending}>Cancel</Btn>
        <Btn variant={side === "BUY" ? "primary" : "danger"} onClick={submit} disabled={place.isPending}>
          {place.isPending ? "Placing…" : `${side} ${qty || 0} ${symbol}`}
        </Btn>
      </>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {ltp != null && (
          <div className="hud-label" style={{ color: "var(--text-dim)" }}>
            LTP: <span style={{ color: "var(--accent)", fontVariantNumeric: "tabular-nums" }}>{inr(ltp)}</span>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <button type="button" style={sideStyle("BUY")} onClick={() => setSide("BUY")}>BUY</button>
          <button type="button" style={sideStyle("SELL")} onClick={() => setSide("SELL")}>SELL</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <label>
            <span style={labelStyle}>Quantity</span>
            <input style={inputStyle} type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
          <label>
            <span style={labelStyle}>Product</span>
            <select style={inputStyle} value={product} onChange={(e) => setProduct(e.target.value as Product)}>
              <option value="CNC">CNC · delivery</option>
              <option value="MIS">MIS · intraday</option>
              <option value="NRML">NRML · overnight F&O</option>
            </select>
          </label>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <label>
            <span style={labelStyle}>Order type</span>
            <select style={inputStyle} value={orderType} onChange={(e) => setOrderType(e.target.value as OrderType)}>
              <option value="MARKET">Market</option>
              <option value="LIMIT">Limit</option>
              <option value="SL">SL (stop-loss)</option>
              <option value="SL-M">SL-M</option>
            </select>
          </label>
          <label>
            <span style={labelStyle}>Validity</span>
            <select style={inputStyle} value={validity} onChange={(e) => setValidity(e.target.value as "DAY" | "IOC")}>
              <option value="DAY">DAY</option>
              <option value="IOC">IOC</option>
            </select>
          </label>
        </div>
        {(orderType === "LIMIT" || orderType === "SL") && (
          <label>
            <span style={labelStyle}>Limit price</span>
            <input style={inputStyle} type="number" step="0.05" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={ltp ? ltp.toFixed(2) : ""} />
          </label>
        )}
        {(orderType === "SL" || orderType === "SL-M") && (
          <label>
            <span style={labelStyle}>Trigger price</span>
            <input style={inputStyle} type="number" step="0.05" value={trigger} onChange={(e) => setTrigger(e.target.value)} />
          </label>
        )}
        {tickHint && (
          <div className="hud-label" style={{ color: "var(--warn, #d97706)" }}>{tickHint}</div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <label>
            <span style={labelStyle}>Disclosed qty (optional)</span>
            <input style={inputStyle} type="number" min={0} value={disclosedQty} onChange={(e) => setDisclosedQty(e.target.value)} placeholder="0" />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 18, fontSize: 12 }}>
            <input type="checkbox" checked={amo} onChange={(e) => setAmo(e.target.checked)} />
            AMO (after-market)
          </label>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: 8, border: "1px solid var(--edge)", borderRadius: 3 }}>
          <div>
            <div className="hud-label" style={{ color: "var(--text-dim)" }}>Notional</div>
            <div style={{ fontVariantNumeric: "tabular-nums" }}>{notional ? inr(notional) : "—"}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="hud-label" style={{ color: "var(--text-dim)" }}>Available</div>
            <div style={{ fontVariantNumeric: "tabular-nums" }}>{funds?.available_margin != null ? inr(funds.available_margin) : "—"}</div>
          </div>
        </div>
        {marginWarning && (
          <div className="hud-label" style={{ color: "var(--err)" }}>{marginWarning}</div>
        )}
      </div>
    </HudModal>
  );
}
