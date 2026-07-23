// Compact breadth tile for the Market Overview.
// Reads the single-row market_breadth_latest view via useBreadth.
import { HudPanel } from "@/components/hud/HudPanel";
import { useBreadth } from "@/lib/market/hooks";

function Cell({ label, value, tone, title }: {
  label: string; value: string; tone?: "ok" | "err" | "warn" | "accent"; title?: string;
}) {
  const color = tone === "ok" ? "var(--ok)"
    : tone === "err" ? "var(--danger)"
    : tone === "warn" ? "var(--warn)"
    : tone === "accent" ? "var(--accent)"
    : "var(--text)";
  return (
    <div title={title} style={{ padding: "6px 8px", border: "1px solid var(--edge)", borderRadius: 2 }}>
      <div className="hud-label" style={{ color: "var(--text-dim)", fontSize: 9 }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 14, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

const fmtPct = (n: number | null | undefined) =>
  n == null ? "—" : `${n.toFixed(1)}%`;
const fmtInt = (n: number | null | undefined) =>
  n == null ? "—" : Math.round(n).toLocaleString("en-IN");
const fmtNum = (n: number | null | undefined, d = 2) =>
  n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: d });

export function BreadthPanel() {
  const { data: b } = useBreadth();
  if (!b) {
    return (
      <HudPanel flow title="Breadth">
        <div className="hud-label" style={{ color: "var(--text-dim)", fontSize: 11 }}>no breadth data yet</div>
      </HudPanel>
    );
  }
  const regimeTone: "ok" | "err" | "warn" | "accent" =
    b.regime === "bullish" ? "ok"
    : b.regime === "bearish" ? "err"
    : b.regime === "neutral" ? "warn"
    : "accent";
  const advDec = (b.advances ?? 0) - (b.declines ?? 0);
  return (
    <HudPanel flow title="Breadth" actions={
      <span className="hud-label" style={{ color: "var(--text-dim)", fontSize: 10 }}>
        {b.trade_date}
      </span>
    }>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 4 }}>
        <Cell label="Regime" value={b.regime ?? "—"} tone={regimeTone} />
        <Cell
          label="A / D"
          value={`${fmtInt(b.advances)} / ${fmtInt(b.declines)}`}
          tone={advDec > 0 ? "ok" : advDec < 0 ? "err" : undefined}
          title={`Advances vs Declines${b.unchanged != null ? ` · ${b.unchanged} unchanged` : ""}`}
        />
        <Cell label="% > EMA200" value={fmtPct(b.pct_above_ema200)} tone={(b.pct_above_ema200 ?? 0) >= 50 ? "ok" : "err"} />
        <Cell label="% > EMA50" value={fmtPct(b.pct_above_ema50)} />
        <Cell label="Avg RSI" value={b.avg_rsi == null ? "—" : b.avg_rsi.toFixed(1)}
              tone={(b.avg_rsi ?? 0) >= 60 ? "ok" : (b.avg_rsi ?? 0) <= 40 ? "err" : undefined} />
        <Cell label="New Hi / Lo" value={`${fmtInt(b.new_highs)} / ${fmtInt(b.new_lows)}`}
              tone={(b.new_highs ?? 0) > (b.new_lows ?? 0) ? "ok" : "err"} />
        <Cell label="India VIX" value={fmtNum(b.india_vix)}
              tone={(b.india_vix ?? 0) >= 20 ? "err" : (b.india_vix ?? 0) <= 12 ? "ok" : "warn"} />
        <Cell label="Score" value={b.market_score == null ? "—" : b.market_score.toFixed(0)}
              tone={(b.market_score ?? 0) >= 60 ? "ok" : (b.market_score ?? 0) <= 40 ? "err" : "warn"} />
      </div>
    </HudPanel>
  );
}
