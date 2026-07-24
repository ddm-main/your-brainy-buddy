// Compact one-line HUD strip pinned above the Market dashboard rows.
// Surfaces market status, IST clock, key indices, A/D, FII/DII net, and
// the single source-of-truth provider chip (live · kotak / ~15m · yahoo).
// Push ticks from the Kotak WS relay are overlaid on top of REST quotes for
// the four index symbols so NIFTY/BANKNIFTY/SENSEX/VIX go realtime the
// moment the relay is up.
import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useIndices, useBreadth, useMarketStatus } from "@/lib/market/hooks";
import { Chip } from "@/components/hud/HudControls";
import { isFreshTick, useLiveTickStore } from "@/lib/market/liveTickStore";
import { subscribeSymbolsForTicks, useRelayAlive } from "@/lib/market/useRealtimeTicks";

const SLOT_SYMBOLS: Array<{ symbol: string; label: string }> = [
  { symbol: "^NSEI",     label: "NIFTY" },
  { symbol: "^BSESN",    label: "SENSEX" },
  { symbol: "^NSEBANK",  label: "BANKNIFTY" },
  { symbol: "^INDIAVIX", label: "VIX" },
];

const fmtNum = (n: number | null | undefined, d = 2) =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: d });

interface Props {
  actions?: React.ReactNode;
}

export function MarketStrip({ actions }: Props) {
  const nav = useNavigate();
  const { data: indicesData } = useIndices() as { data: any };
  const { data: breadth } = useBreadth();
  const status = useMarketStatus();
  const pushTicks = useLiveTickStore((s) => s.ticks);
  const relayAlive = useRelayAlive();

  // Ask the WS relay to push ticks for the four indices too. Debounced upstream.
  useEffect(() => {
    subscribeSymbolsForTicks(SLOT_SYMBOLS.map((s) => `NSE:${s.symbol}`));
  }, []);

  const bySym = useMemo(() => {
    const m = new Map<string, { price: number; change_pct: number | null }>();
    for (const q of (indicesData?.quotes ?? []) as any[]) {
      // Overlay a fresh push tick when we have one for this symbol.
      const tick = pushTicks[`NSE:${q.symbol}`];
      if (isFreshTick(tick)) {
        m.set(q.symbol, { price: tick.ltp, change_pct: tick.change_pct });
      } else {
        m.set(q.symbol, { price: q.price, change_pct: q.change_pct });
      }
    }
    return m;
  }, [indicesData, pushTicks]);

  const ad = breadth ? { adv: breadth.advances ?? 0, dec: breadth.declines ?? 0 } : null;
  const fiiCr = breadth?.fii_net_cr ?? null;
  const diiCr = breadth?.dii_net_cr ?? null;

  // Provider chip — single source of truth for whether index/quote data is
  // real-time. Push takes precedence: if the relay has emitted for any
  // index (or announced itself), we're on live push ticks.
  const anyIndexPush = SLOT_SYMBOLS.some((s) => isFreshTick(pushTicks[`NSE:${s.symbol}`]));
  const provider = indicesData?.provider as "kotak" | "yahoo" | "mixed" | "cache" | "none" | undefined;
  const chip = (() => {
    if (anyIndexPush || relayAlive) return { tone: "ok" as const, label: "push · kotak", title: "Push ticks from local Kotak Neo WS relay" };
    if (provider === "kotak") return { tone: "ok" as const, label: "live · kotak", title: "Real-time quotes via Kotak Neo" };
    if (provider === "mixed") return { tone: "warn" as const, label: "live · mixed", title: "Kotak for some symbols, Yahoo (~15m delayed) for the rest" };
    if (provider === "cache") return { tone: "warn" as const, label: "cached", title: "Provider unreachable — showing last cached close" };
    if (provider === "yahoo") return { tone: "warn" as const, label: "~15m · yahoo", title: "Yahoo Finance is ~15m delayed on NSE. Connect Kotak Neo for real-time quotes." };
    return { tone: "neutral" as const, label: "no data", title: "" };
  })();

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
          <button
            key={s.symbol}
            onClick={() => nav(`/market/index/${encodeURIComponent(s.symbol)}`)}
            className="focus-outline"
            aria-label={`Open ${s.label} details`}
            title={`Open ${s.label} details`}
            style={{
              display: "inline-flex", gap: 6, alignItems: "baseline",
              background: "transparent", border: 0, padding: "2px 4px",
              margin: 0, cursor: "pointer", font: "inherit", color: "inherit",
              borderRadius: 2,
            }}
          >
            <span style={{ color: "var(--text-muted)" }}>{s.label}</span>
            <span style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{q ? fmtNum(q.price) : "—"}</span>
            <span style={{ color: tone, fontVariantNumeric: "tabular-nums" }}>
              {pct == null ? "" : `${pct > 0 ? "▲" : pct < 0 ? "▼" : ""}${Math.abs(pct).toFixed(2)}%`}
            </span>
          </button>
        );
      })}
      {ad && (ad.adv > 0 || ad.dec > 0) && (
        <button
          onClick={() => nav(`/market?panel=breadth`)}
          className="focus-outline"
          aria-label="Open market breadth details"
          title="Open market breadth details"
          style={{
            display: "inline-flex", gap: 6, alignItems: "baseline",
            background: "transparent", border: 0, padding: "2px 4px",
            margin: 0, cursor: "pointer", font: "inherit", color: "inherit",
            borderRadius: 2,
          }}
        >
          <span style={{ color: "var(--text-muted)" }}>A/D</span>
          <span style={{ color: "var(--ok)" }}>{ad.adv}</span>
          <span style={{ color: "var(--text-dim)" }}>/</span>
          <span style={{ color: "var(--danger)" }}>{ad.dec}</span>
        </button>
      )}
      {(fiiCr != null || diiCr != null) && (
        <span style={{ display: "inline-flex", gap: 6 }} title="FII / DII net flow (₹ crores)">
          <span style={{ color: "var(--text-muted)" }}>FII/DII</span>
          {fiiCr != null && (
            <span style={{ color: fiiCr >= 0 ? "var(--ok)" : "var(--danger)", fontVariantNumeric: "tabular-nums" }}>
              {fiiCr >= 0 ? "+" : ""}{fmtNum(fiiCr, 0)}cr
            </span>
          )}
          {fiiCr != null && diiCr != null && <span style={{ color: "var(--text-dim)" }}>/</span>}
          {diiCr != null && (
            <span style={{ color: diiCr >= 0 ? "var(--ok)" : "var(--danger)", fontVariantNumeric: "tabular-nums" }}>
              {diiCr >= 0 ? "+" : ""}{fmtNum(diiCr, 0)}cr
            </span>
          )}
        </span>
      )}
      <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span title={chip.title}><Chip tone={chip.tone}>{chip.label}</Chip></span>
        {actions}
      </span>
    </div>
  );
}
