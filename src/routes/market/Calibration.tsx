// Model Calibration Lab — the heart of the scoring system.
//
// Three questions, answered from stored evidence only:
//  1. Cohort explorer — who crossed the threshold each session, how sticky was
//     the signal (how many sessions did a name stay above it), and what did
//     those names actually return?
//  2. Band evidence — does STRONG beat WEAK, on the population the model is
//     actually fitted on (liquid + full-context) rather than everything?
//  3. Weight search — replay the stored bucket detail under thousands of
//     alternative weight vectors and rank them by the top-vs-bottom decile
//     spread in benchmark-relative forward return. Read-only: promoting a
//     candidate into the live scorer stays a deliberate, separate step.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { fmtPct } from "@/components/hud/DataTable";
import {
  useScoreCohort, useScoreCohortSymbols, useOptimizerRuns, useRunOptimizer,
  V4_WEIGHTS, type OptimizerCandidate, type OptimizerMetrics,
} from "@/lib/market/scoreLab";
import { useScoreBandStats, useScoreCalibration, sortBands, MIN_BAND_SAMPLE, BUCKET_PREFIX } from "@/lib/market/scoreHistory";

const BUCKETS = Object.keys(V4_WEIGHTS);
const retColor = (v: number | null | undefined) =>
  v == null ? "var(--text-muted)" : v > 0 ? "var(--ok)" : v < 0 ? "var(--danger)" : "var(--text-dim)";

