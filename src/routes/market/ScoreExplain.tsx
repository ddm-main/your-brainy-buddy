// Score Explained — one screen, evidence only.
//
// Everything comes from what the scorer stored for this symbol
// (market_stock_scores.breakout_v4_components = { buckets, factors, penalties }).
// Nothing is recomputed here, so the page can never disagree with the number
// the pipeline wrote. Descriptions live in tooltips, not in walls of prose.
import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { useStockScores } from "@/lib/market/hooks";
import {
  V4_BUCKETS, FUNDAMENTAL_FACTORS, FUNDAMENTAL_MULT_MIN, FUNDAMENTAL_MULT_MAX,
  PENALTY_LABELS, BUCKET_COLORS, buildBucketRows, factorsFor, factorPoints,
  bucketSentence, verdictOf, bandOf, BUCKET_MIN_COVERAGE,
} from "@/lib/market/scoreExplain";

const dim = "var(--text-dim)";
const muted = "var(--text-muted)";

const toneColor = (t: "ok" | "warn" | "err" | "dim") =>
  t === "ok" ? "var(--ok)" : t === "warn" ? "var(--warn)" : t === "err" ? "var(--danger)" : muted;

export default function ScoreExplain() {
  const { symbol = "" } = useParams();
  const [sp] = useSearchParams();
  const exchange = sp.get("exchange") ?? "NSE";
  const nav = useNavigate();
  const sym = symbol.toUpperCase();

  const { data: scores = [], isLoading } = useStockScores({ symbol: sym, limit: 1 });
  const score = scores[0];

  const v4 = (score?.breakout_v4_components ?? null) as any;
  const buckets = (v4?.buckets ?? null) as Record<string, number> | null;
  const factors = (v4?.factors ?? null) as Record<string, number> | null;
  const penalties = (v4?.penalties ?? null) as Record<string, number> | null;
  const coverage = (score?.breakout_v4_coverage ?? null) as Record<string, number> | null;

  const rows = useMemo(() => buildBucketRows(buckets, coverage), [buckets, coverage]);
  const total = score?.breakout_score_v4 ?? null;
  const earnedSum = rows.reduce((s, r) => s + r.earned, 0);
  const penaltyEntries = Object.entries(penalties ?? {}).filter(([, v]) => Number(v) > 0);
  const penaltySum = penaltyEntries.reduce((s, [, v]) => s + Number(v || 0), 0);
  const regimeMult = factors?.regime_mult ?? null;
  const fundMult = factors?.fundamental_mult ?? null;
  const dropped = rows.filter((r) => !r.present);

  // rank_pct is a percentile: 100 = best in universe. "top 0%" read as a bug.
  const rankPct = score?.breakout_v4_rank_pct == null ? null : Number(score.breakout_v4_rank_pct);
  const topPct = rankPct == null ? null : Math.max(0.1, 100 - rankPct);

  return (
    <div style={{ display: "grid", gap: 8, padding: 10 }}>
      {/* header — identity, score, and every outbound link in one row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="hud-label" style={{ fontSize: 14, color: "var(--text)" }}>{sym}</span>
        <Chip>{exchange}</Chip>
        {total != null && (
          <>
            <span style={{ fontFamily: "var(--font-hud)", fontSize: 26, lineHeight: 1, color: "var(--text)" }}>{total}</span>
            <Chip tone={bandOf(total).tone}>{score?.breakout_band ?? bandOf(total).label}</Chip>
            {topPct != null && <Chip>top {topPct < 1 ? "<1" : Math.round(topPct)}%</Chip>}
            <span style={{ fontSize: 10, color: muted }}>
              EOD {score?.computed_at ? new Date(score.computed_at).toLocaleDateString([], { day: "2-digit", month: "short" }) : "—"}
              {score?.close != null ? ` · ${Number(score.close).toFixed(2)}` : ""}
            </span>
          </>
        )}
        <div style={{ flex: 1 }} />
        <Btn size="sm" onClick={() => nav(`/market/analysis/${encodeURIComponent(sym)}`)}>Chart</Btn>
        <Btn size="sm" onClick={() => nav(`/market/score/${encodeURIComponent(sym)}`)}>History</Btn>
        <Btn size="sm" onClick={() => nav("/market/calibration")}>Calibration</Btn>
      </div>

      {isLoading ? (
        <div style={{ fontSize: 11, color: muted }}>loading…</div>
      ) : !score ? (
        <HudPanel title="Not covered">
          <div style={{ fontSize: 11, color: muted }}>
            {sym} isn't in the tracked universe — no score row exists.
          </div>
        </HudPanel>
      ) : total == null ? (
        <HudPanel title="Not scoreable">
          <div style={{ fontSize: 11, color: dim }}>
            {score.score_unavailable_reason ?? "no v4 score written for this symbol yet"}
            {score.bars_available != null && <span style={{ color: muted }}> ({score.bars_available} sessions)</span>}
          </div>
        </HudPanel>
      ) : (
        <>
          {/* ---------- distribution of 100 ---------- */}
          <HudPanel title="Distribution of 100">
            <div style={{ display: "flex", height: 14, background: "var(--edge)", overflow: "hidden" }}>
              {rows.filter((r) => r.earned > 0).map((r) => (
                <div key={r.key} title={`${r.label}: ${r.earned.toFixed(1)} pts`}
                     style={{ width: `${r.earned}%`, background: BUCKET_COLORS[r.key], height: "100%" }} />
              ))}
              <div title={`not earned: ${(100 - earnedSum).toFixed(1)}`}
                   style={{ flex: 1, background: "repeating-linear-gradient(45deg, var(--edge) 0 4px, transparent 4px 8px)" }} />
            </div>

            <div style={{ fontSize: 10, fontFamily: "var(--font-hud)", marginTop: 8 }}>
              <Grid head>
                <span>bucket</span>
                <span style={{ textAlign: "right" }}>weight</span>
                <span style={{ textAlign: "right" }}>earned</span>
                <span style={{ textAlign: "right" }}>%</span>
              </Grid>
              {rows.map((r) => (
                <Grid key={r.key}>
                  <span style={{ color: r.present ? dim : muted }}
                        title={r.present ? undefined : `dropped — only ${Math.round(r.coverage * 100)}% covered, weight redistributed`}>
                    <span style={{ width: 6, height: 6, background: BUCKET_COLORS[r.key], display: "inline-block", marginRight: 5, opacity: r.present ? 1 : 0.3 }} />
                    {r.key}{!r.present && <span style={{ color: "var(--warn)" }}> ·</span>}
                  </span>
                  <Num>{r.present && Math.abs(r.ceiling - r.weight) >= 0.1 ? `${r.weight}→${r.ceiling.toFixed(1)}` : r.weight}</Num>
                  <Num color={r.present ? "var(--text)" : muted}>{r.present ? r.earned.toFixed(1) : "—"}</Num>
                  <Num>{r.present && r.ceiling > 0 ? `${Math.round((r.earned / r.ceiling) * 100)}%` : "—"}</Num>
                </Grid>
              ))}
              <Grid foot>
                <span>earned</span><span /><Num color="var(--text)">{earnedSum.toFixed(1)}</Num><span />
              </Grid>
              {penaltySum > 0 && (
                <Grid foot><span>penalties</span><span /><Num color="var(--danger)">−{penaltySum.toFixed(1)}</Num><span /></Grid>
              )}
              {regimeMult != null && regimeMult !== 1 && (
                <Grid foot><span>regime</span><span /><Num color={regimeMult > 1 ? "var(--ok)" : "var(--warn)"}>×{regimeMult}</Num><span /></Grid>
              )}
              {fundMult != null && fundMult !== 1 && (
                <Grid foot><span>fundamentals</span><span /><Num color={fundMult > 1 ? "var(--ok)" : "var(--warn)"}>×{fundMult}</Num><span /></Grid>
              )}
              <Grid foot>
                <span style={{ color: "var(--text)" }}>final</span><span /><Num color="var(--text)">{total}</Num><span />
              </Grid>
            </div>
            <div style={{ fontSize: 9, color: muted, marginTop: 5 }}>
              Raw weights sum to 100; a dropped bucket's weight is spread over the rest (shown as 22→24.2).
            </div>
          </HudPanel>

          {/* ---------- buckets, collapsed ---------- */}
          <HudPanel title="Buckets">
            {V4_BUCKETS.map((spec) => {
              const row = rows.find((r) => r.key === spec.key)!;
              const fr = factorPoints(factorsFor(spec.key, factors), row.earned);
              return <BucketRowView key={spec.key} spec={spec} row={row} fr={fr} />;
            })}
          </HudPanel>

          {/* ---------- adjustments & gaps ---------- */}
          <HudPanel title="Adjustments & gaps">
            <Sub>Penalties</Sub>
            {penaltyEntries.length === 0 ? (
              <div style={{ fontSize: 10, color: muted }}>none applied</div>
            ) : penaltyEntries.map(([k, v]) => {
              const meta = PENALTY_LABELS[k];
              return (
                <div key={k} title={meta?.why ?? "charged by the scorer"}
                     style={{ display: "flex", justifyContent: "space-between", fontSize: 10, padding: "1px 0" }}>
                  <span style={{ color: dim }}>{meta?.label ?? k}</span>
                  <span style={{ color: "var(--danger)", fontVariantNumeric: "tabular-nums" }}>−{Number(v).toFixed(1)}</span>
                </div>
              );
            })}

            <Sub>Fundamentals ×{fundMult ?? 1}</Sub>
            <div style={{ fontSize: 9, color: muted, marginBottom: 3 }}>
              A multiplier, never points — clamped to ×{FUNDAMENTAL_MULT_MIN}–×{FUNDAMENTAL_MULT_MAX}; unknown books stay at ×1.
            </div>
            <div style={{ fontSize: 10, fontFamily: "var(--font-hud)" }}>
              {FUNDAMENTAL_FACTORS.map((s) => {
                const raw = factors?.[`fundamentals.${s.key}`];
                const val = raw == null ? null : Number(raw);
                const v = verdictOf(val);
                return (
                  <div key={s.key} title={`${s.what} Full credit: ${s.full}`}
                       style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "1px 0" }}>
                    <span style={{ color: dim, flex: 1 }}>{s.label}</span>
                    <span style={{ color: muted }}>{Math.round(s.w * 100)}%</span>
                    <span style={{ color: toneColor(v.tone), fontVariantNumeric: "tabular-nums", width: 90, textAlign: "right" }}>
                      {val == null ? "—" : val.toFixed(2)} · {v.word}
                    </span>
                  </div>
                );
              })}
            </div>

            <Sub>Missing data</Sub>
            {dropped.length === 0 ? (
              <div style={{ fontSize: 10, color: muted }}>every bucket cleared the {Math.round(BUCKET_MIN_COVERAGE * 100)}% coverage floor</div>
            ) : dropped.map((r) => {
              const missing = factorsFor(r.key, factors).filter((f) => f.value == null).map((f) => f.spec.label);
              return (
                <div key={r.key} title={missing.length ? `missing: ${missing.join(", ")}` : "no sub-factor values recorded"}
                     style={{ display: "flex", justifyContent: "space-between", fontSize: 10, padding: "1px 0" }}>
                  <span style={{ color: dim }}>{r.label}</span>
                  <span style={{ color: "var(--warn)" }}>{Math.round(r.coverage * 100)}% covered · {r.weight} pts redistributed</span>
                </div>
              );
            })}
            {score.score_coverage != null && (
              <div style={{ fontSize: 9, color: muted, marginTop: 5 }}>
                Model coverage {Math.round(Number(score.score_coverage) * 100)}% (below 45% no score is emitted).
              </div>
            )}
          </HudPanel>
        </>
      )}

      <HowItWorks />
    </div>
  );
}

