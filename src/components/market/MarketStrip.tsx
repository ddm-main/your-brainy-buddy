// Compact one-line HUD strip pinned above the Market dashboard rows.
// Surfaces key indices (incl. GIFT Nifty) and A/D breadth (drill-down).
// Push ticks from the Kotak WS relay are overlaid on top of REST quotes for
// the four index symbols so NIFTY/BANKNIFTY/SENSEX/VIX go realtime the
// moment the relay is up. Auto-refreshes via useIndices polling — no manual button.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useIndices, useBreadth } from "@/lib/market/hooks";
import { isFreshTick, useLiveTickStore, useTicksRevision} from "@/lib/market/liveTickStore";
import { subscribeSymbolsForTicks } from "@/lib/market/useRealtimeTicks";
import { BreadthDetailsDialog } from "@/components/market/BreadthDetailsDialog";
import { PriceSourceChip } from "@/components/market/PriceSourceChip";
import { Return1DCell, deriveChangeAbs } from "@/components/hud/DataTable";

const SLOT_SYMBOLS: Array<{ symbol: string; label: string }> = [
  { symbol: "^NSEI",     label: "NIFTY" },
  { symbol: "^BSESN",    label: "SENSEX" },
  { symbol: "^NSEBANK",  label: "BANKNIFTY" },
  { symbol: "^INDIAVIX", label: "VIX" },
  // GIFT Nifty was listed here as "GIFTNIFTY", which is not a resolvable
  // ticker on either upstream (Yahoo maps it to GIFTNIFTY.NS → 404; Kotak has
  // no NSE token for NSE-IX). It rendered a permanent "—", so it's removed
  // rather than left looking broken.
];

// Sensex is a BSE index; everything else in the strip is NSE. Mirrors
// `indexExchangeFor` in the edge function so both sides key quotes and ticks
// the same way.
const BSE_INDEX_SYMBOLS = new Set(["^BSESN", "SENSEX"]);
const indexExchangeFor = (symbol: string) =>
  BSE_INDEX_SYMBOLS.has(symbol.trim().toUpperCase()) ? "BSE" : "NSE";

// Always two decimals so prices never jitter between 24,316.9 and 24,316.90.
const fmtNum = (n: number | null | undefined, d = 2) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });

interface Props {
  actions?: React.ReactNode;
}

