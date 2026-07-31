// Breakout — daily breakout detection + multi-day forward tracking.
// Each stock that clears the breakout-score + liquidity gate becomes an
// "episode" the nightly pipeline follows forward: return since entry, peak,
// score trend, and a lifecycle status. This page is a *ranked list*, not a
// screener: the tracked set is already gated and tiny, so there is no filter
// rail — only a score threshold and a text search. See
// market-pipeline-aggregates' episode pass and market_breakout_tracker.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { HudPanel } from "@/components/hud/HudPanel";
import { EmptyState, inputStyle } from "@/components/hud/HudControls";
import { DataTable, PctCell, fmtNum } from "@/components/hud/DataTable";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { AddToWatchlistButton } from "@/components/market/AddToWatchlistButton";
import ErrorBoundary from "@/components/hud/ErrorBoundary";
import {
  useBreakoutTracker, useBreakoutSymbolMeta, metaKey,
  OPEN_STATUSES, type BreakoutEpisode, type BreakoutStatus, type BreakoutSymbolMeta,
} from "@/lib/market/breakoutRun";
import { deriveBreakoutStage, STAGE_TONE, type BreakoutStage } from "@/lib/market/breakoutStage";
import { SCORE_BAND_STRONG, SCORE_BAND_MODERATE, SCORE_BAND_WEAK } from "@/lib/market/scoreBands";
import { todayIstDateString } from "@/lib/market/liveSnapshot";
import { quoteKey } from "@/lib/market/pnl";
import { isFreshTick, useLiveTickStore, useTicksRevision } from "@/lib/market/liveTickStore";
import { subscribeSymbolsForTicks, useRelayAlive } from "@/lib/market/useRealtimeTicks";
import { ChevronDown, ChevronRight, LineChart, Info } from "lucide-react";

// ---- Status presentation ----
const STATUS_META: Record<BreakoutStatus, { label: string; color: string; rule: string }> = {
  active:   { label: "Active",   color: "var(--accent)",     rule: "Tracking forward — still within normal range since entry." },
  extended: { label: "Extended", color: "var(--ok)",         rule: "Up 8%+ from entry — the move has run; chase risk." },
  cooled:   { label: "Cooled",   color: "var(--warn)",       rule: "Score has stayed below the qualify threshold for 3 sessions." },
  failed:   { label: "Failed",   color: "var(--err)",        rule: "Down 6% from entry — the breakout broke down." },
  closed:   { label: "Closed",   color: "var(--text-muted)", rule: "Reached the 15-session tracking horizon." },
};

const TONE_COLOR: Record<string, string> = {
  ok: "var(--ok)", accent: "var(--accent)", warn: "var(--warn)",
  err: "var(--err)", neutral: "var(--text-muted)",
};

type View = "open" | "new" | "all";
const THRESHOLDS = [0, 60, 70, 80] as const;

interface Row extends BreakoutEpisode {
  meta: BreakoutSymbolMeta | null;
  liveLtp: number | null;
  isLive: boolean;
  liveReturnPct: number | null;
  company_name: string | null;
  rel_volume: number | null;
  stage: BreakoutStage;
  stageDetail: string;
}

function daysAgo(dateStr: string): number {
  const then = Date.parse(`${dateStr}T00:00:00Z`);
  const today = Date.parse(`${todayIstDateString()}T00:00:00Z`);
  if (!Number.isFinite(then) || !Number.isFinite(today)) return 0;
  return Math.max(0, Math.round((today - then) / 86_400_000));
}

function scoreBandColor(score: number | null): string {
  if (score == null) return "var(--text-muted)";
  if (score >= SCORE_BAND_STRONG) return "var(--ok)";
  if (score >= SCORE_BAND_MODERATE) return "var(--accent)";
  if (score >= SCORE_BAND_WEAK) return "var(--warn)";
  return "var(--err)";
}

// Tiny score-trend sparkline (0-100 scaled). Nulls are sessions the pipeline
// skipped: the line breaks there instead of pretending the days were adjacent.
function Sparkline({ points }: { points: (number | null)[] }) {
  const known = points.filter((p): p is number => p != null);
  if (known.length === 0) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const w = 64, h = 18, max = 100, min = 0;
  const y = (v: number) => h - ((v - min) / (max - min)) * h;
  if (known.length === 1) {
    return (
      <svg width={w} height={h} style={{ display: "block" }}>
        <circle cx={w / 2} cy={y(known[0])} r={2} fill="var(--accent)" />
      </svg>
    );
  }
  const step = w / Math.max(1, points.length - 1);
  let penDown = false;
  const d = points.map((p, i) => {
    if (p == null) { penDown = false; return ""; }
    const cmd = penDown ? "L" : "M";
    penDown = true;
    return `${cmd}${(i * step).toFixed(1)},${y(p).toFixed(1)}`;
  }).filter(Boolean).join(" ");
  const up = known[known.length - 1] >= known[0];
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <path d={d} fill="none" stroke={up ? "var(--ok)" : "var(--err)"} strokeWidth={1.5} />
    </svg>
  );
}

