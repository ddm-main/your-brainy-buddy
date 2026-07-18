// Stock Analysis — TradingView-style chart workbench + indicator readouts.
// Chart fills the viewport height; indicators are computed client-side in
// CandleChart, so toggles work even before the EOD pipeline has run.
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { CandleChart, type ChartType, type IndicatorFlags } from "@/components/market/CandleChart";
import { TradingViewChart, tvInterval } from "@/components/market/TradingViewChart";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { fmtNum, fmtInt, fmtPct } from "@/components/hud/DataTable";
import { useCandles, useDepth, useFundamentals, useQuotes, useSectorStrength, useStockScores } from "@/lib/market/hooks";
import { ExternalLink } from "lucide-react";

const TIMEFRAMES = ["1D", "1h", "15m", "5m"];
const CHART_TYPES: Array<{ key: ChartType; label: string }> = [
  { key: "candles", label: "Candles" },
  { key: "bars", label: "Bars" },
  { key: "line", label: "Line" },
  { key: "area", label: "Area" },
];
const INDICATOR_DEFS: Array<{ key: keyof IndicatorFlags; label: string }> = [
  { key: "ema20", label: "EMA20" },
  { key: "ema50", label: "EMA50" },
  { key: "ema200", label: "EMA200" },
  { key: "sma20", label: "SMA20" },
  { key: "bb", label: "BB" },
  { key: "vwap", label: "VWAP" },
  { key: "rsi", label: "RSI" },
  { key: "macd", label: "MACD" },
  { key: "volume", label: "VOL" },
];
const IND_STORE = "jarvis.analysis.indicators";
const defaultFlags: IndicatorFlags = { ema20: true, ema50: true, volume: true };

