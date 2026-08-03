// MarketDepthLadder — 5-level bid/ask ladder with cumulative-qty background
// bars (Kite-style).
//
// Data path: prefers the order book PUSHED by the Kotak WS relay (leased
// depth subscription, see useLiveDepthSubscription) and falls back to the
// REST book from useDepth() when the relay isn't running. Push beats REST on
// both latency and cost — the REST path was polling an edge function once a
// second for a book Kotak already streams.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { DepthResponse } from "@/lib/market/hooks";
import { useLiveDepth } from "@/lib/market/liveDepthStore";
import { useLiveDepthSubscription } from "@/lib/market/useRealtimeTicks";
import { useDepthPanelStore } from "@/lib/market/depthPanelPrefs";
import { useMarketOpen } from "@/lib/market/useMarketOpen";


type Level = { price: number; qty: number; orders?: number };

// Inline container inside the Quote panel — a hairline rule and a small
// caption instead of its own HUD panel chrome.
function Shell({ children }: { children: ReactNode }) {
  return (
    <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--edge)" }}>
      <div className="hud-label" style={{ fontSize: 9, letterSpacing: ".08em", color: "var(--text-muted)", marginBottom: 6 }}>
        Market Depth
      </div>
      {children}
    </div>
  );
}

export function DepthToggleButton({ visible, onClick }: { visible: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hud-label"
      aria-expanded={visible}
      style={{
        fontSize: 9, letterSpacing: ".08em", padding: "2px 8px",
        border: "1px solid var(--edge)", borderRadius: 2,
        background: "transparent", color: "var(--text-dim)", cursor: "pointer",
      }}
    >
      {visible ? "Hide depth" : "Depth"}
    </button>
  );
}