function MetricRow({ label, m, base }: { label: string; m: OptimizerMetrics; base?: OptimizerMetrics }) {
  const delta = base ? m.spread - base.spread : null;
  return (
    <>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={{ textAlign: "right", color: retColor(m.spread) }}>{m.spread.toFixed(2)}</span>
      <span style={{ textAlign: "right", color: delta == null ? "var(--text-muted)" : retColor(delta) }}>
        {delta == null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(2)}`}
      </span>
      <span style={{ textAlign: "right", color: retColor(m.corr) }}>{m.corr.toFixed(2)}</span>
      <span style={{ textAlign: "right", color: retColor(m.cohort_rel) }}>{m.cohort_rel.toFixed(2)}</span>
      <span style={{ textAlign: "right", color: "var(--text-muted)" }}>{m.cohort_n}</span>
      <span style={{ textAlign: "right", color: "var(--text-muted)" }}>{m.cohort_hit}%</span>
    </>
  );
}

function WeightBars({ weights, base }: { weights: Record<string, number>; base?: Record<string, number> }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))", gap: 6, marginTop: 6 }}>
      {BUCKETS.map((b) => {
        const w = weights[b] ?? 0;
        const bw = base?.[b];
        const diff = bw == null ? null : w - bw;
        return (
          <div key={b} style={{ fontSize: 9, fontFamily: "var(--font-hud)" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-muted)" }}>{b}</span>
              <span style={{ color: "var(--text)" }}>{w.toFixed(1)}</span>
            </div>
            <div style={{ height: 3, background: "var(--edge)", marginTop: 2 }}>
              <div style={{ width: `${Math.min(100, w * 3)}%`, height: "100%", background: "var(--accent)" }} />
            </div>
            {diff != null && Math.abs(diff) >= 0.5 && (
              <span style={{ color: diff > 0 ? "var(--ok)" : "var(--danger)" }}>
                {diff > 0 ? "+" : ""}{diff.toFixed(1)} vs live
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Calibration() {
  const nav = useNavigate();
  const [days, setDays] = useState(30);
  const [threshold, setThreshold] = useState(70);
  const [population, setPopulation] = useState<"fit" | "all">("fit");
  const [horizon, setHorizon] = useState<"5d" | "10d" | "21d">("21d");
  const [searchDays, setSearchDays] = useState(120);
  const [result, setResult] = useState<{
    baseline?: { weights: Record<string, number>; metrics: OptimizerMetrics } | null;
    candidates?: OptimizerCandidate[];
    sample_n?: number;
    sessions?: number;
    message?: string;
    ok?: boolean;
  } | null>(null);

  const { data: cohort = [], isLoading: cohortLoading } = useScoreCohort(days, threshold);
  const { data: members = [] } = useScoreCohortSymbols(days, threshold, 200);
  const { data: bands = [] } = useScoreBandStats(population);
  const { data: calibration = [] } = useScoreCalibration();
  const { data: runs = [] } = useOptimizerRuns(5);
  const optimize = useRunOptimizer();

  const totalQualified = cohort.reduce((s, d) => s + d.n_qualified, 0);
  const daysWithNone = cohort.filter((d) => d.n_qualified === 0).length;
  const fitLine = calibration.find((c) => c.component === "score_vs_fwd_rel_21d")
    ?? calibration.find((c) => c.component === "score_vs_fwd_ret_21d") ?? null;
  const bucketFits = calibration.filter((c) => c.component.startsWith(BUCKET_PREFIX));
  // The fit records which population it could actually use — a replayed
  // (neutral-context) fit is weaker evidence and must say so.
  const popRow = calibration.find((c) => c.component.startsWith("population:")) ?? null;

  const run = () => {
    optimize.mutate({ days: searchDays, threshold, horizon, iterations: 400 }, {
      onSuccess: (d) => setResult(d as never),
    });
  };

  return (
    <div style={{ display: "grid", gap: 10, padding: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="hud-label" style={{ fontSize: 14, color: "var(--text)" }}>Model Calibration Lab</span>
        {fitLine ? (
          <>
            <Chip tone={(fitLine.weight ?? 0) > 0 ? "ok" : "err"}>
              slope {fitLine.weight.toFixed(4)}
            </Chip>
            {fitLine.r2 != null && <Chip tone={fitLine.r2 >= 0.02 ? "ok" : "warn"}>r² {fitLine.r2.toFixed(3)}</Chip>}
            <Chip>n {fitLine.sample_n ?? "—"}</Chip>
          </>
        ) : <Chip tone="warn">not fitted yet</Chip>}
        {popRow && (
          <Chip tone={popRow.component.endsWith("full_context") ? "ok" : "warn"}>
            fitted on {popRow.component.slice("population:".length).replace(/_/g, " ")} · {popRow.sample_n} rows
          </Chip>
        )}
        {fitLine && (fitLine.weight ?? 0) < 0 && (
          <Chip tone="err">score is currently anti-predictive — higher score, worse forward return</Chip>
        )}
      </div>

      {/* ---- Controls ---- */}
      <HudPanel title="Cohort window">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", fontSize: 10 }}>
          <label style={{ color: "var(--text-muted)" }}>
            lookback&nbsp;
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="hud-select">
              {[10, 20, 30, 60, 90, 180].map((d) => <option key={d} value={d}>{d} sessions</option>)}
            </select>
          </label>
          <label style={{ color: "var(--text-muted)" }}>
            threshold&nbsp;
            <select value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="hud-select">
              {[80, 70, 60, 55, 50, 40].map((d) => <option key={d} value={d}>score ≥ {d}</option>)}
            </select>
          </label>
          <Chip>{totalQualified} qualifiers</Chip>
          <Chip tone={daysWithNone > cohort.length / 2 ? "warn" : "neutral"}>
            {daysWithNone}/{cohort.length} sessions with none
          </Chip>
        </div>
      </HudPanel>

      {/* ---- 1. Per-session cohort ---- */}
      <HudPanel title={`Sessions above ${threshold}`}>
        {cohortLoading ? (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>loading…</div>
        ) : cohort.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>no score history in this window yet</div>
        ) : (
          <div style={{ fontSize: 10, fontFamily: "var(--font-hud)", maxHeight: 320, overflow: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.7fr 0.7fr repeat(5, 1fr)", gap: 6, color: "var(--text-muted)", position: "sticky", top: 0, background: "var(--bg-deep, #071019)", padding: "2px 0" }}>
              <span>date</span><span style={{ textAlign: "right" }}>n</span><span style={{ textAlign: "right" }}>avg score</span>
              <span style={{ textAlign: "right" }}>+5d</span><span style={{ textAlign: "right" }}>+10d</span>
              <span style={{ textAlign: "right" }}>+21d</span><span style={{ textAlign: "right" }}>rel 21d</span>
              <span style={{ textAlign: "right" }}>hit 21d</span>
            </div>
            {cohort.map((d) => (
              <div key={d.trade_date} style={{ display: "grid", gridTemplateColumns: "1.2fr 0.7fr 0.7fr repeat(5, 1fr)", gap: 6, padding: "1px 0" }}>
                <span style={{ color: "var(--text-dim)" }}>{d.trade_date}</span>
                <span style={{ textAlign: "right", color: d.n_qualified ? "var(--text)" : "var(--text-muted)" }}>{d.n_qualified}</span>
                <span style={{ textAlign: "right", color: "var(--text-muted)" }}>{d.avg_score ?? "—"}</span>
                {[d.avg_ret_5d, d.avg_ret_10d, d.avg_ret_21d, d.avg_rel_21d].map((v, i) => (
                  <span key={i} style={{ textAlign: "right", color: retColor(v), fontVariantNumeric: "tabular-nums" }}>
                    {v == null ? (d.n_qualified ? "maturing" : "—") : fmtPct(v, 2, false)}
                  </span>
                ))}
                <span style={{ textAlign: "right", color: "var(--text-muted)" }}>
                  {d.hit_rate_21d == null ? "—" : `${d.hit_rate_21d}%`}
                </span>
              </div>
            ))}
          </div>
        )}
      </HudPanel>

      {/* ---- 2. Persistence per symbol ---- */}
      <HudPanel title="Who qualified, and did it stick">
        {members.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            nothing crossed {threshold} in the last {days} sessions
          </div>
        ) : (
          <div style={{ fontSize: 10, fontFamily: "var(--font-hud)", maxHeight: 360, overflow: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.4fr 0.8fr 0.8fr 0.8fr 1.1fr 1.1fr repeat(3, 1fr)", gap: 6, color: "var(--text-muted)", position: "sticky", top: 0, background: "var(--bg-deep, #071019)", padding: "2px 0" }}>
              <span>symbol</span><span style={{ textAlign: "right" }}>days in</span>
              <span style={{ textAlign: "right" }}>max</span><span style={{ textAlign: "right" }}>avg</span>
              <span>first</span><span>last</span>
              <span style={{ textAlign: "right" }}>+5d*</span><span style={{ textAlign: "right" }}>+21d*</span>
              <span style={{ textAlign: "right" }}>rel 21d*</span>
            </div>
            {members.map((m) => (
              <div key={`${m.symbol}|${m.exchange}`}
                   onClick={() => nav(`/market/score/${encodeURIComponent(m.symbol)}`)}
                   style={{ display: "grid", gridTemplateColumns: "1.4fr 0.8fr 0.8fr 0.8fr 1.1fr 1.1fr repeat(3, 1fr)", gap: 6, padding: "1px 0", cursor: "pointer" }}>
                <span style={{ color: "var(--accent)" }}>{m.symbol}</span>
                <span style={{ textAlign: "right", color: "var(--text)" }}>{m.appearances}</span>
                <span style={{ textAlign: "right", color: "var(--text-muted)" }}>{m.max_score}</span>
                <span style={{ textAlign: "right", color: "var(--text-muted)" }}>{m.avg_score ?? "—"}</span>
                <span style={{ color: "var(--text-muted)" }}>{m.first_date}</span>
                <span style={{ color: "var(--text-muted)" }}>{m.last_date}</span>
                {[m.first_ret_5d, m.first_ret_21d, m.first_rel_21d].map((v, i) => (
                  <span key={i} style={{ textAlign: "right", color: retColor(v), fontVariantNumeric: "tabular-nums" }}>
                    {v == null ? "maturing" : fmtPct(v, 2, false)}
                  </span>
                ))}
              </div>
            ))}
            <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>
              * measured from the FIRST session the name crossed the threshold — the day you would
              actually have acted. “days in” is how many sessions it held above it.
            </div>
          </div>
        )}
      </HudPanel>

      {/* ---- 3. Band evidence ---- */}
      <HudPanel
        title="Band evidence"
        actions={
          <div style={{ display: "flex", gap: 4 }}>
            {(["fit", "all"] as const).map((p) => (
              <Btn key={p} size="sm" variant={population === p ? "primary" : undefined} onClick={() => setPopulation(p)}>
                {p === "fit" ? "liquid + full context" : "everything"}
              </Btn>
            ))}
          </div>
        }
      >
        {bands.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>no matured snapshots in this population yet</div>
        ) : (
          <div style={{ fontSize: 10, fontFamily: "var(--font-hud)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 0.7fr 0.7fr repeat(4, 1fr)", gap: 6, color: "var(--text-muted)" }}>
              <span>band</span><span style={{ textAlign: "right" }}>rows</span><span style={{ textAlign: "right" }}>matured</span>
              <span style={{ textAlign: "right" }}>hit 21d</span><span style={{ textAlign: "right" }}>beat NIFTY</span>
              <span style={{ textAlign: "right" }}>avg 21d</span><span style={{ textAlign: "right" }}>avg rel</span>
            </div>
            {sortBands(bands).map((b) => {
              const thin = b.sample_21d < MIN_BAND_SAMPLE;
              return (
                <div key={b.band} style={{ display: "grid", gridTemplateColumns: "1fr 0.7fr 0.7fr repeat(4, 1fr)", gap: 6, padding: "1px 0" }}>
                  <span style={{ color: "var(--text-dim)" }}>{b.band}</span>
                  <span style={{ textAlign: "right", color: "var(--text-muted)" }}>{b.sample_n}</span>
                  <span style={{ textAlign: "right", color: thin ? "var(--warn)" : "var(--text-muted)" }}>{b.sample_21d}</span>
                  <span style={{ textAlign: "right", color: "var(--text)" }}>{b.hit_rate_21d == null ? "—" : `${b.hit_rate_21d}%`}</span>
                  <span style={{ textAlign: "right", color: "var(--text)" }}>{b.rel_hit_rate_21d == null ? "—" : `${b.rel_hit_rate_21d}%`}</span>
                  <span style={{ textAlign: "right", color: retColor(b.avg_ret_21d) }}>{b.avg_ret_21d == null ? "—" : fmtPct(b.avg_ret_21d, 2, false)}</span>
                  <span style={{ textAlign: "right", color: retColor(b.avg_rel_21d) }}>{b.avg_rel_21d == null ? "—" : fmtPct(b.avg_rel_21d, 2, false)}</span>
                </div>
              );
            })}
            <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>
              bands under {MIN_BAND_SAMPLE} matured rows are noise, not evidence — treat them as unproven.
            </div>
          </div>
        )}
        {bucketFits.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 10, fontFamily: "var(--font-hud)" }}>
            <div className="hud-label" style={{ fontSize: 9, color: "var(--accent-soft)" }}>fitted bucket attribution</div>
            {bucketFits.map((c) => (
              <div key={c.component} style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr 0.8fr", gap: 6, padding: "1px 0" }}>
                <span style={{ color: "var(--text-dim)" }}>{c.component.slice(BUCKET_PREFIX.length)}</span>
                <span style={{ textAlign: "right", color: retColor(c.weight) }}>slope {c.weight.toFixed(3)}</span>
                <span style={{ textAlign: "right", color: "var(--text-muted)" }}>r² {c.r2?.toFixed(3) ?? "—"}</span>
                <span style={{ textAlign: "right", color: "var(--text-muted)" }}>n {c.sample_n ?? "—"}</span>
              </div>
            ))}
          </div>
        )}
      </HudPanel>

      {/* ---- 4. Weight search ---- */}
      <HudPanel
        title="Weight search"
        actions={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <select value={searchDays} onChange={(e) => setSearchDays(Number(e.target.value))} className="hud-select" style={{ fontSize: 10 }}>
              {[60, 90, 120, 180, 365].map((d) => <option key={d} value={d}>{d}d history</option>)}
            </select>
            <select value={horizon} onChange={(e) => setHorizon(e.target.value as "5d" | "10d" | "21d")} className="hud-select" style={{ fontSize: 10 }}>
              {(["5d", "10d", "21d"] as const).map((h) => <option key={h} value={h}>{h} horizon</option>)}
            </select>
            <Btn size="sm" variant="primary" disabled={optimize.isPending} onClick={run}>
              {optimize.isPending ? "searching…" : "Run search"}
            </Btn>
          </div>
        }
      >
        <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 6 }}>
          Replays every stored snapshot under alternative bucket weights, using the per-bucket values
          the scorer actually recorded. Ranked by <strong>spread</strong>: mean benchmark-relative
          return of the top-scoring decile minus the bottom decile. A positive spread means the score
          separates winners from losers; the live weights are the row to beat.
        </div>

        {optimize.isError && (
          <div style={{ fontSize: 11, color: "var(--danger)" }}>{(optimize.error as Error).message}</div>
        )}
        {result && result.ok === false && (
          <div style={{ fontSize: 11, color: "var(--warn)", lineHeight: 1.6 }}>{result.message}</div>
        )}

        {result?.candidates?.length ? (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
              <Chip>{result.sample_n} snapshots</Chip>
              <Chip>{result.sessions} sessions</Chip>
              <Chip>{horizon} horizon</Chip>
            </div>
            <div style={{ fontSize: 10, fontFamily: "var(--font-hud)", display: "grid", gridTemplateColumns: "1.8fr repeat(6, 1fr)", gap: 6 }}>
              <span style={{ color: "var(--text-muted)" }}>weights</span>
              <span style={{ textAlign: "right", color: "var(--text-muted)" }}>spread</span>
              <span style={{ textAlign: "right", color: "var(--text-muted)" }}>Δ vs live</span>
              <span style={{ textAlign: "right", color: "var(--text-muted)" }}>corr</span>
              <span style={{ textAlign: "right", color: "var(--text-muted)" }}>cohort rel</span>
              <span style={{ textAlign: "right", color: "var(--text-muted)" }}>cohort n</span>
              <span style={{ textAlign: "right", color: "var(--text-muted)" }}>hit</span>
              {result.baseline && <MetricRow label="live weights" m={result.baseline.metrics} />}
              {result.candidates.map((c) => (
                <MetricRow key={c.label} label={c.label} m={c.metrics} base={result.baseline?.metrics} />
              ))}
            </div>
            {result.candidates[0] && (
              <div style={{ marginTop: 10 }}>
                <div className="hud-label" style={{ fontSize: 9, color: "var(--accent-soft)" }}>
                  best candidate — {result.candidates[0].label}
                </div>
                <WeightBars weights={result.candidates[0].weights} base={V4_WEIGHTS} />
                <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.6 }}>
                  Nothing has been changed in the live scorer. To adopt these, the bucket weights in
                  the edge scorer (V4_WEIGHTS) must be updated deliberately and the history re-fitted
                  — otherwise today's scores and yesterday's snapshots stop being comparable.
                </div>
              </div>
            )}
          </>
        ) : !optimize.isPending && !result ? (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>no search run yet</div>
        ) : null}

        {runs.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 10, fontFamily: "var(--font-hud)" }}>
            <div className="hud-label" style={{ fontSize: 9, color: "var(--accent-soft)" }}>previous runs</div>
            {runs.map((r) => (
              <div key={r.id} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr 1.6fr", gap: 6, padding: "1px 0" }}>
                <span style={{ color: "var(--text-dim)" }}>{new Date(r.created_at).toLocaleString()}</span>
                <span style={{ color: "var(--text-muted)" }}>{r.params?.days ?? "—"}d</span>
                <span style={{ color: "var(--text-muted)" }}>{r.params?.horizon ?? "—"}</span>
                <span style={{ color: "var(--text-muted)" }}>n {r.sample_n ?? "—"}</span>
                <span style={{ color: retColor(r.best?.metrics?.spread ?? null) }}>
                  best spread {r.best?.metrics?.spread?.toFixed(2) ?? "—"} ({r.best?.label ?? "—"})
                </span>
              </div>
            ))}
          </div>
        )}
      </HudPanel>
    </div>
  );
}
