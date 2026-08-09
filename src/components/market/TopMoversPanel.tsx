// Top Movers — Gainers/Losers toggle. Reads the market_top_movers view
// (backed by a daily materialized view refreshed by the aggregates pipeline).
// Overlays push ticks from the Kotak WS relay so the rows tick in real time
// during market hours instead of showing yesterday's close/change_pct.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { useTopMovers } from "@/lib/market/hooks";
import { Return1DCell, deriveChangeAbs } from "@/components/hud/DataTable";
import { isFreshTick, useLiveTickStore, useTicksRevision} from "@/lib/market/liveTickStore";
import { subscribeSymbolsForTicks } from "@/lib/market/useRealtimeTicks";

type Dir = "gain" | "lose";

export function TopMoversPanel() {
  const nav = useNavigate();
  const [dir, setDir] = useState<Dir>("gain");
  const { data = [], isFetching } = useTopMovers();

  const rows = useMemo(
    () => data.filter((r) => r.direction === dir).slice(0, 10),
    [data, dir],
  );

  // Ask the relay to push ticks for the symbols currently on screen — Top
  // Movers rotates independently of the default universe subscription.
  const keys = useMemo(
    () => rows.map((r) => `${r.exchange}:${r.symbol}`),
    [rows],
  );
  useEffect(() => { subscribeSymbolsForTicks(keys); }, [keys]);
  const _ticksRev_liveTicks = useTicksRevision();
  const liveTicks = useLiveTickStore.getState().ticks;
  void _ticksRev_liveTicks; // re-render on any tick flush; read fresh map above

  // Freshness: EOD rows carry the session they were computed for. If any row
  // is ticking from the relay the panel is live; otherwise show which session
  // the numbers belong to so a stale pipeline is never mistaken for live data.
  const anyLive = rows.some((r) => isFreshTick(liveTicks[`${r.exchange}:${r.symbol}`]));
  const tradeDate = rows.find((r) => r.trade_date)?.trade_date ?? null;
  const todayIso = new Date().toISOString().slice(0, 10);
  const stale = !anyLive && !!tradeDate && tradeDate < todayIso;
  const chipLabel = anyLive ? "live" : tradeDate ? `EOD ${tradeDate}` : "no session";
  const chipColor = anyLive ? "var(--ok, #35d67a)" : stale ? "var(--warn, #e0b23a)" : "var(--text-dim)";

  return (
    <HudPanel flow title="Top Movers" actions={
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <span
          className="hud-label"
          title={anyLive ? "Streaming push ticks" : `Latest completed session: ${tradeDate ?? "unknown"}`}
          style={{
            fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase",
            color: chipColor, border: `1px solid ${chipColor}`, borderRadius: 2,
            padding: "2px 6px", marginRight: 2, whiteSpace: "nowrap",
          }}
        >{chipLabel}</span>
        {(["gain", "lose"] as const).map((d) => (
          <button
            key={d}
            onClick={() => setDir(d)}
            className="focus-outline"
            style={{
              padding: "3px 8px", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase",
              background: dir === d ? "rgba(53,214,237,0.12)" : "transparent",
              color: dir === d ? "var(--accent)" : "var(--text-dim)",
              border: `1px solid ${dir === d ? "var(--accent)" : "var(--edge)"}`,
              borderRadius: 2, cursor: "pointer",
            }}
          >{d === "gain" ? "Gainers" : "Losers"}</button>
        ))}
      </div>
    }>

      {rows.length === 0 ? (
        <div className="hud-label" style={{ color: "var(--text-dim)", fontSize: 11 }}>
          {isFetching ? "loading…" : "no data yet — waiting on pipeline"}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {rows.map((r) => {
            const key = `${r.exchange}:${r.symbol}`;
            const tick = liveTicks[key];
            const usePush = isFreshTick(tick);
            const close = usePush ? tick.ltp : r.close;
            const pct = usePush ? (tick.change_pct ?? r.change_pct ?? null) : (r.change_pct ?? null);
            const abs = deriveChangeAbs(close, pct);
            return (
              <button
                key={key}
                onClick={() => nav(`/market/analysis/${r.symbol}?exchange=${r.exchange}`)}
                className="focus-outline"
                style={{
                  display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: 6,
                  padding: "5px 4px",
                  background: "transparent", border: 0, borderBottom: "1px solid var(--edge)",
                  fontSize: 12, cursor: "pointer", textAlign: "left", alignItems: "baseline",
                }}
                title={`${r.symbol} · ${r.exchange}${r.sector ? " · " + r.sector : ""}${usePush ? " · push · kotak" : ""}`}
              >
                <span style={{ color: "var(--accent)", fontVariantNumeric: "tabular-nums", minWidth: 18 }}>{r.rn}.</span>
                <span>
                  <span style={{ color: "var(--text)" }}>{r.symbol}</span>
                  {r.sector && <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 10 }}>{r.sector}</span>}
                </span>
                <span style={{ color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
                  {close == null ? "—" : `₹${close.toFixed(2)}`}
                </span>
                <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 120, textAlign: "right" }}>
                  <Return1DCell abs={abs} pct={pct} />
                </span>
              </button>
            );
          })}
        </div>
      )}
    </HudPanel>
  );
}
