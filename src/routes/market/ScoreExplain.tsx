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
import { CalibrationDialog } from "@/components/market/CalibrationDialog";

import { useStockScores } from "@/lib/market/hooks";
import { useScoreBandStats, useScoreHistory, MIN_BAND_SAMPLE } from "@/lib/market/scoreHistory";

import {
  V4_BUCKETS, FUNDAMENTAL_FACTORS, FUNDAMENTAL_MULT_MIN, FUNDAMENTAL_MULT_MAX,
  SENTIMENT_FACTORS, SENTIMENT_MULT_MIN, SENTIMENT_MULT_MAX,

  PENALTY_LABELS, BUCKET_COLORS, buildBucketRows, factorsFor, factorPoints,
  bucketSentence, verdictOf, bandOf, BUCKET_MIN_COVERAGE, TIMEFRAME_NOTE,
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
  const [calibOpen, setCalibOpen] = useState(false);


  const { data: scores = [], isLoading } = useStockScores({ symbol: sym, exchange, limit: 1 });
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
  const regimeMult = factors?.regime_mult ?? null;
  const fundMult = factors?.fundamental_mult ?? null;
  const sentMult = factors?.sentiment_mult ?? null;
  // Penalties are stored in points of a 100-point score; on a thin row the
  // scorer charges them proportionally to the ceiling it actually used.
  const penaltyScale = Number(factors?.penalty_scale ?? 1) || 1;
  const penaltySum = penaltyEntries.reduce(
    (s, [k, v]) => s + Number(v || 0) * (k === "event_blackout" ? 1 : penaltyScale), 0);



  const dropped = rows.filter((r) => !r.present);

  // rank_pct is a percentile: 100 = best in universe. "top 0%" read as a bug.
  const rankPct = score?.breakout_v4_rank_pct == null ? null : Number(score.breakout_v4_rank_pct);
  const topPct = rankPct == null ? null : Math.max(0.1, 100 - rankPct);

  // Points and coverage say how the number was built; only the band's matured
  // history says whether the number has ever been worth acting on.
  const { data: bandStats = [] } = useScoreBandStats("all");
  const bandLabel = String(score?.breakout_band ?? (total == null ? "" : bandOf(total).label)).toUpperCase();
  const bandStat = bandStats.find((b) => (b.band ?? "").toUpperCase() === bandLabel) ?? null;

  // The band's aggregate is other stocks. This symbol's own matured snapshots
  // are the only evidence about *this* name, so they belong on the same screen.
  const { data: history = [] } = useScoreHistory(sym, exchange, 120);
  const ownMatured = useMemo(
    () => history.filter((h) => h.fwd_ret_21d != null).slice(-8).reverse(),
    [history],
  );
  const ownAvgRel = useMemo(() => {
    const vals = ownMatured.map((h) => h.fwd_rel_21d).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }, [ownMatured]);
  const ownHit = useMemo(() => {
    const vals = ownMatured.map((h) => h.fwd_ret_21d).filter((v): v is number => v != null);
    return vals.length ? (100 * vals.filter((v) => v > 0).length) / vals.length : null;
  }, [ownMatured]);



  return (
    <div style={{ display: "grid", gap: 6, padding: 8 }}>
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
        <Btn size="sm" onClick={() => setCalibOpen(true)}>Calibration</Btn>
        <CalibrationDialog open={calibOpen} onOpenChange={setCalibOpen} />

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
          <Cols>
          {/* ---------- does this band actually work? ---------- */}
          <HudPanel title="Track record of this band">
            {!bandStat ? (
              <div style={{ fontSize: 11, color: muted }}>
                no matured history for the {bandLabel} band yet — this score is unproven.
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 10 }}>
                <Chip tone={bandStat.sample_21d >= MIN_BAND_SAMPLE ? "neutral" : "warn"}>
                  {bandStat.sample_21d} matured rows
                </Chip>
                <Chip>hit 21d {bandStat.hit_rate_21d == null ? "—" : `${bandStat.hit_rate_21d}%`}</Chip>
                <Chip>
                  avg rel 21d {bandStat.avg_rel_21d == null ? "—" : bandStat.avg_rel_21d.toFixed(2)}
                </Chip>
                {bandStat.sample_21d < MIN_BAND_SAMPLE && (
                  <Chip tone="warn">under {MIN_BAND_SAMPLE} matured rows — unproven, treat as noise</Chip>
                )}
                {bandStat.avg_rel_21d != null && bandStat.avg_rel_21d < 0 && (
                  <Chip tone="err">this band has under-performed NIFTY on matured history</Chip>
                )}
                <div style={{ flex: 1 }} />
                <Btn size="sm" onClick={() => setCalibOpen(true)}>Open Calibration Lab</Btn>
              </div>
            )}
          </HudPanel>

          {/* ---------- what this symbol's own scores did next ---------- */}
          <HudPanel title="This symbol's matured snapshots">
            {ownMatured.length === 0 ? (
              <div style={{ fontSize: 11, color: muted }}>
                no snapshot of {sym} has matured 21 sessions yet — nothing measured on this name itself.
              </div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 10, marginBottom: 6 }}>
                  <Chip>{ownMatured.length} matured</Chip>
                  <Chip tone={ownHit != null && ownHit >= 50 ? "ok" : "warn"}>
                    hit 21d {ownHit == null ? "—" : `${Math.round(ownHit)}%`}
                  </Chip>
                  <Chip tone={ownAvgRel == null ? "neutral" : ownAvgRel >= 0 ? "ok" : "err"}>
                    avg rel 21d {ownAvgRel == null ? "—" : ownAvgRel.toFixed(2)}
                  </Chip>
                </div>
                <div style={{ fontSize: 10, fontFamily: "var(--font-hud)" }}>
                  <Grid head>
                    <span>date</span>
                    <span style={{ textAlign: "right" }}>score</span>
                    <span style={{ textAlign: "right" }}>+21d</span>
                    <span style={{ textAlign: "right" }}>rel 21d</span>
                  </Grid>
                  {ownMatured.map((h) => (
                    <Grid key={h.trade_date}>
                      <span style={{ color: dim }}>
                        {h.trade_date}
                        {h.context_neutral && <span title="replayed with neutral market context" style={{ color: muted }}> ·r</span>}
                      </span>
                      <Num color="var(--text)">{h.score ?? "—"}</Num>
                      <Num color={h.fwd_ret_21d == null ? muted : h.fwd_ret_21d > 0 ? "var(--ok)" : "var(--danger)"}>
                        {h.fwd_ret_21d == null ? "—" : h.fwd_ret_21d.toFixed(2)}
                      </Num>
                      <Num color={h.fwd_rel_21d == null ? muted : h.fwd_rel_21d > 0 ? "var(--ok)" : "var(--danger)"}>
                        {h.fwd_rel_21d == null ? "—" : h.fwd_rel_21d.toFixed(2)}
                      </Num>
                    </Grid>
                  ))}
                </div>
                <div style={{ fontSize: 9, color: muted, marginTop: 5 }}>
                  Newest first, up to 8 snapshots. Rows marked ·r were replayed without live market context.
                </div>
              </>
            )}
          </HudPanel>
          </Cols>

          <Cols>
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
                        title={r.present ? undefined : `not scored — only ${Math.round(r.coverage * 100)}% of its sub-factors had data, weight partly redistributed`}>
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
              Raw weights sum to 100; a bucket that could not be scored has its weight partly spread over the rest (shown as 20→22.4).
            </div>
          </HudPanel>

          {/* ---------- buckets, collapsed ---------- */}
          <HudPanel title="Buckets">
            <div style={{ fontSize: 9, color: muted, marginBottom: 4 }}>{TIMEFRAME_NOTE}</div>
            {V4_BUCKETS.map((spec) => {
              const row = rows.find((r) => r.key === spec.key)!;
              const fr = factorPoints(factorsFor(spec.key, factors), row.earned);
              return <BucketRowView key={spec.key} spec={spec} row={row} fr={fr} />;
            })}
          </HudPanel>
          </Cols>


          {/* ---------- penalties and multipliers, separated ---------- */}
          <Cols>
          <HudPanel title="Penalties">
            <div style={{ fontSize: 9, color: muted, marginBottom: 3 }}>
              Point deductions, subtracted after the multipliers.
              {penaltyScale < 1 && ` Scaled ×${penaltyScale.toFixed(2)} — this row was scored against a ${Math.round(penaltyScale * 100)}-point ceiling, so a stated penalty costs the same share of what it could actually have earned.`}
            </div>
            {penaltyEntries.length === 0 ? (
              <div style={{ fontSize: 10, color: muted }}>none applied</div>
            ) : penaltyEntries.map(([k, v]) => {
              const meta = PENALTY_LABELS[k];
              const charged = k === "event_blackout" ? Number(v) : Number(v) * penaltyScale;
              return (
                <div key={k} title={meta?.why ?? "charged by the scorer"}
                     style={{ display: "flex", justifyContent: "space-between", fontSize: 10, padding: "1px 0" }}>
                  <span style={{ color: dim }}>{meta?.label ?? k}</span>
                  <span style={{ color: "var(--danger)", fontVariantNumeric: "tabular-nums" }}>−{charged.toFixed(1)}</span>
                </div>
              );

            })}
            {score.score_coverage != null && (
              <div style={{ fontSize: 9, color: muted, marginTop: 6 }}>
                Model coverage {Math.round(Number(score.score_coverage) * 100)}% (below 45% no score is emitted).
                {dropped.length > 0 && ` Not scored this session: ${dropped.map((r) => r.label).join(", ")}.`}
              </div>
            )}
          </HudPanel>

          <HudPanel title="Multipliers">
            <Sub>Regime ×{regimeMult ?? 1}</Sub>
            <div style={{ fontSize: 9, color: muted, marginBottom: 3 }}>
              The tape the trade sits in: ×1.05 bullish, ×1 neutral, ×0.85 bearish.
            </div>

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

            <Sub>Sentiment ×{sentMult ?? 1}</Sub>
            <div style={{ fontSize: 9, color: muted, marginBottom: 3 }}>
              Also a multiplier, deliberately narrow (×{SENTIMENT_MULT_MIN}–×{SENTIMENT_MULT_MAX}): news and AI coverage exist for a small minority of names, so having coverage must not be an edge by itself. No news, no AI verdict → ×1.
            </div>
            <div style={{ fontSize: 10, fontFamily: "var(--font-hud)" }}>
              {SENTIMENT_FACTORS.map((s) => {
                const raw = factors?.[`sentiment.${s.key}`];
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
          </HudPanel>
          </Cols>

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
          {row.present ? `${row.earned.toFixed(1)} / ${row.ceiling.toFixed(1)}` : "not scored"}
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
                <div key={f.spec.key} title={`${f.spec.tf ? `Timeframe: ${f.spec.tf}. ` : ""}${f.spec.what} Full credit: ${f.spec.full}`}>
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
          Breakout Intelligence v4 is a coverage-aware 100-point swing model: five buckets of 0–1 sub-factors,
          raw weights summing to 100. Missing sub-factors renormalise inside their bucket, buckets under{" "}
          {Math.round(BUCKET_MIN_COVERAGE * 100)}% coverage are dropped and their weight partly redistributed
          (capped at 85% coverage, so a thin name is scored against a lower ceiling instead of being scaled up),
          penalties are subtracted in points, then regime and fundamentals multipliers scale the result.
          Under 120 sessions of history or 45% coverage it returns no score at all.
          Chart patterns no longer contribute: the bucket reported full coverage on every row while paying
          about a tenth of its weight, so its points went to levels, volume, EMA structure and relative strength.
          {" "}{TIMEFRAME_NOTE} Hover any bucket or sub-factor for its timeframe, what it measures and what full credit looks like.
        </div>
      )}
    </div>
  );
}

const GRID = "1.6fr 0.8fr 0.7fr 0.6fr";
const FGRID = "1.4fr 0.6fr 0.6fr 0.6fr 0.8fr";

/** Two panels per row on wide screens, stacked when narrow. */
function Cols({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 6, alignItems: "start" }}>
      {children}
    </div>
  );
}

function Sub({ children }: { children: React.ReactNode }) {
  return (
    <div className="hud-label" style={{ fontSize: 9, letterSpacing: "0.14em", color: "var(--accent-soft)", margin: "6px 0 2px" }}>
      {children}
    </div>
  );
}

function Grid({ children, head, foot }: { children: React.ReactNode; head?: boolean; foot?: boolean }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: GRID, gap: 6, padding: "1px 0",
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
