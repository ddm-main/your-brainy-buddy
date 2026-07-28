// MarketDepthLadder — 5-level bid/ask ladder with cumulative-qty background
// bars (Kite-style). Consumes useDepth() output.
import { HudPanel } from "@/components/hud/HudPanel";
import type { DepthResponse } from "@/lib/market/hooks";

type Level = { price: number; qty: number; orders?: number };

export function MarketDepthLadder({ depth }: { depth: DepthResponse | undefined }) {
  if (!depth) return null;
  // Depth is a broker-only feed: Yahoo has no order book. Rendering nothing at
  // all made the panel look broken; say why it's empty instead.
  if (depth.bids.length === 0 && depth.asks.length === 0) {
    return (
      <HudPanel flow title="Market Depth" index="A2">
        <div className="hud-label" style={{ fontSize: 11, lineHeight: 1.6, color: "var(--text-dim)" }}>
          Order book unavailable — depth requires a connected Kotak Neo session.
          Connect it in <span style={{ color: "var(--accent)" }}>Settings → Broker</span>.
        </div>
      </HudPanel>
    );
  }

  const bids = depth.bids.slice(0, 5) as Level[];
  const asks = depth.asks.slice(0, 5) as Level[];
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
          {level.orders ?? "—"}
        </span>
        <span style={{ color: "var(--text)", textAlign: "right", position: "relative" }}>
          {level.qty.toLocaleString("en-IN")}
        </span>
      </div>
    );
  };

  return (
    <HudPanel flow title="Market Depth" index="A2">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <div className="hud-label" style={{
            display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 6,
            padding: "0 6px 4px", color: "var(--ok)", fontSize: 9,
          }}>
            <span>Bid</span><span style={{ textAlign: "center" }}>Ord</span><span style={{ textAlign: "right" }}>Qty</span>
          </div>
          {cBids.map((b, i) => <Row key={i} side="bid" level={b} />)}
        </div>
        <div>
          <div className="hud-label" style={{
            display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 6,
            padding: "0 6px 4px", color: "var(--danger)", fontSize: 9,
          }}>
            <span>Ask</span><span style={{ textAlign: "center" }}>Ord</span><span style={{ textAlign: "right" }}>Qty</span>
          </div>
          {cAsks.map((a, i) => <Row key={i} side="ask" level={a} />)}
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
    </HudPanel>
  );
}
