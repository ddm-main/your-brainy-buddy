// Score Explained — the full audit trail behind one Breakout Intelligence score.
//
// Everything here comes from what the scorer actually stored for this symbol
// (market_stock_scores.breakout_v4_components = { buckets, factors, penalties }).
// Nothing is recomputed on the client, so the page can never disagree with the
// number the pipeline wrote.
import { useMemo } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
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
  const penaltySum = Object.values(penalties ?? {}).reduce((s, v) => s + Number(v || 0), 0);
  const regimeMult = factors?.regime_mult ?? null;
  const fundMult = factors?.fundamental_mult ?? null;
  const dropped = rows.filter((r) => !r.present);

  return (
    <div style={{ display: "grid", gap: 10, padding: 10 }}>
      {/* ---------- header ---------- */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="hud-label" style={{ fontSize: 14, color: "var(--text)" }}>{sym}</span>
        <Chip>{exchange}</Chip>
        <span className="hud-label" style={{ fontSize: 10, color: muted }}>score explained</span>
        <div style={{ flex: 1 }} />
        <Btn size="sm" onClick={() => nav(`/market/analysis/${encodeURIComponent(sym)}`)}>Chart</Btn>
        <Btn size="sm" onClick={() => nav(`/market/score/${encodeURIComponent(sym)}`)}>Score history</Btn>
      </div>

      {isLoading ? (
        <div style={{ fontSize: 11, color: muted }}>loading…</div>
      ) : !score ? (
        <HudPanel title="Not covered">
          <div style={{ fontSize: 11, color: muted, lineHeight: 1.6 }}>
            {sym} isn't in the tracked universe — no score row exists. Run the pipeline from
            Settings → Sync universe.
          </div>
        </HudPanel>
      ) : total == null ? (
        <HudPanel title="Not scoreable">
          <div style={{ fontSize: 11, color: dim, lineHeight: 1.6 }}>
            {score.score_unavailable_reason ?? "the pipeline hasn't written a v4 score for this symbol yet"}
            {score.bars_available != null && <span style={{ color: muted }}> ({score.bars_available} sessions of history)</span>}.
          </div>
        </HudPanel>
      ) : (
        <>
          {/* ---------- distribution of 100 ---------- */}
          <HudPanel title="Distribution of 100">
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--font-hud)", fontSize: 34, lineHeight: 1, color: "var(--text)" }}>{total}</span>
              <Chip tone={bandOf(total).tone}>{score.breakout_band ?? bandOf(total).label}</Chip>
              {score.breakout_v4_rank_pct != null && <Chip>top {Math.round(100 - Number(score.breakout_v4_rank_pct))}% of universe</Chip>}
              <span style={{ fontSize: 10, color: muted }}>
                EOD · {score.computed_at ? new Date(score.computed_at).toLocaleDateString([], { day: "2-digit", month: "short", year: "2-digit" }) : "—"}
                {score.close != null ? ` · close ${Number(score.close).toFixed(2)}` : ""}
              </span>
            </div>

            {/* stacked bar: earned per bucket + everything not earned */}
            <div style={{ display: "flex", height: 16, background: "var(--edge)", overflow: "hidden" }}>
              {rows.filter((r) => r.earned > 0).map((r) => (
                <div key={r.key} title={`${r.label}: ${r.earned.toFixed(1)} pts`}
                     style={{ width: `${r.earned}%`, background: BUCKET_COLORS[r.key], height: "100%" }} />
              ))}
              <div style={{ flex: 1, background: "repeating-linear-gradient(45deg, var(--edge) 0 4px, transparent 4px 8px)" }} />
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6, fontSize: 9, color: muted }}>
              {rows.filter((r) => r.earned > 0).map((r) => (
                <span key={r.key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 8, height: 8, background: BUCKET_COLORS[r.key], display: "inline-block" }} />
                  {r.key} {r.earned.toFixed(1)}
                </span>
              ))}
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span style={{ width: 8, height: 8, background: "var(--edge)", display: "inline-block" }} />
                not earned {(100 - earnedSum).toFixed(1)}
              </span>
            </div>

            {/* table */}
            <div style={{ fontSize: 10, fontFamily: "var(--font-hud)", marginTop: 10 }}>
              <Grid head>
                <span>bucket</span>
                <span style={{ textAlign: "right" }}>raw weight</span>
                <span style={{ textAlign: "right" }}>ceiling</span>
                <span style={{ textAlign: "right" }}>earned</span>
                <span style={{ textAlign: "right" }}>% of ceiling</span>
                <span style={{ textAlign: "right" }}>coverage</span>
              </Grid>
              {rows.map((r) => (
                <Grid key={r.key}>
                  <span style={{ color: r.present ? "var(--text-dim)" : muted }}>
                    <span style={{ width: 6, height: 6, background: BUCKET_COLORS[r.key], display: "inline-block", marginRight: 5, opacity: r.present ? 1 : 0.3 }} />
                    {r.key}
                  </span>
                  <Num>{r.weight}</Num>
                  <Num>{r.present ? r.ceiling.toFixed(1) : "—"}</Num>
                  <Num color={r.present ? "var(--text)" : muted}>{r.present ? r.earned.toFixed(1) : "—"}</Num>
                  <Num>{r.present && r.ceiling > 0 ? `${Math.round((r.earned / r.ceiling) * 100)}%` : "—"}</Num>
                  <Num color={r.present ? muted : r.partial ? "var(--warn)" : muted}>
                    {r.present ? `${Math.round(r.coverage * 100)}%` : r.partial ? `${Math.round(r.coverage * 100)}% · dropped` : "none"}
                  </Num>
                </Grid>
              ))}
              <Grid foot>
                <span>earned</span><span /><span />
                <Num color="var(--text)">{earnedSum.toFixed(1)}</Num><span /><span />
              </Grid>
              {penaltySum > 0 && (
                <Grid foot>
                  <span>penalties</span><span /><span />
                  <Num color="var(--danger)">−{penaltySum.toFixed(1)}</Num><span /><span />
                </Grid>
              )}
              {(regimeMult != null && regimeMult !== 1) && (
                <Grid foot>
                  <span>market regime</span><span /><span />
                  <Num color={regimeMult > 1 ? "var(--ok)" : "var(--warn)"}>×{regimeMult}</Num><span /><span />
                </Grid>
              )}
              {(fundMult != null && fundMult !== 1) && (
                <Grid foot>
                  <span>fundamentals</span><span /><span />
                  <Num color={fundMult > 1 ? "var(--ok)" : "var(--warn)"}>×{fundMult}</Num><span /><span />
                </Grid>
              )}
              <Grid foot>
                <span style={{ color: "var(--text)" }}>final score</span><span /><span />
                <Num color="var(--text)">{total}</Num><span /><span />
              </Grid>
            </div>
            <div style={{ fontSize: 9, color: muted, marginTop: 6, lineHeight: 1.5 }}>
              Raw weights sum to 100. A bucket with no usable inputs is removed and its weight is
              spread over the buckets that do have data, which is why the ceiling column differs
              from the raw weight. Earned points are then reduced by penalties and scaled by the
              regime and fundamentals multipliers to give the final score.
            </div>
          </HudPanel>

          {/* ---------- per-bucket breakdown ---------- */}
          {V4_BUCKETS.map((spec) => {
            const row = rows.find((r) => r.key === spec.key)!;
            const fr = factorPoints(factorsFor(spec.key, factors), row.earned);
            return (
              <HudPanel key={spec.key} title={`${spec.label} — ${row.present ? `${row.earned.toFixed(1)} / ${row.ceiling.toFixed(1)}` : "dropped"}`}>
                <div style={{ fontSize: 10, color: muted, marginBottom: 6 }}>{spec.blurb}</div>
                <div style={{ fontSize: 11, color: dim, lineHeight: 1.6, marginBottom: 8 }}>
                  {bucketSentence(row, fr)}
                </div>
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
                      <div key={f.spec.key} style={{ borderBottom: "1px solid var(--edge)", padding: "3px 0" }}>
                        <FGrid>
                          <span style={{ color: "var(--text-dim)" }}>{f.spec.label}</span>
                          <Num>{Math.round(f.spec.w * 100)}%</Num>
                          <Num color={toneColor(v.tone)}>{f.value == null ? "—" : f.value.toFixed(2)}</Num>
                          <Num color={row.present && f.value != null ? "var(--text)" : muted}>
                            {row.present && f.value != null ? f.points.toFixed(1) : "—"}
                          </Num>
                          <span style={{ color: toneColor(v.tone) }}>{v.word}</span>
                        </FGrid>
                        <div style={{ fontSize: 9, color: muted, lineHeight: 1.5, paddingRight: 4 }}>
                          {f.spec.what} <span style={{ color: "var(--text-dim)" }}>Full credit: {f.spec.full}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </HudPanel>
            );
          })}

          {/* ---------- penalties ---------- */}
          <HudPanel title="Penalties">
            {!penalties || Object.keys(penalties).length === 0 ? (
              <div style={{ fontSize: 11, color: muted }}>None applied — nothing was charged against this setup.</div>
            ) : (
              Object.entries(penalties).map(([k, v]) => {
                const meta = PENALTY_LABELS[k];
                return (
                  <div key={k} style={{ padding: "4px 0", borderBottom: "1px solid var(--edge)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                      <span style={{ color: "var(--text-dim)" }}>{meta?.label ?? k}</span>
                      <span style={{ color: "var(--danger)", fontVariantNumeric: "tabular-nums" }}>−{Number(v).toFixed(1)} pts</span>
                    </div>
                    <div style={{ fontSize: 9, color: muted, lineHeight: 1.5 }}>{meta?.why ?? "Charged by the scorer."}</div>
                  </div>
                );
              })
            )}
          </HudPanel>

          {/* ---------- fundamentals multiplier ---------- */}
          <HudPanel title={`Fundamentals multiplier — ×${fundMult ?? 1}`}>
            <div style={{ fontSize: 10, color: muted, lineHeight: 1.5, marginBottom: 6 }}>
              Fundamentals are deliberately not a bucket: good books must never manufacture a
              breakout score on their own. They scale the technical total between{" "}
              ×{FUNDAMENTAL_MULT_MIN} and ×{FUNDAMENTAL_MULT_MAX} — at worst a 10% haircut for a
              leveraged, shrinking business, at best a 5% nudge for a clean one. Unknown books
              leave the score untouched at ×1.
            </div>
            <div style={{ fontSize: 10, fontFamily: "var(--font-hud)" }}>
              {FUNDAMENTAL_FACTORS.map((s) => {
                const raw = factors?.[`fundamentals.${s.key}`];
                const val = raw == null ? null : Number(raw);
                const v = verdictOf(val);
                return (
                  <div key={s.key} style={{ padding: "3px 0", borderBottom: "1px solid var(--edge)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ color: "var(--text-dim)" }}>{s.label}</span>
                      <span style={{ color: muted }}>{Math.round(s.w * 100)}%</span>
                      <span style={{ color: toneColor(v.tone), fontVariantNumeric: "tabular-nums" }}>
                        {val == null ? "—" : val.toFixed(2)} · {v.word}
                      </span>
                    </div>
                    <div style={{ fontSize: 9, color: muted, lineHeight: 1.5 }}>
                      {s.what} <span style={{ color: "var(--text-dim)" }}>Full credit: {s.full}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </HudPanel>

          {/* ---------- missing data ---------- */}
          <HudPanel title="Missing data">
            {dropped.length === 0 ? (
              <div style={{ fontSize: 11, color: muted }}>
                Every bucket had enough inputs — no weight was redistributed, so the ceilings equal
                the raw weights.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 10, color: muted, lineHeight: 1.5, marginBottom: 6 }}>
                  A bucket needs at least {Math.round(BUCKET_MIN_COVERAGE * 100)}% of its own
                  sub-weight present before it counts. These fell short and their weight went to the
                  rest:
                </div>
                {dropped.map((r) => {
                  const fr = factorsFor(r.key, factors);
                  const missing = fr.filter((f) => f.value == null).map((f) => f.spec.label);
                  return (
                    <div key={r.key} style={{ padding: "4px 0", borderBottom: "1px solid var(--edge)", fontSize: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ color: "var(--text-dim)" }}>{r.label}</span>
                        <span style={{ color: "var(--warn)" }}>{r.weight} pts redistributed · {Math.round(r.coverage * 100)}% covered</span>
                      </div>
                      <div style={{ fontSize: 9, color: muted, lineHeight: 1.5 }}>
                        {missing.length ? `Missing inputs: ${missing.join(", ")}.` : "No sub-factor values recorded."}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
            {score.score_coverage != null && (
              <div style={{ fontSize: 9, color: muted, marginTop: 6 }}>
                Overall model coverage for this symbol: {Math.round(Number(score.score_coverage) * 100)}%.
                Below 45% the scorer refuses to emit a number at all.
              </div>
            )}
          </HudPanel>
        </>
      )}

      {/* ---------- criteria reference (always shown) ---------- */}
      <HudPanel title="Scoring criteria — the full model">
        <div style={{ fontSize: 10, color: muted, lineHeight: 1.6, marginBottom: 8 }}>
          Breakout Intelligence v4 is a coverage-aware 100-point model. Seven buckets carry fixed
          raw weights that sum to 100; each bucket is a weighted blend of 0–1 sub-factors. Missing
          sub-factors are renormalised away inside their bucket, missing buckets are renormalised
          away across the model, penalties are then subtracted in points, and the result is scaled
          by the market-regime and fundamentals multipliers. A chart with fewer than 120 sessions,
          or under 45% total coverage, returns no score rather than a misleadingly low one.
        </div>
        {V4_BUCKETS.map((b) => (
          <div key={b.key} style={{ padding: "6px 0", borderBottom: "1px solid var(--edge)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
              <span style={{ color: "var(--text)" }}>{b.label}</span>
              <span style={{ color: "var(--accent)" }}>{b.weight} / 100</span>
            </div>
            <div style={{ fontSize: 9, color: muted, marginBottom: 4 }}>{b.blurb}</div>
            {b.factors.map((f) => (
              <div key={f.key} style={{ fontSize: 9, color: muted, lineHeight: 1.5, paddingLeft: 8 }}>
                <span style={{ color: "var(--text-dim)" }}>{f.label} ({Math.round(f.w * 100)}% of bucket ≈ {(f.w * b.weight).toFixed(1)} pts)</span>{" "}
                — {f.what} <span style={{ color: "var(--text-dim)" }}>Full credit: {f.full}</span>
              </div>
            ))}
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <Btn size="sm" onClick={() => nav(`/market/score/${encodeURIComponent(sym)}`)}>Score history →</Btn>
          <Btn size="sm" onClick={() => nav(`/market/score/${encodeURIComponent(sym)}?tab=returns`)}>Forward returns →</Btn>
          <Btn size="sm" onClick={() => nav("/market/calibration")}>Model calibration lab →</Btn>
        </div>
      </HudPanel>
    </div>
  );
}

const GRID = "1.4fr 0.8fr 0.8fr 0.8fr 0.9fr 1fr";
const FGRID = "1.4fr 0.6fr 0.6fr 0.6fr 0.8fr";

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