// Rendered inline inside the A1 Quote panel. The Show/Hide control lives in
// the Quote panel header (DepthToggleButton) — this component renders nothing
// at all while hidden, so no subscription and no REST poll runs.
export function MarketDepthLadder({
  depth,
  symbol,
  exchange = "NSE",
}: {
  depth: DepthResponse | undefined;
  symbol?: string;
  exchange?: string;
}) {
  const marketOpen = useMarketOpen();
  const visible = useDepthPanelStore((s) => s.visible);
  useLiveDepthSubscription(symbol, visible && marketOpen);
  const pushed = useLiveDepth(symbol ? `${exchange.toUpperCase()}:${symbol.toUpperCase()}` : null);

  if (!visible) return null;

  // Depth is a market-hours-only feed — say so in one line instead of
  // showing an empty ladder.
  if (!marketOpen) {
    return (
      <Shell>
        <div className="hud-label" style={{ fontSize: 11, color: "var(--text-dim)" }}>
          Order book resumes at the next session — market is closed.
        </div>
      </Shell>
    );
  }

  // Prefer the pushed book only when it actually carries levels; otherwise the
  // REST book wins (an empty push must not blank a good REST ladder).
  const usePushed = (pushed?.bids.length ?? 0) > 0 || (pushed?.asks.length ?? 0) > 0;
  const bidsSrc = usePushed ? pushed!.bids : depth?.bids;
  const asksSrc = usePushed ? pushed!.asks : depth?.asks;

  if (!usePushed && !depth) {
    // Panel must stay mounted while the first book loads — returning null made
    // the whole A2 slot pop in and out and reflow the grid.
    return (
      <Shell>
        <div className="hud-label" style={{ fontSize: 11, color: "var(--text-dim)" }}>
          Loading order book…
        </div>
      </Shell>
    );
  }
  // Depth is a broker-only, market-hours-only feed. An empty book has several
  // very different causes — only ONE of them is "connect your broker", and
  // showing that message for all of them was simply wrong.
  if ((bidsSrc?.length ?? 0) === 0 && (asksSrc?.length ?? 0) === 0) {
    const code = depth?.reason_code;
    const copy =
      code === "market_closed" ? "Order book resumes at the next session — market is closed."
      : code === "no_token" || code === "unsupported" ? "Depth isn't available for this instrument."
      : code === "not_connected" ? null
      : "Broker feed hiccup — retrying.";
    return (
      <Shell>
        <div className="hud-label" style={{ fontSize: 11, lineHeight: 1.6, color: "var(--text-dim)" }}>
          {copy ?? (
            <>
              Order book needs a live Kotak Neo session. Connect it in{" "}
              <Link to="/market/settings" style={{ color: "var(--accent)" }}>Settings → Broker</Link>.
            </>
          )}
          {depth?.reason && code !== "market_closed" && (
            <div style={{ marginTop: 4, fontSize: 10, opacity: 0.6 }}>{depth.reason}</div>
          )}
        </div>
      </Shell>
    );
  }


  // Guard against a malformed level (NaN price/qty) poisoning the totals.
  const clean = (levels: Level[] | undefined) =>
    (levels ?? [])
      .filter((l) => Number.isFinite(l?.price) && Number.isFinite(l?.qty))
      .slice(0, 5)
      .map((l) => ({ ...l, qty: Math.max(0, l.qty), orders: Number.isFinite(l.orders as number) ? l.orders : undefined }));
  const bids = clean(bidsSrc as Level[] | undefined);
  const asks = clean(asksSrc as Level[] | undefined);

  const cum = (levels: Level[]) => {
    let acc = 0;
    return levels.map((l) => ({ ...l, cum: (acc += l.qty) }));
  };
  const cBids = cum(bids);
  const cAsks = cum(asks);
  const maxCum = Math.max(
    cBids[cBids.length - 1]?.cum ?? 0,
    cAsks[cAsks.length - 1]?.cum ?? 0,
    1,
  );

  const totalBidQty = cBids[cBids.length - 1]?.cum ?? 0;
  const totalAskQty = cAsks[cAsks.length - 1]?.cum ?? 0;
  const total = totalBidQty + totalAskQty;
  // Total order counts across the five levels — the ladder printed a per-level
  // "Ord" column but never totalled it, which is the number traders read.
  const sumOrders = (levels: Level[]) =>
    levels.reduce((n, l) => n + (Number.isFinite(l.orders as number) ? (l.orders as number) : 0), 0);
  const totalBidOrders = sumOrders(bids);
  const totalAskOrders = sumOrders(asks);
  const hasOrderCounts = totalBidOrders + totalAskOrders > 0;
  // Order-book imbalance: >50% means buy pressure dominates.
  const buyPct = total > 0 ? (totalBidQty / total) * 100 : 50;

  const Row = ({ side, level }: { side: "bid" | "ask"; level: Level & { cum: number } }) => {
    const color = side === "bid" ? "var(--ok)" : "var(--danger)";
    const bg = side === "bid"
      ? "color-mix(in oklab, var(--ok) 12%, transparent)"
      : "color-mix(in oklab, var(--danger) 12%, transparent)";
    const barPct = Math.min(100, (level.cum / maxCum) * 100);
    return (
      <div style={{
        position: "relative", display: "grid",
        gridTemplateColumns: side === "bid" ? "auto 1fr auto" : "auto 1fr auto",
        gap: 6, padding: "2px 6px", fontSize: 11,
        fontVariantNumeric: "tabular-nums", borderBottom: "1px solid var(--edge)",
      }}>
        <div style={{
          position: "absolute", top: 0, bottom: 0,
          [side === "bid" ? "right" : "left"]: 0,
          width: `${barPct}%`, background: bg, pointerEvents: "none",
        }} />
        <span style={{ color, position: "relative" }}>{level.price.toFixed(2)}</span>
        <span style={{ color: "var(--text-dim)", textAlign: "center", position: "relative" }}>
          {level.orders ? level.orders.toLocaleString("en-IN") : "—"}
        </span>
        <span style={{ color: "var(--text)", textAlign: "right", position: "relative" }}>
          {level.qty.toLocaleString("en-IN")}
        </span>
      </div>
    );
  };

  return (
    <Shell>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <div className="hud-label" style={{
            display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 6,
            padding: "0 6px 4px", color: "var(--ok)", fontSize: 9,
          }}>
            <span>Bid</span><span style={{ textAlign: "center" }}>Ord</span><span style={{ textAlign: "right" }}>Qty</span>
          </div>
          {cBids.map((b, i) => <Row key={i} side="bid" level={b} />)}
          <div className="hud-label" style={{
            display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 6,
            padding: "4px 6px 0", fontSize: 9, color: "var(--text-dim)",
            fontVariantNumeric: "tabular-nums",
          }}>
            <span>Total</span>
            <span style={{ textAlign: "center", color: "var(--text)" }}>
              {hasOrderCounts ? totalBidOrders.toLocaleString("en-IN") : "—"}
            </span>
            <span style={{ textAlign: "right", color: "var(--ok)" }}>{totalBidQty.toLocaleString("en-IN")}</span>
          </div>
        </div>
        <div>
          <div className="hud-label" style={{
            display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 6,
            padding: "0 6px 4px", color: "var(--danger)", fontSize: 9,
          }}>
            <span>Ask</span><span style={{ textAlign: "center" }}>Ord</span><span style={{ textAlign: "right" }}>Qty</span>
          </div>
          {cAsks.map((a, i) => <Row key={i} side="ask" level={a} />)}
          <div className="hud-label" style={{
            display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 6,
            padding: "4px 6px 0", fontSize: 9, color: "var(--text-dim)",
            fontVariantNumeric: "tabular-nums",
          }}>
            <span>Total</span>
            <span style={{ textAlign: "center", color: "var(--text)" }}>
              {hasOrderCounts ? totalAskOrders.toLocaleString("en-IN") : "—"}
            </span>
            <span style={{ textAlign: "right", color: "var(--danger)" }}>{totalAskQty.toLocaleString("en-IN")}</span>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 10 }}>
        <div>
          <div className="hud-label" style={{ color: "var(--text-dim)", marginBottom: 2 }}>
            Bid Qty: <span style={{ color: "var(--ok)" }}>{totalBidQty.toLocaleString("en-IN")}</span>
          </div>
          <div className="hud-label" style={{ color: "var(--text-dim)" }}>
            Ask Qty: <span style={{ color: "var(--danger)" }}>{totalAskQty.toLocaleString("en-IN")}</span>
          </div>
        </div>
        <div>
          <div className="hud-label" style={{ color: "var(--text-dim)", marginBottom: 2 }}>Imbalance</div>
          <div style={{
            position: "relative", height: 6, background: "color-mix(in oklab, var(--danger) 25%, transparent)",
            borderRadius: 2, overflow: "hidden",
          }}>
            <div style={{
              position: "absolute", left: 0, top: 0, bottom: 0,
              width: `${buyPct.toFixed(1)}%`, background: "var(--ok)",
            }} />
          </div>
          <div style={{ marginTop: 2, color: "var(--text-dim)" }}>
            {buyPct.toFixed(0)}% buy · {(100 - buyPct).toFixed(0)}% sell
          </div>
        </div>
      </div>
    </Shell>
  );
}