function BreakoutInner() {
  const nav = useNavigate();
  const [view, setView] = useState<View>("open");
  const [minScore, setMinScore] = useState<number>(0);
  const [search, setSearch] = useState("");
  const [legendOpen, setLegendOpen] = useState(false);

  // One query for everything — all three views are derived client-side.
  const { data: episodes = [], isFetching, error } = useBreakoutTracker(true);

  const symbolKeys = useMemo(
    () => episodes.map((e) => ({ symbol: e.symbol, exchange: e.exchange })),
    [episodes],
  );
  const { data: metaMap } = useBreakoutSymbolMeta(symbolKeys);

  const todayIst = todayIstDateString();

  const relayAlive = useRelayAlive();
  const _ticksRev = useTicksRevision();
  const liveTicks = useLiveTickStore.getState().ticks;
  void _ticksRev; // re-render on any tick flush; read fresh map above

  const tickKeys = useMemo(
    () => episodes.slice(0, 100).map((e) => quoteKey(e.exchange, e.symbol)).sort(),
    [episodes],
  );
  const tickKeysSig = tickKeys.join(",");
  useEffect(() => { subscribeSymbolsForTicks(tickKeys); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tickKeysSig]);

  const allRows = useMemo<Row[]>(() => episodes.map((e) => {
    const meta = metaMap?.get(metaKey(e.exchange, e.symbol)) ?? null;
    const tick = liveTicks[quoteKey(e.exchange, e.symbol)];
    const live = isFreshTick(tick);
    const liveLtp = live ? tick!.ltp : meta?.ltp ?? e.current_close;
    const entry = e.entry_close;
    const liveReturnPct = entry != null && entry > 0 && liveLtp != null
      ? ((liveLtp - entry) / entry) * 100
      : e.current_return_pct;
    const read = deriveBreakoutStage(meta ? ({
      close: meta.close ?? liveLtp ?? 0,
      ema20: meta.ema20,
      atr14: meta.atr14,
      bbSqueeze: meta.bb_squeeze ?? false,
      nearResistance: meta.near_resistance ?? false,
      // Real trigger geometry — with these nulled out the read could never
      // resolve to TRIGGERED, so every row showed COILED or LOADING.
      pivotLevel: meta.pivot_level ?? meta.resistance_level,
      rollingHigh20: meta.rolling_high_20 ?? null,
      rollingHigh55: meta.rolling_high_55 ?? null,
      breakoutFreshnessDays: meta.breakout_freshness_days ?? null,
      atrContracting: (meta.base_tightness ?? 1) < 0.04,
      baseTightness: meta.base_tightness ?? null,
      baseDurationDays: meta.base_duration_days ?? null,
    } as any) : null);
    return {
      ...e, meta, liveLtp, isLive: live, liveReturnPct,
      company_name: meta?.company_name ?? null,
      rel_volume: meta?.rel_volume ?? null,
      stage: read.stage, stageDetail: read.detail,
    };
  }), [episodes, metaMap, liveTicks]);

  const rows = useMemo(() => {
    const term = search.trim().toUpperCase();
    return allRows.filter((r) => {
      if (view === "open" && !OPEN_STATUSES.includes(r.status)) return false;
      // "New today" is literally today (IST) and includes same-day failures.
      if (view === "new" && r.first_detected_date !== todayIst) return false;
      if (minScore > 0 && (r.last_score ?? 0) < minScore) return false;
      if (term && !r.symbol.toUpperCase().includes(term)
        && !(r.company_name ?? "").toUpperCase().includes(term)) return false;
      return true;
    });
  }, [allRows, view, todayIst, minScore, search]);

  const columns = useMemo<ColumnDef<Row, any>[]>(() => [
    {
      id: "symbol", header: "Stock", accessorKey: "symbol",
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
            <span style={{ fontFamily: "var(--font-hud)", letterSpacing: "0.04em" }}>{r.symbol}</span>
            {r.company_name && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{r.company_name}</span>}
          </div>
        );
      },
    },
    {
      id: "score", header: "Score", accessorFn: (r) => r.last_score ?? -1, meta: { align: "right" },
      cell: ({ row }) => (
        <ScoreBadge
          score={row.original.last_score}
          components={row.original.meta?.score_components?.breakout ?? null}
          onClick={() => nav(`/market/score/${encodeURIComponent(row.original.symbol)}/explain?exchange=${encodeURIComponent(row.original.exchange)}`)}
        />
      ),
    },
    {
      // "Setup" not "Stage": Status already owns the episode lifecycle
      // vocabulary, and two columns both called a stage read as contradictory
      // when one says EXTENDED and the other says Active.
      id: "stage", header: "Setup", accessorKey: "stage",
      cell: ({ row }) => {
        const r = row.original;
        return (
          <span title={r.stageDetail} style={{ color: TONE_COLOR[STAGE_TONE[r.stage]], fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.1em" }}>
            {r.stage}
          </span>
        );
      },
    },
    {
      // A raw 82 means nothing without knowing how many names beat it that
      // session — the percentile is the comparable number.
      id: "rank", header: "Rank %ile", accessorFn: (r) => r.rank_pct ?? -1, meta: { align: "right" },
      cell: ({ row }) => {
        const v = row.original.rank_pct;
        return (
          <span title="Percentile of the score within that session's liquid universe"
                style={{ textAlign: "right", display: "block", color: v == null ? "var(--text-muted)" : undefined }}>
            {v == null ? "—" : `${v.toFixed(0)}`}
          </span>
        );
      },
    },
    {
      id: "detected", header: "Detected", accessorFn: (r) => r.first_detected_date,
      meta: { align: "right" },
      cell: ({ row }) => {
        const d = daysAgo(row.original.first_detected_date);
        return (
          <div style={{ textAlign: "right", lineHeight: 1.2 }}>
            <div>{row.original.first_detected_date}</div>
            <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{d === 0 ? "today" : `${d}d ago`}</div>
          </div>
        );
      },
    },
    {
      id: "days", header: "Days", accessorKey: "days_tracked", meta: { align: "right" },
      cell: ({ getValue }) => <span style={{ textAlign: "right", display: "block" }}>{getValue() as number}</span>,
    },
    {
      id: "entry_close", header: "Entry ₹", accessorKey: "entry_close", meta: { align: "right" },
      cell: ({ getValue }) => <span style={{ textAlign: "right", display: "block" }}>{fmtNum(getValue() as number)}</span>,
    },
    {
      id: "ltp", header: "LTP ₹", accessorFn: (r) => r.liveLtp, meta: { align: "right" },
      cell: ({ row }) => {
        const r = row.original;
        return (
          <span style={{ textAlign: "right", display: "block", color: r.isLive ? "var(--ok)" : undefined }}>
            {fmtNum(r.liveLtp)}{r.isLive ? " •" : ""}
          </span>
        );
      },
    },
    {
      id: "return", header: "Return %", accessorFn: (r) => r.liveReturnPct ?? -999, meta: { align: "right" },
      cell: ({ row }) => <PctCell value={row.original.liveReturnPct} />,
    },
    {
      id: "peak", header: "Peak %", accessorKey: "peak_return_pct", meta: { align: "right" },
      cell: ({ getValue }) => <PctCell value={getValue() as number} />,
    },
    {
      // Peak return alone flatters every episode. MAE is the heat you had to
      // sit through to get it.
      // Unknown MAE sorts to the bottom in both directions rather than
      // crowding the top of a "worst drawdown" sort with blanks.
      id: "mae", header: "MAE %", accessorFn: (r) => r.mae_pct ?? Number.NEGATIVE_INFINITY, meta: { align: "right" },
      cell: ({ row }) => <PctCell value={row.original.mae_pct} />,
    },
    {
      id: "relvol", header: "Rel Vol", accessorFn: (r) => r.rel_volume ?? -1, meta: { align: "right" },
      cell: ({ row }) => <span style={{ textAlign: "right", display: "block" }}>{fmtNum(row.original.rel_volume)}</span>,
    },
    {
      id: "trend", header: "Trend", accessorFn: (r) => r.score_trend.length, enableSorting: false, meta: { align: "right" },
      cell: ({ row }) => <div style={{ display: "flex", justifyContent: "flex-end" }}><Sparkline points={row.original.score_trend} /></div>,
    },
    {
      id: "health", header: "Health", accessorFn: (r) => r.followthrough_score ?? -1, meta: { align: "right" },
      cell: ({ row }) => {
        // On the detection session there is no follow-through yet — a health
        // badge there is a made-up number, so show nothing.
        if ((row.original.days_tracked ?? 1) <= 1) {
          return <span title="No follow-through yet — detected this session" style={{ textAlign: "right", display: "block", color: "var(--text-muted)" }}>—</span>;
        }
        return <ScoreBadge score={row.original.followthrough_score} />;
      },
    },
    {
      id: "status", header: "Status", accessorKey: "status",
      cell: ({ row }) => {
        const m = STATUS_META[row.original.status];
        return <span title={m.rule} style={{ color: m.color, fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase" }}>{m.label}</span>;
      },
    },
    {
      id: "action", header: "", enableSorting: false,
      cell: ({ row }) => (
        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }} onClick={(e) => e.stopPropagation()}>
          <button
            className="hud-btn" data-variant="ghost" data-size="sm"
            title="Score explanation"
            onClick={() => nav(`/market/score/${encodeURIComponent(row.original.symbol)}/explain?exchange=${encodeURIComponent(row.original.exchange)}`)}
          >
            <LineChart size={12} />
          </button>
          <AddToWatchlistButton symbol={row.original.symbol} exchange={row.original.exchange === "BSE" ? "BSE" : "NSE"} />
        </div>
      ),
    },
  ], [nav]);

  const loading = isFetching && episodes.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%", minHeight: 0 }}>
      {/* Views + narrowing controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "6px 8px", border: "1px solid var(--edge)", background: "rgba(53, 214, 237, 0.03)" }}>
        {(["open", "new", "all"] as View[]).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className="hud-btn" data-variant={view === v ? "primary" : "ghost"} data-size="sm">
            {v === "open" ? "Tracking" : v === "new" ? "New today" : "All + history"}
          </button>
        ))}

        <span style={{ width: 1, height: 16, background: "var(--edge)" }} />

        {THRESHOLDS.map((t) => (
          <button key={t} onClick={() => setMinScore(t)}
            className="hud-btn" data-variant={minScore === t ? "primary" : "ghost"} data-size="sm"
            style={{ color: minScore === t ? undefined : scoreBandColor(t || null) }}>
            {t === 0 ? "All scores" : `≥ ${t}`}
          </button>
        ))}

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search symbol / company"
          style={{ ...inputStyle, width: 180 }}
        />

        <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-hud)", fontSize: 10, color: relayAlive ? "var(--ok)" : "var(--text-muted)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: relayAlive ? "var(--ok)" : "var(--text-muted)" }} />
            {relayAlive ? "Live" : "EOD"}
          </span>
          <span style={{ fontFamily: "var(--font-hud)", fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
            {loading ? "loading…" : `${rows.length} tracked`}
          </span>
        </div>
      </div>

      {/* Model legend */}
      <div style={{ border: "1px solid var(--edge)" }}>
        <button
          onClick={() => setLegendOpen((o) => !o)}
          className="hud-btn" data-variant="ghost" data-size="sm"
          style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", justifyContent: "flex-start" }}
        >
          {legendOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Info size={12} /> How the breakout tracker works
        </button>
        {legendOpen && (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
            <div style={{ marginBottom: 6 }}>
              A stock enters the tracker when its <strong>breakout score reaches {SCORE_BAND_STRONG}</strong> and it clears the
              liquidity gate (enough turnover to be tradable). From then on the nightly pass follows it forward until it
              fails, extends or ages out.
            </div>
            {(Object.keys(STATUS_META) as BreakoutStatus[]).map((s) => (
              <div key={s} style={{ display: "flex", gap: 8, padding: "1px 0" }}>
                <span style={{ color: STATUS_META[s].color, minWidth: 70, fontFamily: "var(--font-hud)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  {STATUS_META[s].label}
                </span>
                <span>{STATUS_META[s].rule}</span>
              </div>
            ))}
            <div style={{ marginTop: 6, color: "var(--text-muted)" }}>
              <strong>Setup</strong> is today's technical picture, independent of the episode's status: COILED (volatility
              contracting) → ARMED (coiled at a pivot) → TRIGGERED (pivot cleared) → EXTENDED (stretched above EMA20).
              <strong> Status</strong> is where the episode stands in its lifecycle. Peak %, MAE % and Health are blank on
              the detection session — nothing has happened after entry yet.
            </div>
          </div>
        )}
      </div>

      <HudPanel title="Breakout Tracker" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {error ? (
          <EmptyState hint={String((error as Error).message)}>failed to load tracker</EmptyState>
        ) : (
          <DataTable<Row>
            columns={columns}
            data={rows}
            numbered
            initialSort={[{ id: "score", desc: true }, { id: "health", desc: true }]}
            emptyLabel={loading ? "loading…" : "no breakouts tracked yet"}
            emptyHint={loading ? undefined : "Runs after the nightly aggregates pass detects qualifying breakouts."}
            onRowClick={(r) => nav(`/market/analysis/${r.symbol}`)}
          />
        )}
      </HudPanel>
    </div>
  );
}

export default function Breakout() {
  return (
    <ErrorBoundary>
      <BreakoutInner />
    </ErrorBoundary>
  );
}