/** One collapsed bucket line; expands to its sub-factor table. */
function BucketRowView({ spec, row, fr }: {
  spec: (typeof V4_BUCKETS)[number];
  row: ReturnType<typeof buildBucketRows>[number];
  fr: ReturnType<typeof factorPoints>;
}) {
  const [open, setOpen] = useState(false);
  const pct = row.present && row.ceiling > 0 ? Math.round((row.earned / row.ceiling) * 100) : 0;
  return (
    <div style={{ borderBottom: "1px solid var(--edge)" }}>
      <button onClick={() => setOpen((o) => !o)} title={spec.blurb}
              style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", padding: "4px 0", cursor: "pointer", color: "inherit", textAlign: "left" }}>
        {open ? <ChevronDown size={11} color={muted} /> : <ChevronRight size={11} color={muted} />}
        <span style={{ width: 6, height: 6, background: BUCKET_COLORS[spec.key], opacity: row.present ? 1 : 0.3 }} />
        <span style={{ fontSize: 11, color: row.present ? dim : muted, flex: "0 0 150px" }}>{spec.label}</span>
        <span style={{ flex: 1, height: 3, background: "var(--edge)" }}>
          <span style={{ display: "block", height: "100%", width: `${Math.min(100, pct)}%`, background: BUCKET_COLORS[spec.key] }} />
        </span>
        <span style={{ fontSize: 10, fontFamily: "var(--font-hud)", color: row.present ? "var(--text)" : muted, fontVariantNumeric: "tabular-nums", width: 96, textAlign: "right" }}>
          {row.present ? `${row.earned.toFixed(1)} / ${row.ceiling.toFixed(1)}` : "dropped"}
        </span>
      </button>
      {open && (
        <div style={{ padding: "0 0 8px 23px" }}>
          <div style={{ fontSize: 10, color: dim, lineHeight: 1.5, marginBottom: 5 }}>{bucketSentence(row, fr)}</div>
          <div style={{ fontSize: 10, fontFamily: "var(--font-hud)" }}>
            <FGrid head>
              <span>sub-factor</span>
              <span style={{ textAlign: "right" }}>weight</span>
              <span style={{ textAlign: "right" }}>value</span>
              <span style={{ textAlign: "right" }}>points</span>
              <span>read</span>
            </FGrid>
            {fr.map((f) => {
              const v = verdictOf(f.value);
              return (
                <div key={f.spec.key} title={`${f.spec.what} Full credit: ${f.spec.full}`}>
                  <FGrid>
                    <span style={{ color: dim, borderBottom: "1px dotted var(--edge)" }}>{f.spec.label}</span>
                    <Num>{Math.round(f.spec.w * 100)}%</Num>
                    <Num color={toneColor(v.tone)}>{f.value == null ? "—" : f.value.toFixed(2)}</Num>
                    <Num color={row.present && f.value != null ? "var(--text)" : muted}>
                      {row.present && f.value != null ? f.points.toFixed(1) : "—"}
                    </Num>
                    <span style={{ color: toneColor(v.tone) }}>{v.word}</span>
                  </FGrid>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function HowItWorks() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: "1px solid var(--edge)" }}>
      <button onClick={() => setOpen((o) => !o)} className="hud-btn" data-variant="ghost" data-size="sm"
              style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", justifyContent: "flex-start" }}>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} How the model works
      </button>
      {open && (
        <div style={{ padding: "6px 12px 8px", fontSize: 10, color: muted, lineHeight: 1.6 }}>
          Breakout Intelligence v4 is a coverage-aware 100-point model: seven buckets of 0–1 sub-factors,
          raw weights summing to 100. Missing sub-factors renormalise inside their bucket, buckets under{" "}
          {Math.round(BUCKET_MIN_COVERAGE * 100)}% coverage are dropped and their weight redistributed,
          penalties are subtracted in points, then regime and fundamentals multipliers scale the result.
          Under 120 sessions of history or 45% coverage it returns no score at all.
          Hover any bucket or sub-factor for what it measures and what full credit looks like.
        </div>
      )}
    </div>
  );
}

const GRID = "1.6fr 0.8fr 0.7fr 0.6fr";
const FGRID = "1.4fr 0.6fr 0.6fr 0.6fr 0.8fr";

function Sub({ children }: { children: React.ReactNode }) {
  return (
    <div className="hud-label" style={{ fontSize: 9, letterSpacing: "0.14em", color: "var(--accent-soft)", margin: "8px 0 3px" }}>
      {children}
    </div>
  );
}

function Grid({ children, head, foot }: { children: React.ReactNode; head?: boolean; foot?: boolean }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: GRID, gap: 6, padding: "2px 0",
      color: head ? muted : dim,
      borderTop: foot ? "1px solid var(--edge)" : undefined,
      borderBottom: head ? "1px solid var(--edge)" : undefined,
    }}>{children}</div>
  );
}

function FGrid({ children, head }: { children: React.ReactNode; head?: boolean }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: FGRID, gap: 6, padding: "1px 0",
      color: head ? muted : dim, borderBottom: head ? "1px solid var(--edge)" : undefined,
    }}>{children}</div>
  );
}

function Num({ children, color }: { children: React.ReactNode; color?: string }) {
  return <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: color ?? muted }}>{children}</span>;
}
