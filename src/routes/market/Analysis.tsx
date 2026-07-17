// Stock Analysis — candlestick chart + indicator readouts + breakout scores.
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { CandleChart } from "@/components/market/CandleChart";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { fmtNum, fmtInt, fmtPct } from "@/components/hud/DataTable";
import { useCandles, useFundamentals, useQuotes, useSectorStrength, useStockScores } from "@/lib/market/hooks";

const TIMEFRAMES = ["1D", "1h", "15m"];

export default function Analysis() {
  const { symbol } = useParams();
  const nav = useNavigate();
  const [tf, setTf] = useState("1D");
  const [showEmas, setShowEmas] = useState(true);
  const [search, setSearch] = useState("");

  const sym = symbol?.toUpperCase();
  const { data: candleData, isLoading, error } = useCandles(sym, tf);
  const { data: scores = [] } = useStockScores({ symbol: sym, limit: 1 });
  const score = scores[0];
  const { data: quotesData } = useQuotes(sym ? [`NSE:${sym}`] : []);
  const quote = quotesData?.quotes?.[0];
  const { data: sectors = [] } = useSectorStrength();
  const { data: fundData } = useFundamentals(sym);
  const f = fundData?.fundamentals;
  const sectorRow = useMemo(
    () => sectors.find((s) => s.sector === score?.sector),
    [sectors, score],
  );


  const priceLines = useMemo(() => {
    const lines: Array<{ price: number; label: string; color: string }> = [];
    if (score?.resistance_level) lines.push({ price: score.resistance_level, label: "R", color: "#ffb84d" });
    if (score?.support_level) lines.push({ price: score.support_level, label: "S", color: "#6bffb0" });
    return lines;
  }, [score]);

  if (!sym) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <HudPanel flow title="Stock Analysis" index="MK.ANL">
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", maxWidth: 400 }}>
            <div style={{ flex: 1 }}>
              <div style={labelStyle}>Symbol</div>
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && search.trim()) nav(`/market/analysis/${search.trim().toUpperCase()}`); }}
                placeholder="RELIANCE" style={inputStyle} autoFocus />
            </div>
            <Btn variant="primary" onClick={() => search.trim() && nav(`/market/analysis/${search.trim().toUpperCase()}`)}>Analyze</Btn>
          </div>
          <div style={{ marginTop: 12 }}>
            <EmptyState hint="or click any symbol in Screener / Holdings / Dashboard">enter a symbol to analyze</EmptyState>
          </div>
        </HudPanel>
      </div>
    );
  }

  const ltp = quote?.ltp ?? score?.close ?? null;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 12, alignItems: "start" }}>
      {/* Chart column */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <HudPanel
          flow
          title={`${sym} · ${tf}`}
          index="MK.ANL"
          live={isLoading ? "warn" : "ok"}
          actions={
            <div style={{ display: "flex", gap: 6 }}>
              {TIMEFRAMES.map((t) => (
                <Btn key={t} size="sm" variant={tf === t ? "primary" : "ghost"} onClick={() => setTf(t)}>{t}</Btn>
              ))}
              <Btn size="sm" variant={showEmas ? "primary" : "ghost"} onClick={() => setShowEmas((v) => !v)}>EMA</Btn>
            </div>
          }
        >
          {error ? (
            <EmptyState hint={String((error as Error).message ?? "")}>chart unavailable</EmptyState>
          ) : isLoading || !candleData ? (
            <div className="hud-label" style={{ padding: 24, textAlign: "center" }}>loading candles…</div>
          ) : candleData.candles.length === 0 ? (
            <EmptyState hint="unknown symbol, or data pipeline hasn't covered it yet">no candle data</EmptyState>
          ) : (
            <CandleChart
              candles={candleData.candles}
              emas={showEmas && tf === "1D" ? candleData.emas : undefined}
              priceLines={tf === "1D" ? priceLines : undefined}
              height={440}
            />
          )}
        </HudPanel>
      </div>

      {/* Right rail */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <HudPanel flow title="Quote" index="A1">
          <div style={{ fontFamily: "var(--font-display)", fontSize: 26, color: "var(--accent)" }}>
            {ltp != null ? `₹${fmtNum(ltp)}` : "—"}
          </div>
          <div style={{ fontSize: 13, color: (quote?.change_pct ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}>
            {quote?.change_pct != null ? fmtPct(quote.change_pct) : "—"}
            {quote?.day_change != null && <span style={{ marginLeft: 8 }}>({fmtNum(quote.day_change)})</span>}
          </div>
          {score?.sector && <div style={{ marginTop: 6 }}><Chip tone="accent">{score.sector}</Chip></div>}
        </HudPanel>

        <HudPanel flow title="Breakout Intelligence" index="A2">
          <Row label="Breakout">
            <ScoreBadge score={score?.breakout_score} components={score?.score_components?.breakout} label="breakout components" />
          </Row>
          <Row label="Pre-Breakout">
            <ScoreBadge score={score?.prebreakout_score} components={score?.score_components?.prebreakout} label="pre-breakout components" />
          </Row>
          <Row label="Setups">
            <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {score?.bb_squeeze && <Chip tone="accent">BB squeeze</Chip>}
              {score?.higher_lows && <Chip tone="ok">higher lows</Chip>}
              {score?.near_resistance && <Chip tone="warn">near resistance</Chip>}
              {score?.above_ema200 && <Chip tone="ok">&gt;200 EMA</Chip>}
              {!score && <span style={{ color: "var(--text-muted)", fontSize: 11 }}>pipeline pending</span>}
            </span>
          </Row>
          <Row label="Resistance" mono>{fmtNum(score?.resistance_level)}</Row>
          <Row label="Support" mono>{fmtNum(score?.support_level)}</Row>
        </HudPanel>

        <HudPanel flow title="Indicators (Daily)" index="A3">
          <Row label="RSI (14)" mono>{fmtNum(score?.rsi14, 1)}</Row>
          <Row label="MACD" mono>{fmtNum(score?.macd, 2)} / {fmtNum(score?.macd_signal, 2)}</Row>
          <Row label="ADX (14)" mono>{fmtNum(score?.adx14, 1)}</Row>
          <Row label="ATR %" mono>{fmtNum(score?.atr_pct, 2)}</Row>
          <Row label="BB Width" mono>{fmtNum(score?.bb_width, 3)}</Row>
          <Row label="Rel Volume" mono>{fmtNum(score?.rel_volume, 2)}</Row>
          <Row label="Volume" mono>{fmtInt(score?.volume)}</Row>
        </HudPanel>

        <HudPanel flow title="Range & Strength" index="A4">
          <Row label="52w High" mono>{fmtNum(score?.high_52w)}</Row>
          <Row label="52w Low" mono>{fmtNum(score?.low_52w)}</Row>
          <Row label="From 52w High" mono>
            <span style={{ color: (score?.pct_from_52w_high ?? 0) > -5 ? "var(--ok)" : "var(--text)" }}>
              {fmtPct(score?.pct_from_52w_high)}
            </span>
          </Row>
          <Row label="RS vs NIFTY" mono>{fmtNum(score?.rel_strength_nifty, 1)}</Row>
          <Row label="Sector Rank" mono>
            {sectorRow?.strength_rank != null ? `#${sectorRow.strength_rank} of ${sectors.length}` : "—"}
          </Row>
          <Row label="EMA 20/50/200" mono>
            <span style={{ fontSize: 10 }}>{fmtNum(score?.ema20, 0)} / {fmtNum(score?.ema50, 0)} / {fmtNum(score?.ema200, 0)}</span>
          </Row>
        </HudPanel>
      </div>
    </div>
  );
}

function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid var(--edge)", fontSize: 12 }}>
      <span className="hud-label" style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={mono ? { fontVariantNumeric: "tabular-nums", color: "var(--text)" } : undefined}>{children}</span>
    </div>
  );
}
