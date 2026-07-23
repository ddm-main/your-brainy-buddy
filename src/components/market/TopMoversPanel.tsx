// Top Movers — Gainers/Losers toggle. Reads the market_top_movers view
// (backed by a daily materialized view refreshed by the aggregates pipeline).
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { useTopMovers } from "@/lib/market/hooks";

type Dir = "gain" | "lose";

export function TopMoversPanel() {
  const nav = useNavigate();
  const [dir, setDir] = useState<Dir>("gain");
  const { data = [], isFetching } = useTopMovers();

  const rows = useMemo(
    () => data.filter((r) => r.direction === dir).slice(0, 10),
    [data, dir],
  );

  return (
    <HudPanel flow title="Top Movers" actions={
      <div style={{ display: "flex", gap: 4 }}>
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
            const pct = r.change_pct ?? 0;
            const tone = pct >= 0 ? "var(--ok)" : "var(--danger)";
            return (
              <button
                key={`${r.exchange}:${r.symbol}`}
                onClick={() => nav(`/market/analysis/${r.symbol}?exchange=${r.exchange}`)}
                className="focus-outline"
                style={{
                  display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: 6,
                  padding: "5px 4px",
                  background: "transparent", border: 0, borderBottom: "1px solid var(--edge)",
                  fontSize: 12, cursor: "pointer", textAlign: "left", alignItems: "baseline",
                }}
                title={`${r.symbol} · ${r.exchange}${r.sector ? " · " + r.sector : ""}`}
              >
                <span style={{ color: "var(--accent)", fontVariantNumeric: "tabular-nums", minWidth: 18 }}>{r.rn}.</span>
                <span>
                  <span style={{ color: "var(--text)" }}>{r.symbol}</span>
                  {r.sector && <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 10 }}>{r.sector}</span>}
                </span>
                <span style={{ color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
                  {r.close == null ? "—" : `₹${r.close.toFixed(2)}`}
                </span>
                <span style={{ color: tone, fontVariantNumeric: "tabular-nums", minWidth: 62, textAlign: "right" }}>
                  {`${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </HudPanel>
  );
}