export default function Analysis() {
  const { symbol } = useParams();
  const nav = useNavigate();
  const [tf, setTf] = useState("1D");
  const [chartType, setChartType] = useState<ChartType>("candles");
  const [tvMode, setTvMode] = useState(false);
  const [flags, setFlags] = useState<IndicatorFlags>(() => {
    try { return { ...defaultFlags, ...JSON.parse(localStorage.getItem(IND_STORE) ?? "{}") }; }
    catch { return defaultFlags; }
  });
  const [search, setSearch] = useState("");
  useEffect(() => { localStorage.setItem(IND_STORE, JSON.stringify(flags)); }, [flags]);

  const sym = symbol?.toUpperCase();
  const { data: candleData, isLoading, error } = useCandles(sym, tf);
  const { data: scores = [] } = useStockScores({ symbol: sym, limit: 1 });
  const score = scores[0];
  const { data: quotesData } = useQuotes(sym ? [`NSE:${sym}`] : []);
  const quote = quotesData?.quotes?.[0];
  const { data: sectors = [] } = useSectorStrength();
  const { data: depth } = useDepth(sym);
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

  const toggle = (k: keyof IndicatorFlags) => setFlags((p) => ({ ...p, [k]: !p[k] }));

  if (!sym) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <HudPanel flow title="Stock Analysis" index="MK.ANL">
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", maxWidth: 400 }}>
            <div style={{ flex: 1 }}>
              <div style={labelStyle}>Symbol</div>
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && search.trim()) nav(`/market/analysis/${search.trim().toUpperCase()}`); }}
                placeholder="RELIANCE" style={{ ...inputStyle, width: "100%" }} autoFocus />
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
    <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 12, height: "100%", minHeight: 0 }}>
      {/* Chart column — fills the viewport height */}
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
        <HudPanel
          title={`${sym} · ${tf}`}
          index="MK.ANL"
          live={isLoading ? "warn" : "ok"}
          style={{ flex: 1, minHeight: 0 }}
          actions={
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {TIMEFRAMES.map((t) => (
                <Btn key={t} size="sm" variant={tf === t ? "primary" : "ghost"} onClick={() => setTf(t)}>{t}</Btn>
              ))}
              {!tvMode && (
                <>
                  <span style={{ width: 1, background: "var(--edge)", margin: "0 2px" }} />
                  {CHART_TYPES.map((c) => (
                    <Btn key={c.key} size="sm" variant={chartType === c.key ? "primary" : "ghost"} onClick={() => setChartType(c.key)}>{c.label}</Btn>
                  ))}
                </>
              )}
              <span style={{ width: 1, background: "var(--edge)", margin: "0 2px" }} />
              <Btn size="sm" variant={tvMode ? "primary" : "ghost"} onClick={() => setTvMode((v) => !v)}>TradingView</Btn>
              {tvMode && (
                <a
                  href={`https://www.tradingview.com/chart/?symbol=NSE:${sym}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hud-btn focus-outline"
                  data-variant="ghost"
                  data-size="sm"
                  title="Open real-time NSE chart on tradingview.com (uses your TradingView login)"
                  style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  Real-time <ExternalLink size={11} />
                </a>
              )}
            </div>
          }
        >
          {!tvMode && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8, flex: "0 0 auto" }}>
              {INDICATOR_DEFS.map((d) => (
                <button key={d.key} onClick={() => toggle(d.key)}
                  style={{
                    padding: "3px 8px", fontFamily: "var(--font-hud)", fontSize: 9,
                    letterSpacing: "0.14em", cursor: "pointer", borderRadius: 2,
                    border: `1px solid ${flags[d.key] ? "var(--edge-strong)" : "var(--edge)"}`,
                    background: flags[d.key] ? "rgba(53,214,237,0.12)" : "transparent",
                    color: flags[d.key] ? "var(--accent)" : "var(--text-dim)",
                  }}>{d.label}</button>
              ))}
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0 }}>
            {tvMode ? (
              <TradingViewChart symbol={sym} interval={tvInterval(tf)} />
            ) : error ? (
              <EmptyState hint={String((error as Error).message ?? "")}>chart unavailable</EmptyState>
            ) : isLoading || !candleData ? (
              <div className="hud-label" style={{ padding: 24, textAlign: "center" }}>loading candles…</div>
            ) : candleData.candles.length === 0 ? (
              <EmptyState hint="unknown symbol, or data pipeline hasn't covered it yet">no candle data</EmptyState>
            ) : (
              <CandleChart
                candles={candleData.candles}
                priceLines={tf === "1D" ? priceLines : undefined}
                fill
                chartType={chartType}
                indicators={flags}
              />
            )}
          </div>
        </HudPanel>
      </div>

      {/* Right rail — scrolls independently */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0, overflowY: "auto", paddingRight: 2 }}>
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

        {depth && (depth.bids.length > 0 || depth.asks.length > 0) && (
          <HudPanel flow title="Market Depth" index="A1.5">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
              <div>
                <div className="hud-label" style={{ color: "var(--ok)", marginBottom: 4 }}>Bids</div>
                {depth.bids.map((b, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", borderBottom: "1px solid var(--edge)" }}>
                    <span style={{ color: "var(--ok)" }}>{b.price.toFixed(2)}</span>
                    <span style={{ color: "var(--text-dim)" }}>{b.qty.toLocaleString("en-IN")}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="hud-label" style={{ color: "var(--danger)", marginBottom: 4 }}>Asks</div>
                {depth.asks.map((a, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", borderBottom: "1px solid var(--edge)" }}>
                    <span style={{ color: "var(--danger)" }}>{a.price.toFixed(2)}</span>
                    <span style={{ color: "var(--text-dim)" }}>{a.qty.toLocaleString("en-IN")}</span>
                  </div>
                ))}
              </div>
            </div>
          </HudPanel>
        )}

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

        <HudPanel flow title="Fundamentals" index="A5">
          {!f ? (
            <div className="hud-label" style={{ fontSize: 11, padding: 6 }}>loading fundamentals…</div>
          ) : (
            <>
              <Row label="Market Cap" mono>{fmtCrore(f.market_cap)}</Row>
              <Row label="P/E (TTM)" mono>{fmtNum(f.pe_ttm, 2)}</Row>
              <Row label="P/E (Fwd)" mono>{fmtNum(f.pe_forward, 2)}</Row>
              <Row label="P/B" mono>{fmtNum(f.price_to_book, 2)}</Row>
              <Row label="EPS (TTM)" mono>{fmtNum(f.eps_ttm, 2)}</Row>
              <Row label="ROE" mono>{fmtPct((f.roe ?? 0) * 100)}</Row>
              <Row label="Debt/Equity" mono>{fmtNum(f.debt_to_equity, 2)}</Row>
              <Row label="Profit Margin" mono>{fmtPct((f.profit_margin ?? 0) * 100)}</Row>
              <Row label="Rev Growth" mono>
                <span style={{ color: (f.revenue_growth ?? 0) > 0 ? "var(--ok)" : "var(--danger)" }}>
                  {fmtPct((f.revenue_growth ?? 0) * 100)}
                </span>
              </Row>
              <Row label="Dividend Yield" mono>{fmtPct((f.dividend_yield ?? 0) * 100)}</Row>
              <Row label="Beta" mono>{fmtNum(f.beta, 2)}</Row>
              {f.industry && <Row label="Industry"><span style={{ fontSize: 10 }}>{f.industry}</span></Row>}
              {f.next_earnings_at && (
                <Row label="Next Earnings">
                  <span style={{ fontSize: 10 }}>{new Date(f.next_earnings_at).toLocaleDateString()}</span>
                </Row>
              )}
            </>
          )}
        </HudPanel>
      </div>
    </div>
  );
}

function fmtCrore(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const cr = n / 1e7;
  if (cr >= 1e5) return `₹${(cr / 1e5).toFixed(2)} L Cr`;
  if (cr >= 1000) return `₹${(cr / 1000).toFixed(2)} K Cr`;
  return `₹${cr.toFixed(2)} Cr`;
}

function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid var(--edge)", fontSize: 12 }}>
      <span className="hud-label" style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={mono ? { fontVariantNumeric: "tabular-nums", color: "var(--text)" } : undefined}>{children}</span>
    </div>
  );
}
