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
import { ChartToolbar } from "@/components/market/ChartToolbar";
import { fmtNum, fmtInt, fmtPct } from "@/components/hud/DataTable";
import { useCandles, useDepth, useFundamentals, useQuotes, useRefreshStockInsight, useSectorStrength, useStockInsight, useStockScores } from "@/lib/market/hooks";
import { getTrustedDayChange } from "@/lib/market/pnl";
import { FullscreenShell } from "@/components/market/FullscreenShell";
import { RefreshCw } from "lucide-react";

const IND_STORE = "jarvis.analysis.indicators";
const defaultFlags: IndicatorFlags = { ema20: true, ema50: true, volume: true };

export default function Analysis() {
  const { symbol } = useParams();
  const nav = useNavigate();
  const [tf, setTf] = useState("1D");
  const [chartType, setChartType] = useState<ChartType>("candles");
  const [tvMode, setTvMode] = useState(false);
  const [fs, setFs] = useState(false);
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
  const fund = fundData?.fundamentals as any | undefined;
  const { data: insightData, isLoading: insightLoading, error: insightError } = useStockInsight(sym);
  const refreshInsight = useRefreshStockInsight();
  const insight = insightData?.payload;
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

  // `|| score.close`: a quote ltp of 0 means "no live quote" (Yahoo/Kotak
  // unavailable) — fall back to the EOD close from the score row so the panel
  // never shows ₹0. Change % falls back to the EOD change from the score.
  const ltp = quote?.ltp || score?.close || null;
  const chgPct = quote?.change_pct ?? score?.change_pct ?? null;
  const dayChange = getTrustedDayChange(quote);

  return (
    <div className="mk-anl-grid">
      {/* Chart column — fills the viewport height */}
      <div className="mk-anl-chart" style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
        <HudPanel
          title={sym}
          index="MK.ANL"
          live={isLoading ? "warn" : "ok"}
          style={{ flex: 1, minHeight: 0 }}
        >
          <FullscreenShell fullscreen={fs} onExit={() => setFs(false)} title={`${sym} · ${tf}`}>
            <ChartToolbar
              symbol={sym}
              tf={tf}
              onTf={setTf}
              chartType={chartType}
              onChartType={setChartType}
              flags={flags}
              onFlags={(u) => setFlags(u)}
              tvMode={tvMode}
              onTvMode={setTvMode}
              onFullscreen={() => setFs(true)}
              onAlert={() => nav(`/market/alerts?symbol=${sym}`)}
            />
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
          </FullscreenShell>
        </HudPanel>
      </div>

      {/* Right rail — scrolls independently */}
      <div className="mk-anl-rail">
        <HudPanel flow title="Quote" index="A1">
          <div style={{ fontFamily: "var(--font-display)", fontSize: 26, color: "var(--accent)" }}>
            {ltp != null ? `₹${fmtNum(ltp)}` : "—"}
          </div>
          <div style={{ fontSize: 13, color: (chgPct ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}>
            {chgPct != null ? fmtPct(chgPct) : "—"}
            {dayChange != null && <span style={{ marginLeft: 8 }}>({fmtNum(dayChange)})</span>}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
            {score?.sector && <Chip tone="accent">{score.sector}</Chip>}
            {!quote?.ltp && score?.close != null && (
              <span style={{ fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.1em" }}>EOD</span>
            )}
            {quote?.stale && <Chip tone="warn">stale</Chip>}
          </div>
        </HudPanel>

        {depth && (depth.bids.length > 0 || depth.asks.length > 0) && (
          <HudPanel flow title="Market Depth" index="A2">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
              <div>
                <div className="hud-label" style={{ color: "var(--ok)", marginBottom: 4 }}>Bids</div>
                {depth.bids.map((b, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 6, padding: "2px 0", borderBottom: "1px solid var(--edge)" }}>
                    <span style={{ color: "var(--ok)" }}>{b.price.toFixed(2)}</span>
                    <span style={{ color: "var(--text-dim)", textAlign: "right" }}>{b.qty.toLocaleString("en-IN")}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="hud-label" style={{ color: "var(--danger)", marginBottom: 4 }}>Asks</div>
                {depth.asks.map((a, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 6, padding: "2px 0", borderBottom: "1px solid var(--edge)" }}>
                    <span style={{ color: "var(--danger)" }}>{a.price.toFixed(2)}</span>
                    <span style={{ color: "var(--text-dim)", textAlign: "right" }}>{a.qty.toLocaleString("en-IN")}</span>
                  </div>
                ))}
              </div>
            </div>
          </HudPanel>
        )}

        {!score ? (
          <HudPanel flow title="Coverage" index="A3">
            <div className="hud-label" style={{ fontSize: 11, lineHeight: 1.6, color: "var(--text-dim)" }}>
              No screener data for <b style={{ color: "var(--accent)" }}>{sym}</b>. It isn't in the
              tracked universe yet — run the pipeline from <span style={{ color: "var(--accent)" }}>Settings → Sync universe</span>,
              or pick a covered symbol. The chart above still works.
            </div>
          </HudPanel>
        ) : (
        <>
        <HudPanel flow title="Breakout Intelligence" index="A3">
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

        <HudPanel flow title="Indicators (Daily)" index="A4">
          <Row label="RSI (14)" mono>{fmtNum(score?.rsi14, 1)}</Row>
          <Row label="MACD" mono>{fmtNum(score?.macd, 2)} / {fmtNum(score?.macd_signal, 2)}</Row>
          <Row label="ADX (14)" mono>{fmtNum(score?.adx14, 1)}</Row>
          <Row label="ATR %" mono>{fmtNum(score?.atr_pct, 2)}</Row>
          <Row label="BB Width" mono>{fmtNum(score?.bb_width, 3)}</Row>
          <Row label="Rel Volume" mono>{fmtNum(score?.rel_volume, 2)}</Row>
          <Row label="Volume" mono>{fmtInt(score?.volume)}</Row>
        </HudPanel>

        <HudPanel flow title="Range & Strength" index="A5">
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
        </>
        )}

        {/* AI Verdict — cached 6h per symbol */}
        <HudPanel flow title="AI Verdict" index="A6"
          actions={
            <Btn size="sm" variant="ghost" disabled={!sym || refreshInsight.isPending}
              onClick={() => sym && refreshInsight.mutate({ symbol: sym })}
              aria-label="refresh AI verdict">
              <RefreshCw size={11} />
            </Btn>
          }>
          {insightLoading || refreshInsight.isPending ? (
            <div className="hud-label" style={{ fontSize: 11, color: "var(--text-muted)" }}>analyzing…</div>
          ) : insightError ? (
            <div className="hud-label" style={{ fontSize: 11, color: "var(--danger)" }}>
              {(insightError as Error).message.includes("no coverage")
                ? "no coverage — run pipeline"
                : "AI unavailable — try refresh"}
            </div>
          ) : insight ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <Chip tone={insight.verdict === "buy" ? "ok" : insight.verdict === "avoid" ? "err" : insight.verdict === "wait" ? "warn" : "accent"}>
                  {insight.verdict.toUpperCase()}
                </Chip>
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  conf {Math.round(insight.confidence * 100)}%
                </span>
              </div>
              {(insight.entry || insight.stop_loss || insight.targets.length > 0) && (
                <div style={{ display: "flex", flexDirection: "column", fontSize: 11, marginBottom: 6 }}>
                  {insight.entry != null && <Row label="Entry" mono>₹{fmtNum(insight.entry, 2)}</Row>}
                  {insight.stop_loss != null && <Row label="Stop" mono>₹{fmtNum(insight.stop_loss, 2)}</Row>}
                  {insight.targets.map((t, i) => (
                    <Row key={i} label={`T${i + 1}`} mono>₹{fmtNum(t, 2)}</Row>
                  ))}
                  {insight.holding_period_days != null && (
                    <Row label="Hold" mono>{insight.holding_period_days}d</Row>
                  )}
                </div>
              )}
              <div style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text)", marginBottom: 4 }}>
                {insight.rationale}
              </div>
              {insight.risks.length > 0 && (
                <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
                  <div className="hud-label" style={{ marginBottom: 2 }}>Risks</div>
                  <ul style={{ margin: 0, paddingLeft: 14 }}>
                    {insight.risks.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <div className="hud-label" style={{ fontSize: 11, color: "var(--text-muted)" }}>press refresh</div>
          )}
        </HudPanel>

        {/* Fundamentals */}
        {fund && (
          <HudPanel flow title="Fundamentals" index="A7">
            <Row label="Market Cap" mono>{fund.marketCap ? `₹${fmtNum(fund.marketCap / 1e7, 0)} Cr` : "—"}</Row>
            <Row label="P/E (TTM)" mono>{fmtNum(fund.trailingPE ?? fund.peRatio, 2)}</Row>
            <Row label="P/B" mono>{fmtNum(fund.priceToBook, 2)}</Row>
            <Row label="EPS (TTM)" mono>{fmtNum(fund.trailingEps ?? fund.eps, 2)}</Row>
            <Row label="ROE" mono>{fund.returnOnEquity != null ? fmtPct(fund.returnOnEquity * 100) : "—"}</Row>
            <Row label="Debt/Equity" mono>{fmtNum(fund.debtToEquity, 2)}</Row>
            <Row label="Div Yield" mono>{fund.dividendYield != null ? fmtPct(fund.dividendYield * 100) : "—"}</Row>
            <Row label="Beta" mono>{fmtNum(fund.beta, 2)}</Row>
            {fund.sector && <Row label="Sector">{fund.sector}</Row>}
            {fund.industry && <Row label="Industry">{fund.industry}</Row>}
          </HudPanel>
        )}
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
