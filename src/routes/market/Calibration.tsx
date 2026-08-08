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
  useLabCoverage, useRunBackfill, useRunEvaluate, MIN_OPTIMIZER_ROWS, optimizerReadiness,
  V4_WEIGHTS, type OptimizerCandidate, type OptimizerMetrics,
} from "@/lib/market/scoreLab";


import { useScoreBandStats, useScoreCalibration, sortBands, MIN_BAND_SAMPLE, BUCKET_PREFIX } from "@/lib/market/scoreHistory";

const BUCKETS = Object.keys(V4_WEIGHTS);
const retColor = (v: number | null | undefined) =>
  v == null ? "var(--text-muted)" : v > 0 ? "var(--ok)" : v < 0 ? "var(--danger)" : "var(--text-dim)";

function MetricRow({ label, m, base, test }: {
  label: string; m: OptimizerMetrics; base?: OptimizerMetrics; test?: OptimizerMetrics | null;
}) {
  const delta = base ? m.spread - base.spread : null;
  return (
    <>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={{ textAlign: "right", color: retColor(m.spread) }}>{m.spread.toFixed(2)}</span>
      <span title="Same weights, on sessions the search never saw"
            style={{ textAlign: "right", color: test ? retColor(test.spread) : "var(--text-muted)" }}>
        {test ? test.spread.toFixed(2) : "—"}
      </span>
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
  const [population, setPopulation] = useState<"fit" | "all">("all");
  const [horizon, setHorizon] = useState<"5d" | "10d" | "21d">("21d");
  const [searchDays, setSearchDays] = useState(120);
  const [result, setResult] = useState<{
    baseline?: { weights: Record<string, number>; metrics: OptimizerMetrics; test_metrics?: OptimizerMetrics | null } | null;
    candidates?: OptimizerCandidate[];
    sample_n?: number;
    sessions?: number;
    symbols?: number;
    split_ok?: boolean;
    split_date?: string | null;
    test_n?: number;
    population?: string;
    live_rows?: number;
    neutral_rows?: number;

    message?: string;
    ok?: boolean;
  } | null>(null);

  const [batch, setBatch] = useState<{ running: boolean; passes: number; symbols: number; rows: number; note: string } | null>(null);

  const { data: cohort = [], isLoading: cohortLoading, error: cohortError } = useScoreCohort(days, threshold, population);
  const { data: members = [], error: membersError } = useScoreCohortSymbols(days, threshold, 200, population);
  const { data: bands = [] } = useScoreBandStats(population);
  const { data: calibrationData } = useScoreCalibration();
  const { data: runs = [] } = useOptimizerRuns(5);
  const { data: coverage } = useLabCoverage();
  const optimize = useRunOptimizer();
  const backfill = useRunBackfill();
  const evaluate = useRunEvaluate();

  const calibration = calibrationData?.rows ?? [];
  const totalQualified = cohort.reduce((s, d) => s + d.n_qualified, 0);
  const daysWithNone = cohort.filter((d) => d.n_qualified === 0).length;
  const fitLine = calibration.find((c) => c.component === "score_vs_fwd_rel_21d")
    ?? calibration.find((c) => c.component === "score_vs_fwd_ret_21d") ?? null;
  const bucketFits = calibration.filter((c) => c.component.startsWith(BUCKET_PREFIX));
  // Coverage + "not fitted, and why" are diagnostics now, not fake components.
  const coverageMeta = (calibrationData?.coverage?.meta ?? null) as Record<string, unknown> | null;
  const popRow = coverageMeta
    ? { component: `population:${String(coverageMeta.population ?? "unknown")}` }
    : null;
  const notFitted = calibrationData?.notFitted ?? null;
  const notFittedMeta = (notFitted?.meta ?? null) as Record<string, unknown> | null;
  const insufficient = notFitted
    ? {
        component: `not fitted — ${String(notFittedMeta?.reason ?? "insufficient coverage")}`
          + ` (rows ${String(notFittedMeta?.rows ?? "?")}/${String(notFittedMeta?.min_rows ?? "?")},`
          + ` symbols ${String(notFittedMeta?.symbols ?? "?")},`
          + ` sessions ${String(notFittedMeta?.sessions ?? "?")}/${String(notFittedMeta?.min_sessions ?? "?")})`,
      }
    : null;
  // Older writers stuffed the coverage verdict into a plain component string
  // ("coverage:insufficient population=… symbols=… sessions=…"). Those rows are
  // not diagnostics by `kind`, so the panel used to drop them silently and just
  // report "not fitted yet" with no reason at all.
  const legacyCoverage = !notFitted && !coverageMeta
    ? calibration.find((c) => c.component.startsWith("coverage:")) ?? null
    : null;

  // Anti-predictive is a property of the evidence, not only of a fitted slope
  // — with no fit ever stored, the warning could never fire.
  const bandOf = (name: string) => bands.find((b) => (b.band ?? "").toUpperCase() === name);
  const strong = bandOf("STRONG");
  const weak = bandOf("WEAK");
  const bandInverted =
    strong?.avg_rel_21d != null && weak?.avg_rel_21d != null &&
    strong.sample_21d > 0 && weak.sample_21d > 0 &&
    strong.avg_rel_21d < weak.avg_rel_21d;

  const maturedPool = population === "fit" ? (coverage?.maturedFit ?? 0) : (coverage?.matured21 ?? 0);
  // Gate on the pool the engine actually fits — matured, with bucket detail,
  // not illiquid — instead of every matured row in the table.
  const readiness = optimizerReadiness(coverage);
  const searchBlocked = readiness != null && !readiness.ready;

  const run = () => {
    optimize.mutate({ days: searchDays, threshold, horizon, iterations: 400 }, {
      onSuccess: (d) => setResult(d as never),
    });
  };

  /** Bounded backfill passes, chained, with the pool refreshed after each one. */
  const runBackfillBatch = async (passes = 5) => {
    setBatch({ running: true, passes: 0, symbols: 0, rows: 0, note: "" });
    let symbols = 0, rows = 0;
    for (let i = 0; i < passes; i++) {
      try {
        const d = await backfill.mutateAsync({ limit: 20, sessions: 120 });
        symbols += d.symbols ?? 0;
        rows += d.rows_written ?? 0;
        setBatch({ running: true, passes: i + 1, symbols, rows, note: d.skipped ?? "" });
        if (d.drained || d.skipped) {
          setBatch({ running: false, passes: i + 1, symbols, rows, note: d.skipped ?? "no candidates left to replay" });
          return;
        }
      } catch (e) {
        setBatch({ running: false, passes: i, symbols, rows, note: (e as Error).message });
        return;
      }
    }
    setBatch({ running: false, passes, symbols, rows, note: "" });
  };



  return (
    <div style={{ display: "grid", gap: 10, padding: 10 }}>
      {/* One summary strip, pinned. The lab used to scroll every inner panel
          separately, so the state of the fit disappeared as soon as you read
          any of the evidence. */}
      <div
        style={{
          position: "sticky", top: -14, zIndex: 2,
          display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
          padding: "8px 0", margin: "-4px 0 0",
          background: "var(--bg-deep, #071019)", borderBottom: "1px solid var(--edge)",
        }}
      >
        <span className="hud-label" style={{ fontSize: 14, color: "var(--text)" }}>Model Calibration Lab</span>
        <Chip tone={readiness?.ready ? "ok" : "warn"}>
          {readiness ? `${readiness.pool}/${MIN_OPTIMIZER_ROWS} usable` : "— usable"}
        </Chip>
        <Chip>{coverage?.matured21 ?? "—"} matured</Chip>

        <Chip>{cohort.length} sessions</Chip>
        <Chip>{members.length} symbols</Chip>
        {fitLine ? (
          <>
            <Chip tone={(fitLine.weight ?? 0) > 0 ? "ok" : "err"}>
              slope {fitLine.weight.toFixed(4)}
            </Chip>
            {fitLine.r2 != null && <Chip tone={fitLine.r2 >= 0.02 ? "ok" : "warn"}>r² {fitLine.r2.toFixed(3)}</Chip>}
            <Chip>n {fitLine.sample_n ?? "—"}</Chip>
          </>
        ) : <Chip tone="warn">not fitted yet</Chip>}
        {insufficient && <Chip tone="warn">{insufficient.component}</Chip>}
        {legacyCoverage && (
          <Chip tone="warn">
            last fit refused — {legacyCoverage.component.replace(/^coverage:/, "").replace(/_/g, " ")}
          </Chip>
        )}

        {popRow && (
          <Chip tone={popRow.component.endsWith("full_context") ? "ok" : "warn"}>
            fitted on {popRow.component.slice("population:".length).replace(/_/g, " ")} ·{" "}
            {String(coverageMeta?.rows ?? "—")} rows · {String(coverageMeta?.symbols ?? "—")} symbols
          </Chip>
        )}
        {fitLine && (fitLine.weight ?? 0) < 0 && (
          <Chip tone="err">score is currently anti-predictive — higher score, worse forward return</Chip>
        )}
        {!fitLine && bandInverted && (
          <Chip tone="err">
            STRONG is under-performing WEAK on matured rows ({strong!.avg_rel_21d!.toFixed(2)} vs{" "}
            {weak!.avg_rel_21d!.toFixed(2)} rel 21d) — the score is anti-predictive today
          </Chip>
        )}
      </div>


      {/* ---- Evidence available ---- */}
      <HudPanel
        title="Evidence available"
        actions={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Btn size="sm" disabled={backfill.isPending || batch?.running}
                 onClick={() => backfill.mutate({ limit: 20, sessions: 120 })}>
              {backfill.isPending && !batch?.running ? "backfilling…" : "Backfill once"}
            </Btn>
            <Btn size="sm" disabled={backfill.isPending || batch?.running} onClick={() => runBackfillBatch(5)}>
              {batch?.running ? `backfilling… pass ${batch.passes}/5` : "Backfill ×5"}
            </Btn>
            <Btn size="sm" variant="primary" disabled={evaluate.isPending} onClick={() => evaluate.mutate()}>
              {evaluate.isPending ? "evaluating…" : "Evaluate & fit"}
            </Btn>
          </div>
        }
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 10 }}>
          <Chip>{coverage?.rows ?? "—"} snapshots</Chip>
          <Chip tone={(coverage?.matured21 ?? 0) > 0 ? "neutral" : "warn"}>
            {coverage?.matured21 ?? "—"} matured 21d
          </Chip>
          <Chip tone={(coverage?.maturedFit ?? 0) > 0 ? "ok" : "warn"}>
            {coverage?.maturedFit ?? "—"} matured in liquid + full context
          </Chip>
          <Chip>{coverage?.liveRows ?? "—"} live-context rows</Chip>
          <Chip tone={readiness?.ready ? "ok" : "warn"}>
            search pool {readiness?.pool ?? "—"}/{MIN_OPTIMIZER_ROWS}
            {readiness ? ` (${readiness.population.replace(/_/g, " ")})` : ""}
          </Chip>
          {(coverage?.unknownLiquidity ?? 0) > 0 && (
            <Chip tone="warn">
              {coverage!.unknownLiquidity} rows with unknown liquidity — excluded from every population
            </Chip>
          )}
        </div>
        {backfill.isError && (
          <div style={{ fontSize: 10, color: "var(--danger)", marginTop: 6 }}>{(backfill.error as Error).message}</div>
        )}
        {batch && (
          <div style={{ fontSize: 10, color: batch.note && !batch.running ? "var(--warn)" : "var(--text-muted)", marginTop: 6 }}>
            {batch.running ? "running" : "finished"} · {batch.passes} pass{batch.passes === 1 ? "" : "es"} ·{" "}
            {batch.symbols} symbols · {batch.rows} rows written{batch.note ? ` · ${batch.note}` : ""}
          </div>
        )}
        {!batch && backfill.data && (
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 6 }}>
            {backfill.data.skipped
              ? `backfill skipped — ${backfill.data.skipped}`
              : backfill.data.drained
                ? "no candidates left to replay"
                : `replayed ${backfill.data.symbols ?? 0} symbols · ${backfill.data.rows_written ?? 0} rows written`}
          </div>
        )}
        {evaluate.isError && (
          <div style={{ fontSize: 10, color: "var(--danger)", marginTop: 6 }}>
            evaluate failed — {(evaluate.error as Error).message}
          </div>
        )}
        {evaluate.data && (
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.6 }}>
            matured {evaluate.data.evaluated_rows ?? 0} rows ·{" "}
            {(evaluate.data.calibration_rows ?? 0) > 0
              ? `fit wrote ${evaluate.data.calibration_rows} calibration rows`
              : "fit produced no slope — not enough rows, symbols or sessions for this model"}
            {" "}· ranked {evaluate.data.ranked_rows ?? 0} · distribution {evaluate.data.distribution_rows ?? 0}
          </div>
        )}
        <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.6 }}>
          A snapshot only becomes evidence 21 sessions after it was taken. Backfill replays older
          sessions for symbols that have price history but no stored score, in bounded batches;
          "Evaluate &amp; fit" is the pass that fills the forward returns, refits the calibration and
          restamps the bands. Backfill alone changes nothing you can read here.
        </div>
      </HudPanel>


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
          <span style={{ color: "var(--text-muted)" }}>population</span>
          {(["all", "fit"] as const).map((p) => (
            <Btn key={p} size="sm" variant={population === p ? "primary" : undefined} onClick={() => setPopulation(p)}>
              {p === "fit" ? "liquid + full context" : "everything"}
            </Btn>
          ))}
          <Chip>{totalQualified} qualifiers</Chip>
          <Chip tone={daysWithNone > cohort.length / 2 ? "warn" : "neutral"}>
            {daysWithNone}/{cohort.length} sessions with none
          </Chip>
          <Chip tone={maturedPool > 0 ? "neutral" : "warn"}>{maturedPool} matured in this population</Chip>
        </div>
      </HudPanel>

      {/* ---- 1. Per-session cohort ---- */}
      <HudPanel title={`Sessions above ${threshold}`}>
        {cohortError ? (
          <div style={{ fontSize: 11, color: "var(--danger)" }}>
            cohort query failed — {(cohortError as Error).message}
          </div>
        ) : cohortLoading ? (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>loading…</div>
        ) : cohort.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {(coverage?.rows ?? 0) === 0
              ? "no score history stored for this model yet"
              : `${coverage?.rows} snapshots exist, but none in the last ${days} sessions matched this population`}
          </div>
        ) : (

          <div style={{ fontSize: 10, fontFamily: "var(--font-hud)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.7fr 0.7fr repeat(5, 1fr)", gap: 6, color: "var(--text-muted)", position: "sticky", top: 40, zIndex: 1, background: "var(--bg-deep, #071019)", padding: "2px 0" }}>

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
        {membersError ? (
          <div style={{ fontSize: 11, color: "var(--danger)" }}>
            membership query failed — {(membersError as Error).message}
          </div>
        ) : members.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            nothing crossed {threshold} in the last {days} sessions
            {population === "fit" ? " within the liquid + full-context population" : ""}
          </div>
        ) : (

          <div style={{ fontSize: 10, fontFamily: "var(--font-hud)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.4fr 0.8fr 0.8fr 0.8fr 1.1fr 1.1fr repeat(3, 1fr)", gap: 6, color: "var(--text-muted)", position: "sticky", top: 40, zIndex: 1, background: "var(--bg-deep, #071019)", padding: "2px 0" }}>

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
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            no matured snapshots in this population yet
            {population === "fit" && (coverage?.matured21 ?? 0) > 0
              ? ` — ${coverage!.matured21} matured rows exist, but all of them are replayed or illiquid. Switch to "everything" to see them.`
              : ""}
          </div>
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
            <Btn size="sm" variant="primary" disabled={optimize.isPending || searchBlocked} onClick={run}>
              {optimize.isPending ? "searching…" : "Run search"}
            </Btn>

          </div>
        }
      >
        {searchBlocked && readiness && (
          <div style={{ fontSize: 10, color: "var(--warn)", lineHeight: 1.6, marginBottom: 6 }}>
            Search disabled: {readiness.pool} of the {MIN_OPTIMIZER_ROWS} usable snapshots the engine
            needs — {readiness.shortfall} short. Usable means matured on the 21-day relative horizon,
            carrying stored bucket detail, and not flagged illiquid
            {coverage ? ` (live pool ${coverage.optimizerLive}, replayed pool ${coverage.optimizerNeutral})` : ""}.
            Run "Backfill ×5", then "Evaluate &amp; fit", or wait for live rows to mature. The count
            here is before de-overlap thinning, so the engine may still see slightly fewer.
          </div>
        )}

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
            {(result as { advisory?: boolean; advisory_reason?: string }).advisory && (
              <div style={{ fontSize: 10, color: "var(--warn)", lineHeight: 1.6, marginBottom: 6 }}>
                Advisory only — {(result as { advisory_reason?: string }).advisory_reason
                  ?? "this fit is not backed by live full-context evidence"}. Do not promote these
                weights on this run alone.
              </div>
            )}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>

              <Chip>{result.sample_n} snapshots</Chip>
              <Chip>{result.sessions} sessions</Chip>
              <Chip>{horizon} horizon</Chip>
              {result.symbols != null && <Chip>{result.symbols} symbols</Chip>}
              {result.population && <Chip>{result.population.replace(/_/g, " ")}</Chip>}
              <Chip>{result.split_ok ? `hold-out ${result.test_n} rows after ${result.split_date}` : "no hold-out — in-sample only"}</Chip>
            </div>
            {result.population === "replayed_neutral" && (
              <div style={{ fontSize: 10, color: "var(--warn)", lineHeight: 1.6, marginBottom: 6 }}>
                Fitted on replayed context-neutral rows ({result.neutral_rows ?? 0} available) because only{" "}
                {result.live_rows ?? 0} live full-context rows have matured. Replayed rows carry no regime or
                sector context — these weights are not live evidence.
              </div>
            )}
            {!result.split_ok && (
              <div style={{ fontSize: 10, color: "var(--warn)", lineHeight: 1.6, marginBottom: 6 }}>
                Too few sessions to hold any out — these numbers are in-sample and will flatter the
                search. Treat them as a hypothesis, not a result.
              </div>
            )}

            <div style={{ fontSize: 10, fontFamily: "var(--font-hud)", display: "grid", gridTemplateColumns: "1.8fr repeat(7, 1fr)", gap: 6 }}>
              <span style={{ color: "var(--text-muted)" }}>weights</span>
              <span style={{ textAlign: "right", color: "var(--text-muted)" }}>spread</span>
              <span style={{ textAlign: "right", color: "var(--text-muted)" }}>test</span>
              <span style={{ textAlign: "right", color: "var(--text-muted)" }}>Δ vs live</span>
              <span style={{ textAlign: "right", color: "var(--text-muted)" }}>corr</span>
              <span style={{ textAlign: "right", color: "var(--text-muted)" }}>cohort rel</span>
              <span style={{ textAlign: "right", color: "var(--text-muted)" }}>cohort n</span>
              <span style={{ textAlign: "right", color: "var(--text-muted)" }}>hit</span>
              {result.baseline && (
                <MetricRow label="live weights" m={result.baseline.metrics} test={result.baseline.test_metrics} />
              )}
              {result.candidates.map((c) => (
                <MetricRow key={c.label} label={c.label} m={c.metrics} test={c.test_metrics}
                           base={result.baseline?.metrics} />
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
            {runs.map((r) => {
              // The run row only guarantees these inside `params` — the engine
              // writes provenance there, not as top-level columns, so reading
              // r.split_ok alone reported every run as in-sample.
              const p = (r.params ?? {}) as Record<string, unknown>;
              const pop = String(r.population ?? p.population ?? "population ?");
              const splitOk = r.split_ok ?? (p.split_ok as boolean | undefined) ?? false;
              const splitDate = r.split_date ?? (p.split_date as string | undefined) ?? "—";
              return (
                <div key={r.id} style={{ display: "grid", gridTemplateColumns: "1.4fr 0.7fr 0.7fr 0.8fr 1.3fr 1.6fr", gap: 6, padding: "1px 0" }}>
                  <span style={{ color: "var(--text-dim)" }}>{new Date(r.created_at).toLocaleString()}</span>
                  <span style={{ color: "var(--text-muted)" }}>{r.params?.days ?? "—"}d</span>
                  <span style={{ color: "var(--text-muted)" }}>{r.params?.horizon ?? "—"}</span>
                  <span style={{ color: "var(--text-muted)" }}>n {r.sample_n ?? "—"}</span>
                  {/* Which pool the run was fitted on decides whether it is
                      evidence at all — a replayed-neutral fit is a hypothesis. */}
                  <span
                    title={splitOk ? `hold-out ${r.test_n ?? "—"} rows after ${splitDate}` : "in-sample only — no hold-out"}
                    style={{ color: pop === "full_context" ? "var(--ok)" : "var(--warn)" }}
                  >
                    {pop.replace(/_/g, " ")}
                    {splitOk ? "" : " · in-sample"}
                  </span>
                  <span style={{ color: retColor(r.best?.metrics?.spread ?? null) }}>
                    best spread {r.best?.metrics?.spread?.toFixed(2) ?? "—"} ({r.best?.label ?? "—"})
                  </span>
                </div>
              );
            })}

          </div>
        )}
      </HudPanel>
    </div>
  );
}
