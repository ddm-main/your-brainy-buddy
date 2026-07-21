// AI Analysis Engine — full AI breakdown for any NSE symbol.
// Real data only: market-stock-insight (verdict + trade plan + rationale/risks)
// joined with the symbol's score row (breakout/momentum/trend/volume metrics).
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, labelStyle } from "@/components/hud/HudControls";
import { fmtNum, fmtInt } from "@/components/hud/DataTable";
import { useRefreshStockInsight, useStockInsight, useStockScores } from "@/lib/market/hooks";
import { SymbolSearchInput } from "@/components/market/SymbolSearchInput";
import { RefreshCw, Sparkles } from "lucide-react";

const VERDICT_TONE: Record<string, "ok" | "err" | "warn" | "accent"> = {
  buy: "ok", avoid: "err", wait: "warn", hold: "accent",
};

export default function AIEngine() {
  const { symbol } = useParams();
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const sym = symbol?.toUpperCase();

  const { data: insightData, isLoading, error } = useStockInsight(sym);
  const refresh = useRefreshStockInsight();
  const insight = insightData?.payload;
  const { data: scores = [] } = useStockScores({ symbol: sym, limit: 1 });
  const score = scores[0];

  if (!sym) {
    return (
      <HudPanel flow title="AI Analysis Engine" index="MK.AI">
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", maxWidth: 420 }}>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>Symbol</div>
            <SymbolSearchInput value={search} onChange={setSearch}
              onSelect={(o) => nav(`/market/ai/${o.symbol}`)}
              onEnter={() => search.trim() && nav(`/market/ai/${search.trim().toUpperCase()}`)}
              placeholder="RELIANCE" autoFocus />
          </div>
          <Btn variant="primary" onClick={() => search.trim() && nav(`/market/ai/${search.trim().toUpperCase()}`)}>
            <Sparkles size={11} style={{ marginRight: 4 }} /> Analyze
          </Btn>
        </div>
        <div style={{ marginTop: 12 }}>
          <EmptyState hint="AI reads the stock's technicals, breakout scores and market context, then gives a trade recommendation">
            enter a symbol for a full AI breakdown
          </EmptyState>
        </div>
      </HudPanel>
    );
  }

  const busy = isLoading || refresh.isPending;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 12, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <HudPanel flow title={`AI Analysis · ${sym}`} index="MK.AI" live={busy ? "warn" : "ok"} actions={
          <div style={{ display: "flex", gap: 6 }}>
            <Btn size="sm" onClick={() => nav(`/market/analysis/${sym}`)}>chart</Btn>
            <Btn size="sm" onClick={() => refresh.mutate({ symbol: sym })} disabled={busy}>
              <RefreshCw size={11} style={{ marginRight: 4 }} /> {refresh.isPending ? "re-analyzing…" : "re-analyze"}
            </Btn>
          </div>
        }>
          {busy ? (
            <div className="hud-label" style={{ padding: 24, textAlign: "center" }}>analyzing {sym}…</div>
          ) : error ? (
            <EmptyState hint={(error as Error).message.includes("no coverage")
              ? "not in the tracked universe — run the pipeline from Settings"
              : "try re-analyze"}>AI unavailable</EmptyState>
          ) : insight ? (
            <>
              {/* verdict + confidence */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                <Chip tone={VERDICT_TONE[insight.verdict] ?? "accent"}>{insight.verdict.toUpperCase()}</Chip>
                <div style={{ flex: 1 }}>
                  <div className="hud-label" style={{ color: "var(--text-dim)", marginBottom: 2 }}>Confidence</div>
                  <div style={{ height: 6, background: "var(--edge)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${Math.round(insight.confidence * 100)}%`, height: "100%", background: "var(--accent)" }} />
                  </div>
                </div>
                <span style={{ fontFamily: "var(--font-display)", fontSize: 18 }}>{Math.round(insight.confidence * 100)}%</span>
              </div>

              {/* trade plan */}
              {(insight.entry != null || insight.stop_loss != null || insight.targets.length > 0) && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8, marginBottom: 12 }}>
                  {insight.entry != null && <Metric label="Entry" value={`₹${fmtNum(insight.entry, 2)}`} />}
                  {insight.stop_loss != null && <Metric label="Stop Loss" value={`₹${fmtNum(insight.stop_loss, 2)}`} tone="err" />}
                  {insight.targets.map((t, i) => (
                    <Metric key={i} label={`Target ${i + 1}`} value={`₹${fmtNum(t, 2)}`} tone="ok" />
                  ))}
                  {rr(insight) != null && <Metric label="Risk / Reward" value={`1 : ${rr(insight)!.toFixed(2)}`} />}
                  {insight.holding_period_days != null && <Metric label="Holding" value={`${insight.holding_period_days}d`} />}
                </div>
              )}

              {/* rationale */}
              <div className="hud-label" style={{ color: "var(--accent-soft)", marginBottom: 4 }}>AI Explanation</div>
              <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", marginBottom: 12 }}>{insight.rationale}</div>

              {/* risks */}
              {insight.risks.length > 0 && (
                <>
                  <div className="hud-label" style={{ color: "var(--danger)", marginBottom: 4 }}>Risks</div>
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: "var(--text-dim)", lineHeight: 1.6 }}>
                    {insight.risks.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </>
              )}
            </>
          ) : (
            <EmptyState>no analysis yet</EmptyState>
          )}
        </HudPanel>
      </div>

      {/* score breakdown from the pipeline's computed metrics */}
      <HudPanel flow title="Score Breakdown" index="AI.2">
        {!score ? (
          <div className="hud-label" style={{ fontSize: 11, color: "var(--text-dim)" }}>
            No score row for {sym} — not in the tracked universe.
          </div>
        ) : (
          <>
            <Row label="Breakout" mono>{fmtNum(score.breakout_score, 0)} / 100</Row>
            <Row label="Pre-Breakout" mono>{fmtNum(score.prebreakout_score, 0)} / 100</Row>
            <Row label="RSI (14)" mono>{fmtNum(score.rsi14, 1)}</Row>
            <Row label="ADX (trend)" mono>{fmtNum(score.adx14, 1)}</Row>
            <Row label="Rel Volume" mono>{fmtNum(score.rel_volume, 2)}</Row>
            <Row label="RS vs NIFTY" mono>{fmtNum(score.rel_strength_nifty, 1)}</Row>
            <Row label="ATR %" mono>{fmtNum(score.atr_pct, 2)}</Row>
            <Row label="From 52w High" mono>{score.pct_from_52w_high == null ? "—" : `${score.pct_from_52w_high.toFixed(2)}%`}</Row>
            <Row label="Volume" mono>{fmtInt(score.volume)}</Row>
            {score.sector && <Row label="Sector"><Chip tone="accent">{score.sector}</Chip></Row>}
          </>
        )}
      </HudPanel>
    </div>
  );
}

function rr(i: { entry: number | null; stop_loss: number | null; targets: number[] }): number | null {
  if (i.entry == null || i.stop_loss == null || i.targets.length === 0) return null;
  const risk = Math.abs(i.entry - i.stop_loss);
  if (risk === 0) return null;
  const reward = Math.abs(i.targets[i.targets.length - 1] - i.entry);
  return reward / risk;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "ok" | "err" }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--danger)" : "var(--text)";
  return (
    <div style={{ padding: "8px 10px", border: "1px solid var(--edge)" }}>
      <div className="hud-label" style={{ color: "var(--text-dim)" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 16, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: "1px solid var(--edge)", fontSize: 12 }}>
      <span className="hud-label" style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={mono ? { fontVariantNumeric: "tabular-nums", color: "var(--text)" } : undefined}>{children}</span>
    </div>
  );
}
