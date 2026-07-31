// Per-symbol score deep-dive: how the v4 score has moved, and what the price
// actually did afterwards. Two tabs, both evidence-only — an unmatured
// snapshot says "maturing", never 0.
import { useMemo } from "react";
import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { fmtPct } from "@/components/hud/DataTable";
import { useScoreHistory, type ScoreHistoryRow } from "@/lib/market/scoreHistory";
import { SCORE_BAND_STRONG, SCORE_BAND_MODERATE, SCORE_BAND_WEAK } from "@/lib/market/scoreBands";

const MATURITY_SESSIONS = 21;

const retColor = (v: number | null) =>
  v == null ? "var(--text-muted)" : v > 0 ? "var(--ok)" : v < 0 ? "var(--danger)" : "var(--text-dim)";

function Curve({ rows }: { rows: ScoreHistoryRow[] }) {
  const pts = rows.filter((r) => r.score != null);
  if (pts.length < 2) return <div style={{ fontSize: 11, color: "var(--text-muted)" }}>need 2+ sessions to draw</div>;
  const W = 900, H = 200, pad = 8;
  const xs = (i: number) => pad + (i * (W - pad * 2)) / (pts.length - 1);
  const scoreY = (v: number) => H - pad - (v / 100) * (H - pad * 2);
  const closes = pts.map((p) => p.close).filter((c): c is number => c != null);
  const cMin = closes.length ? Math.min(...closes) : 0;
  const cMax = closes.length ? Math.max(...closes) : 1;
  const closeY = (v: number) => (cMax === cMin ? H / 2 : H - pad - ((v - cMin) / (cMax - cMin)) * (H - pad * 2));
  const scorePath = pts.map((p, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${scoreY(p.score!).toFixed(1)}`).join(" ");
  const closePath = pts
    .map((p, i) => (p.close == null ? null : `${i ? "L" : "M"}${xs(i).toFixed(1)},${closeY(p.close).toFixed(1)}`))
    .filter(Boolean).join(" ").replace(/^L/, "M");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block" }}>
      {[SCORE_BAND_STRONG, SCORE_BAND_MODERATE, SCORE_BAND_WEAK].map((lvl) => (
        <g key={lvl}>
          <line x1={0} x2={W} y1={scoreY(lvl)} y2={scoreY(lvl)} stroke="var(--edge)" strokeWidth={0.5} strokeDasharray="2 3" />
          <text x={2} y={scoreY(lvl) - 2} fill="var(--text-muted)" fontSize={8}>{lvl}</text>
        </g>
      ))}
      {closePath && <path d={closePath} fill="none" stroke="var(--text-muted)" strokeWidth={1} opacity={0.6} />}
      <path d={scorePath} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
    </svg>
  );
}

export default function ScoreDetail() {
  const { symbol = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const tab = sp.get("tab") === "returns" ? "returns" : "history";
  const exchange = sp.get("exchange") ?? "NSE";
  const { data: history = [], isLoading } = useScoreHistory(symbol, exchange, 250);

  const stats = useMemo(() => {
    const scores = history.map((r) => r.score).filter((v): v is number => v != null);
    const matured = history.filter((r) => r.fwd_ret_21d != null);
    const hits = matured.filter((r) => (r.fwd_ret_21d ?? 0) > 0).length;
    return {
      sessions: history.length,
      avg: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      max: scores.length ? Math.max(...scores) : null,
      strongDays: scores.filter((s) => s >= SCORE_BAND_STRONG).length,
      matured: matured.length,
      hit: matured.length ? Math.round((100 * hits) / matured.length) : null,
      avgRel: matured.length
        ? Math.round((matured.reduce((a, r) => a + (r.fwd_rel_21d ?? 0), 0) / matured.length) * 100) / 100
        : null,
    };
  }, [history]);

  const rowsDesc = [...history].reverse();

  return (
    <div style={{ display: "grid", gap: 10, padding: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="hud-label" style={{ fontSize: 14, color: "var(--text)" }}>{symbol}</span>
        <Chip>{exchange}</Chip>
        <Chip>{stats.sessions} sessions</Chip>
        {stats.avg != null && <Chip>avg {stats.avg}</Chip>}
        {stats.max != null && <Chip tone={stats.max >= SCORE_BAND_STRONG ? "ok" : "neutral"}>max {stats.max}</Chip>}
        <Chip tone={stats.strongDays > 0 ? "ok" : "warn"}>{stats.strongDays} strong days</Chip>
        <div style={{ flex: 1 }} />
        <Btn size="sm" onClick={() => nav(`/market/analysis/${encodeURIComponent(symbol)}`)}>Chart</Btn>
        <Btn size="sm" onClick={() => nav("/market/calibration")}>Calibration lab</Btn>
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        {(["history", "returns"] as const).map((t) => (
          <Btn key={t} size="sm" variant={tab === t ? "primary" : undefined}
               onClick={() => setSp(t === "history" ? {} : { tab: "returns" })}>
            {t === "history" ? "Score history" : "Forward returns"}
          </Btn>
        ))}
      </div>

      {isLoading ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>loading…</div>
      ) : history.length === 0 ? (
        <HudPanel title="No snapshots">
          <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>
            Nothing recorded for {symbol} yet. The nightly aggregates pass writes one v4 snapshot per
            session; forward returns fill in after {MATURITY_SESSIONS} sessions.
          </div>
        </HudPanel>
      ) : tab === "history" ? (
        <>
          <HudPanel title="Score vs price">
            <Curve rows={history} />
            <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>
              accent = v4 score (left scale 0–100), grey = close (auto-scaled). Dashed lines are the
              70 / 55 / 40 band cuts.
            </div>
          </HudPanel>

          <HudPanel title="Sessions">
            <div style={{ fontSize: 10, fontFamily: "var(--font-hud)", maxHeight: 460, overflow: "auto" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr 0.8fr 0.8fr 1fr 2.4fr", gap: 6, color: "var(--text-muted)", position: "sticky", top: 0, background: "var(--bg-deep, #071019)", padding: "2px 0" }}>
                <span>date</span><span>score</span><span>band</span><span>rank</span><span>close</span><span>top buckets</span>
              </div>
              {rowsDesc.map((r) => {
                const top = Object.entries(r.buckets ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
                return (
                  <div key={r.trade_date} style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr 0.8fr 0.8fr 1fr 2.4fr", gap: 6, padding: "1px 0" }}>
                    <span style={{ color: "var(--text-dim)" }}>{r.trade_date}</span>
                    <span style={{ color: "var(--text)" }}>{r.score ?? "—"}</span>
                    <span style={{ color: "var(--text-muted)" }}>{r.band ?? "—"}</span>
                    <span style={{ color: "var(--text-muted)" }}>{r.rank_pct == null ? "—" : `${r.rank_pct}%`}</span>
                    <span style={{ color: "var(--text-muted)" }}>{r.close ?? "—"}</span>
                    <span style={{ color: "var(--text-muted)" }}>
                      {top.length ? top.map(([k, v]) => `${k} ${v}`).join(" · ") : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          </HudPanel>
        </>
      ) : (
        <>
          <HudPanel title="What happened next">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              <Chip>{stats.matured} matured (21d)</Chip>
              {stats.hit != null && <Chip tone={stats.hit >= 50 ? "ok" : "warn"}>hit rate {stats.hit}%</Chip>}
              {stats.avgRel != null && (
                <Chip tone={stats.avgRel > 0 ? "ok" : "warn"}>avg vs NIFTY {fmtPct(stats.avgRel, 2, false)}</Chip>
              )}
            </div>
            <div style={{ fontSize: 10, fontFamily: "var(--font-hud)", maxHeight: 520, overflow: "auto" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr repeat(6, 1fr)", gap: 6, color: "var(--text-muted)", position: "sticky", top: 0, background: "var(--bg-deep, #071019)", padding: "2px 0" }}>
                <span>date</span><span>score</span>
                <span style={{ textAlign: "right" }}>+5d</span>
                <span style={{ textAlign: "right" }}>+10d</span>
                <span style={{ textAlign: "right" }}>+21d</span>
                <span style={{ textAlign: "right" }}>rel 5d</span>
                <span style={{ textAlign: "right" }}>rel 10d</span>
                <span style={{ textAlign: "right" }}>rel 21d</span>
              </div>
              {rowsDesc.map((r) => (
                <div key={r.trade_date} style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr repeat(6, 1fr)", gap: 6, padding: "1px 0" }}>
                  <span style={{ color: "var(--text-dim)" }}>{r.trade_date}</span>
                  <span style={{ color: "var(--text)" }}>{r.score ?? "—"}</span>
                  {[r.fwd_ret_5d, r.fwd_ret_10d, r.fwd_ret_21d, r.fwd_rel_5d, r.fwd_rel_10d, r.fwd_rel_21d].map((v, i) => (
                    <span key={i} style={{ textAlign: "right", color: retColor(v), fontVariantNumeric: "tabular-nums" }}>
                      {v == null ? "maturing" : fmtPct(v, 2, false)}
                    </span>
                  ))}
                </div>
              ))}
            </div>
            <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>
              Returns are split-adjusted from the snapshot close. “rel” subtracts NIFTY over the same
              dates — a bull month flatters every band, this is the honest read.
            </div>
          </HudPanel>
        </>
      )}
    </div>
  );
}
