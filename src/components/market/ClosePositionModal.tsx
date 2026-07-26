// P0 safety: replace the raw prompt() close flow with a modal that
// (a) confirms the action, (b) validates the exit price against LTP so a
// fat-finger silently booking a wrong P&L is caught before it hits the DB.
import { useEffect, useState } from "react";
import { HudModal } from "@/components/hud/HudModal";
import { Btn, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { useQuotes } from "@/lib/market/hooks";

export function ClosePositionModal({
  open, onClose, symbol, exchange = "NSE", side, quantity, entryPrice, ltp, onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
  exchange?: string;
  side: "long" | "short" | string;
  quantity: number;
  entryPrice: number;
  ltp?: number | null;
  onConfirm: (exit: number) => Promise<void> | void;
}) {
  const [exit, setExit] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // If the caller couldn't supply a live quote (quote-map miss, fetch
  // error), fetch one directly instead of silently falling back to entry
  // price — comparing the typed exit against the ORIGINAL entry price lets
  // a stale/wrong exit that's merely close to entry sail through even when
  // it's nowhere near the real current market price.
  const needsFallback = open && ltp == null;
  const { data: fallbackQuoteData } = useQuotes(needsFallback ? [`${exchange}:${symbol}`] : []);
  const fallbackLtp = fallbackQuoteData?.quotes?.[0]?.ltp ?? null;
  const effectiveLtp = ltp ?? fallbackLtp;

  useEffect(() => { if (open) setExit(effectiveLtp != null ? String(effectiveLtp) : String(entryPrice)); }, [open, effectiveLtp, entryPrice]);

  const exitNum = Number(exit);
  const valid = Number.isFinite(exitNum) && exitNum > 0;
  const anchor = effectiveLtp ?? entryPrice;
  const driftPct = valid && anchor > 0 ? Math.abs(exitNum - anchor) / anchor * 100 : 0;
  const warn = valid && driftPct >= 20 && driftPct < 50;
  const block = valid && driftPct >= 50;
  const gross = valid
    ? (side === "long" ? (exitNum - entryPrice) * quantity : (entryPrice - exitNum) * quantity)
    : 0;

  const submit = async () => {
    if (!valid || block) return;
    setBusy(true);
    try { await onConfirm(exitNum); } finally { setBusy(false); }
  };

  return (
    <HudModal open={open} onClose={onClose} title={`Close ${symbol}`} width={420}>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Row label="Side" value={side} />
          <Row label="Quantity" value={String(quantity)} />
          <Row label="Entry" value={inr(entryPrice)} />
          <Row label="LTP" value={effectiveLtp != null ? inr(effectiveLtp) : "—"} />
        </div>
        <div>
          <div style={labelStyle}>Exit price</div>
          <input
            autoFocus
            type="number"
            step="0.05"
            value={exit}
            onChange={(e) => setExit(e.target.value)}
            style={{ ...inputStyle, width: "100%" }}
          />
        </div>
        {valid && (
          <div style={{ fontFamily: "var(--font-hud)", fontSize: 11, letterSpacing: "0.08em" }}>
            P&amp;L: <span style={{ color: gross >= 0 ? "var(--ok)" : "var(--danger)" }}>{inr(gross)}</span>
            {" · "}drift {driftPct.toFixed(1)}% vs {effectiveLtp != null ? "LTP" : "entry"}
          </div>
        )}
        {warn && (
          <div style={{ color: "var(--warn)", fontSize: 11 }}>
            Warning: exit price is more than 20% away from {effectiveLtp != null ? "LTP" : "entry"}. Double-check.
          </div>
        )}
        {block && (
          <div style={{ color: "var(--danger)", fontSize: 11 }}>
            Exit price is more than 50% away from {effectiveLtp != null ? "LTP" : "entry"} — refusing. Edit the price to continue.
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn onClick={submit} disabled={!valid || block || busy} variant="primary">
            {busy ? "closing…" : warn ? "confirm close" : "close"}
          </Btn>
        </div>
      </div>
    </HudModal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <div style={{ fontFamily: "var(--font-hud)" }}>{value}</div>
    </div>
  );
}
function inr(n: number): string { return `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }