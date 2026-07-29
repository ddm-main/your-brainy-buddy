// Score-history feedback loop for one symbol: how the v4 breakout score has
// moved, and what actually happened to the price afterwards. Everything here
// is evidence, not opinion — if a snapshot hasn't matured (21 sessions), the
// cell says so instead of showing a zero.
import { Chip } from "@/components/hud/HudControls";
import { fmtPct } from "@/components/hud/DataTable";
import {
  MIN_BAND_SAMPLE,
  sortBands,
  useScoreBandStats,
  useScoreCalibration,
  useScoreHistory,
  type ScoreHistoryRow,
} from "@/lib/market/scoreHistory";

const MATURITY_SESSIONS = 21;

function retColor(v: number | null): string {
  if (v == null) return "var(--text-muted)";
  if (v > 0) return "var(--ok)";
  if (v < 0) return "var(--danger)";
  return "var(--text-dim)";
}

function Sparkline({ rows }: { rows: ScoreHistoryRow[] }) {
  const pts = rows.filter((r) => r.score != null);
  if (pts.length < 2) return null;
  const W = 260, H = 44, pad = 2;
  const xs = (i: number) => pad + (i * (W - pad * 2)) / (pts.length - 1);
  const scoreY = (v: number) => H - pad - (v / 100) * (H - pad * 2);
  const closes = pts.map((p) => p.close).filter((c): c is number => c != null);
  const cMin = closes.length ? Math.min(...closes) : 0;
  const cMax = closes.length ? Math.max(...closes) : 1;
  const closeY = (v: number) => (cMax === cMin ? H / 2 : H - pad - ((v - cMin) / (cMax - cMin)) * (H - pad * 2));
  const scorePath = pts.map((p, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${scoreY(p.score!).toFixed(1)}`).join(" ");
  const closePath = pts
    .map((p, i) => (p.close == null ? null : `${i ? "L" : "M"}${xs(i).toFixed(1)},${closeY(p.close).toFixed(1)}`))
    .filter(Boolean)
    .join(" ")
    .replace(/^L/, "M");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block", marginTop: 4 }}>
      {[70, 55, 40].map((lvl) => (
        <line key={lvl} x1={0} x2={W} y1={scoreY(lvl)} y2={scoreY(lvl)} stroke="var(--edge)" strokeWidth={0.5} strokeDasharray="2 3" />
      ))}
      {closePath && <path d={closePath} fill="none" stroke="var(--text-muted)" strokeWidth={1} opacity={0.6} />}
      <path d={scorePath} fill="none" stroke="var(--accent)" strokeWidth={1.4} />
    </svg>
  );
}

export function ScoreHistoryPanel({ symbol, exchange }: { symbol: string; exchange: string }) {
  const { data: history = [], isLoading } = useScoreHistory(symbol, exchange);
  const { data: bands = [] } = useScoreBandStats();
  const { data: calibration = [] } = useScoreCalibration();

  const matured = history.filter((r) => r.fwd_ret_5d != null || r.fwd_ret_21d != null).slice(-6).reverse();
  const model = calibration.find((c) => c.r2 != null) ?? calibration[0] ?? null;

  const label = (t: string) => (
    <div className="hud-label" style={{ fontSize: 9, letterSpacing: "0.14em", color: "var(--accent-soft)", margin: "10px 0 4px" }}>
      {t}
    </div>
  );

  return (
    <>
      {label("Score History")}
      {isLoading ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>loading…</div>
      ) : history.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          No snapshots yet. The aggregates pass writes one score row per session; forward returns
          mature after {MATURITY_SESSIONS} sessions.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-muted)" }}>
            <span>{history.length} session{history.length === 1 ? "" : "s"}</span>
            <span>score · close</span>
          </div>
          <Sparkline rows={history} />
        </>
      )}

      {label("Forward Returns (this symbol)")}
      {matured.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
          collecting — {history.length} of {MATURITY_SESSIONS} sessions before the first snapshot matures
        </div>
      ) : (
        <div style={{ fontSize: 10, fontFamily: "var(--font-hud)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.3fr 0.7fr repeat(3, 1fr)", gap: 4, color: "var(--text-muted)", paddingBottom: 2 }}>
            <span>date</span><span>score</span><span style={{ textAlign: "right" }}>+5d</span>
            <span style={{ textAlign: "right" }}>+10d</span><span style={{ textAlign: "right" }}>+21d</span>
          </div>
          {matured.map((r) => (
            <div key={r.trade_date} style={{ display: "grid", gridTemplateColumns: "1.3fr 0.7fr repeat(3, 1fr)", gap: 4, padding: "1px 0" }}>
              <span style={{ color: "var(--text-dim)" }}>
                {new Date(r.trade_date).toLocaleDateString([], { day: "2-digit", month: "short" })}
              </span>
              <span style={{ color: "var(--text)" }}>{r.score ?? "—"}</span>
              {[r.fwd_ret_5d, r.fwd_ret_10d, r.fwd_ret_21d].map((v, i) => (
                <span key={i} style={{ textAlign: "right", color: retColor(v), fontVariantNumeric: "tabular-nums" }}>
                  {v == null ? "…" : fmtPct(v, 1, false)}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      {label("Model Calibration (universe)")}
      {bands.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
          No matured snapshots across the universe yet — hit rates appear once the loop has {MATURITY_SESSIONS}+ sessions of history.
        </div>
      ) : (
        <div style={{ fontSize: 10, fontFamily: "var(--font-hud)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr 1fr 1fr", gap: 4, color: "var(--text-muted)", paddingBottom: 2 }}>
            <span>band</span><span style={{ textAlign: "right" }}>n</span>
            <span style={{ textAlign: "right" }}>hit 21d</span><span style={{ textAlign: "right" }}>avg 21d</span>
          </div>
          {sortBands(bands).map((b) => {
            const thin = b.sample_21d < MIN_BAND_SAMPLE;
            return (
              <div key={b.band} style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr 1fr 1fr", gap: 4, padding: "1px 0" }}>
                <span style={{ color: "var(--text-dim)" }}>{b.band}</span>
                <span style={{ textAlign: "right", color: "var(--text-muted)" }}>{b.sample_21d}</span>
                {thin ? (
                  <span style={{ gridColumn: "3 / span 2", textAlign: "right", color: "var(--warn)" }}>insufficient sample</span>
                ) : (
                  <>
                    <span style={{ textAlign: "right", color: "var(--text)" }}>{b.hit_rate_21d != null ? `${b.hit_rate_21d}%` : "—"}</span>
                    <span style={{ textAlign: "right", color: retColor(b.avg_ret_21d) }}>
                      {b.avg_ret_21d == null ? "—" : fmtPct(b.avg_ret_21d, 1, false)}
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {model && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
          {model.r2 != null && <Chip tone={model.r2 >= 0.05 ? "ok" : "warn"}>r² {model.r2.toFixed(3)}</Chip>}
          {model.sample_n != null && <Chip>n {model.sample_n}</Chip>}
          <Chip>fit {new Date(model.computed_at).toLocaleDateString([], { day: "2-digit", month: "short" })}</Chip>
        </div>
      )}
    </>
  );
}

export default ScoreHistoryPanel;