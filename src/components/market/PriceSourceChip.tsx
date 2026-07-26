// Shared chip that surfaces the live-tick pipeline health on any price surface
// (Holdings, Positions, Portfolio, Watchlist, Screener preview). Consolidates
// what MarketStrip renders inline so every panel speaks the same language:
//
//   green dot  — realtime channel joined AND relay is pushing ticks
//   amber dot  — realtime channel joined, no relay yet (REST-only refresh)
//   grey dot   — no realtime channel (auth missing or channel down)
//
// Read-only; subscription lifecycle is owned by `useRealtimeTicks` mounted
// once at the app shell. Panels just render this chip.
import { useLiveTickStore } from "@/lib/market/liveTickStore";

// The chip now renders only the status dot; the textual label is hidden to keep
// panel headers clean. The tooltip still describes the feed state.
export function PriceSourceChip({ compact = false, stale = false, dotOnly = false }: { compact?: boolean; stale?: boolean; dotOnly?: boolean }) {
  const connected = useLiveTickStore((s) => s.connected);
  const relayAlive = useLiveTickStore((s) => s.relayAlive);

  // `stale` — caller-supplied: the REST quote/index query it's paired with
  // is in react-query error state. Previously nothing surfaced this; a
  // failing market-quotes call just froze the last good price forever with
  // no visible signal. Takes priority over the relay-derived label.
  const { label, tone } = stale
    ? { label: "stale", tone: "var(--err, #ef4444)" }
    : relayAlive
    ? { label: "push · kotak", tone: "var(--ok)" }
    : connected
    ? { label: "live · kotak", tone: "var(--accent-soft)" }
    : { label: "rest", tone: "var(--text-dim)" };

  const title = stale
    ? "Price refresh is failing — the value shown is the last one that loaded successfully."
    : relayAlive
    ? "Relay is pushing live ticks over Realtime."
    : connected
    ? "Realtime channel joined; waiting for relay ticks. Prices refresh via REST."
    : "No realtime channel — prices refresh via REST only.";

  if (dotOnly) {
    return (
      <span
        role="img"
        aria-label={`Price feed status: ${label}`}
        title={title}
        style={{
          display: "inline-block",
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: tone,
          boxShadow: relayAlive ? `0 0 6px ${tone}` : "none",
        }}
      />
    );
  }

  return (
    <span
      className="hud-label"
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        color: tone,
        padding: compact ? "0 4px" : "2px 6px",
        border: "1px solid var(--edge)",
        borderRadius: 2,
        fontSize: compact ? 10 : 11,
        letterSpacing: "0.5px",
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: tone,
          boxShadow: relayAlive ? `0 0 6px ${tone}` : "none",
        }}
      />
      {label}
    </span>
  );
}

export default PriceSourceChip;
