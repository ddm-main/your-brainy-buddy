// Compact one-line HUD strip pinned above the Market dashboard rows.
// Surfaces market status, IST clock, key indices, A/D, and FII/DII net.
// All timing/tick logic is delegated to the shared useMarketStatus hook
// so re-renders are throttled off-hours and paused when the tab is hidden.
import { useMemo } from "react";
import { useIndices, useBreadth, useMarketStatus } from "@/lib/market/hooks";

const SLOT_SYMBOLS: Array<{ symbol: string; label: string }> = [
  { symbol: "^NSEI",     label: "NIFTY" },
  { symbol: "^BSESN",    label: "SENSEX" },
  { symbol: "^NSEBANK",  label: "BANKNIFTY" },
  { symbol: "^INDIAVIX", label: "VIX" },
];

const fmtNum = (n: number | null | undefined, d = 2) =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: d });

export function MarketStrip() {
  const { data: indicesData } = useIndices();
  const { data: breadth } = useBreadth();
  const status = useMarketStatus();

  const bySym = useMemo(() => {
    const m = new Map<string, { price: number; change_pct: number | null }>();
    for (const q of indicesData?.quotes ?? []) m.set(q.symbol, { price: q.price, change_pct: q.change_pct });
    return m;
  }, [indicesData]);

  const ad = breadth ? { adv: breadth.advances ?? 0, dec: breadth.declines ?? 0 } : null;
  // FIX (was silently null): the columns are fii_net_cr / dii_net_cr, already
  // stored in crores; the previous code read fii_net_cash and divided by 1e7,
  // which produced NaN and never rendered.
  const fiiCr = breadth?.fii_net_cr ?? null;
  const diiCr = breadth?.dii_net_cr ?? null;

  return (
    <div
      role="region"
      aria-label="Market status strip"
      style={{
        display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
        padding: "6px 10px", border: "1px solid var(--edge)", borderRadius: 3,
        fontFamily: "var(--font-mono, var(--font-hud))", fontSize: 11,
        color: "var(--text-dim)", background: "rgba(53,214,237,0.02)",
      }}
    >
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        color: status.open ? "var(--ok)" : "var(--text-dim)",
      }}>
        <span aria-hidden style={{
          width: 6, height: 6, borderRadius: "50%",
          background: status.open ? "var(--ok)" : "var(--text-muted)",
          boxShadow: status.open ? "0 0 6px var(--ok)" : "none",
        }} />
        <span style={{ letterSpacing: "0.1em" }}>{status.label.toUpperCase()}</span>
      </span>
      <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }} title="IST clock">
        {status.istClock}
      </span>
      {SLOT_SYMBOLS.map((s) => {
        const q = bySym.get(s.symbol);
        const pct = q?.change_pct;
        const tone = pct == null ? "var(--text-dim)" : pct >= 0 ? "var(--ok)" : "var(--danger)";
        return (
          <span key={s.symbol} style={{ display: "inline-flex", gap: 6 }}>
            <span style={{ color: "var(--text-muted)" }}>{s.label}</span>
            <span style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{q ? fmtNum(q.price) : "—"}</span>
            <span style={{ color: tone, fontVariantNumeric: "tabular-nums" }}>
              {pct == null ? "" : `${pct > 0 ? "▲" : pct < 0 ? "▼" : ""}${Math.abs(pct).toFixed(2)}%`}
            </span>
          </span>
        );
      })}
      {ad && (ad.adv > 0 || ad.dec > 0) && (
        <span style={{ display: "inline-flex", gap: 6 }}>
          <span style={{ color: "var(--text-muted)" }}>A/D</span>
          <span style={{ color: "var(--ok)" }}>{ad.adv}</span>
          <span style={{ color: "var(--text-dim)" }}>/</span>
          <span style={{ color: "var(--danger)" }}>{ad.dec}</span>
        </span>
      )}
      {(fiiCr != null || diiCr != null) && (
        <span style={{ display: "inline-flex", gap: 6 }} title="FII / DII net flow (₹ crores)">
          <span style={{ color: "var(--text-muted)" }}>FII/DII</span>
          {fiiCr != null && (
            <span style={{ color: fiiCr >= 0 ? "var(--ok)" : "var(--danger)", fontVariantNumeric: "tabular-nums" }}>
              {fiiCr >= 0 ? "+" : ""}{fmtNum(fiiCr, 0)}cr
            </span>
          )}
          {diiCr != null && (
            <span style={{ color: diiCr >= 0 ? "var(--ok)" : "var(--danger)", fontVariantNumeric: "tabular-nums" }}>
              {diiCr >= 0 ? "+" : ""}{fmtNum(diiCr, 0)}cr
            </span>
          )}
        </span>
      )}
    </div>
  );
}