export function MarketStrip({ actions }: Props) {
  const nav = useNavigate();
  const { data: indicesData, dataUpdatedAt: indicesUpdatedAt, isError: indicesError } = useIndices() as { data: any; dataUpdatedAt: number; isError: boolean };
  const { data: breadth } = useBreadth();
  const [breadthOpen, setBreadthOpen] = useState(false);

  const _ticksRev_pushTicks = useTicksRevision();
  const pushTicks = useLiveTickStore.getState().ticks;
  void _ticksRev_pushTicks; // re-render on any tick flush; read fresh map above

  // Ask the WS relay to push ticks for the indices too. Debounced upstream.
  // Sensex is a BSE index — subscribing to it as "NSE:^BSESN" (as this used
  // to) is a pair that can never resolve, so key every slot by its own
  // exchange.
  useEffect(() => {
    subscribeSymbolsForTicks(SLOT_SYMBOLS.map((s) => `${indexExchangeFor(s.symbol)}:${s.symbol}`));
  }, []);

  const bySym = useMemo(() => {
    const m = new Map<string, { price: number | null; change_pct: number | null; change_abs: number | null; reason?: string | null; delayed_blocked?: boolean; source?: string | null; delayed?: boolean }>();
    for (const q of (indicesData?.quotes ?? []) as any[]) {
      // Overlay a push tick only when it's fresh AND actually newer than the
      // last REST refresh — a stale-but-still-"fresh" tick (up to 30s old)
      // must not override a REST print that landed more recently.
      const tick = pushTicks[`${indexExchangeFor(q.symbol)}:${q.symbol}`];
      if (isFreshTick(tick) && Number.isFinite(tick.ltp) && tick.ltp > 0 && tick.receivedAt >= indicesUpdatedAt) {
        m.set(q.symbol, {
          price: tick.ltp,
          change_pct: tick.change_pct,
          change_abs: deriveChangeAbs(tick.ltp, tick.change_pct),
        });
      } else {
        const price = typeof q.price === "number" && Number.isFinite(q.price) && q.price > 0 ? q.price : null;
        m.set(q.symbol, {
          price,
          change_pct: price != null ? q.change_pct : null,
          change_abs: price != null ? q.change_abs ?? deriveChangeAbs(price, q.change_pct) : null,
          reason: q.reason ?? null,
          delayed_blocked: q.delayed_blocked === true,
          source: q.source ?? null,
          delayed: q.delayed === true,
        });
      }
    }
    return m;
  }, [indicesData, pushTicks, indicesUpdatedAt]);


  const ad = breadth ? { adv: breadth.advances ?? 0, dec: breadth.declines ?? 0 } : null;
  const breadthDate = (breadth as any)?.trade_date ?? null;
  const todayIst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const breadthStale = breadthDate && breadthDate !== todayIst;
  const adTitle = breadthDate
    ? `Advances / Declines for ${breadthDate}${breadthStale ? " (last trading session)" : ""} · click for breadth details`
    : "Market breadth unavailable";


  return (
    <>
    <div
      role="region"
      aria-label="Market status strip"
      style={{
        display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap",
        padding: "4px 8px", border: "1px solid var(--edge)", borderRadius: 3,
        fontFamily: "var(--font-mono, var(--font-hud))", fontSize: 13,
        color: "var(--text-dim)", background: "rgba(53,214,237,0.02)",
      }}
    >
      {SLOT_SYMBOLS.map((s) => {
        const q = bySym.get(s.symbol);
        return (
          <button
            key={s.symbol}
            onClick={() => nav(`/market/index/${encodeURIComponent(s.symbol)}`)}
            className="focus-outline"
            aria-label={`Open ${s.label} details`}
            title={q?.reason ? `${s.label}: ${q.reason}` : `Open ${s.label} details`}
            style={{
              display: "inline-flex", gap: 6, alignItems: "baseline",
              background: "transparent", border: 0, padding: "1px 1px",
              margin: 0, cursor: "pointer", font: "inherit", color: "inherit",
              borderRadius: 2,
              // Ticks arrive every second: without a reserved footprint each
              // slot would resize as digits/signs change and shove its
              // neighbours sideways. Fixed columns + tabular figures keep
              // every index pinned in place while the numbers update.
              flex: "0 0 auto", whiteSpace: "nowrap",
            }}
          >
            <span style={{ color: "var(--text-dim)" }}>{s.label}</span>
            <span
              style={{
                color: "var(--text-dim)", fontVariantNumeric: "tabular-nums",
                textAlign: "right",
              }}
            >
              {q?.delayed_blocked
                ? <span className="hud-label" style={{ color: "var(--warn)", fontSize: 9 }}>NO FEED</span>
                : q ? fmtNum(q.price) : "—"}
            </span>
            <span
              style={{
                fontVariantNumeric: "tabular-nums",
                textAlign: "right",
              }}
            >
              <Return1DCell abs={q?.change_abs ?? null} pct={q?.change_pct ?? null} compact />
            </span>

          </button>
        );
      })}


      {/* A/D — always render placeholder so layout doesn't jump */}
      <button
        onClick={() => setBreadthOpen(true)}
        className="focus-outline"
        aria-label="Open market breadth details"
        title={adTitle}
        style={{
          display: "inline-flex", gap: 6, alignItems: "baseline",
          background: "transparent", border: 0, padding: "1px 1px",
          margin: 0, cursor: "pointer", font: "inherit", color: "inherit",
          borderRadius: 2, opacity: breadthStale ? 0.55 : 1,
          flex: "0 0 auto", whiteSpace: "nowrap",
        }}
      >
        <span style={{ color: "var(--text-muted)" }}>A/D</span>
        <span
          style={{
            fontVariantNumeric: "tabular-nums", textAlign: "right",
          }}
        >
          {ad && (ad.adv > 0 || ad.dec > 0) ? (
            <>
              <span style={{ color: "var(--ok)" }}>{ad.adv}</span>
              <span style={{ color: "var(--text-dim)" }}>/</span>
              <span style={{ color: "var(--danger)" }}>{ad.dec}</span>
            </>
          ) : (
            <span style={{ color: "var(--text-dim)" }}>—</span>
          )}
        </span>
      </button>


      <span style={{ marginLeft: actions ? undefined : "auto", display: "inline-flex", alignItems: "center" }}>
        <PriceSourceChip dotOnly stale={indicesError} />
      </span>

      {actions && (
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
          {actions}
        </span>
      )}
    </div>
    <BreadthDetailsDialog open={breadthOpen} onOpenChange={setBreadthOpen} />
    </>
  );
}
