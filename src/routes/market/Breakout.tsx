// Breakout — daily breakout detection + multi-day forward tracking.
// Each stock that clears the breakout-score + liquidity gate becomes an
// "episode" that the nightly pipeline follows forward: return since entry,
// peak, score trend, and a lifecycle status (active/extended/cooled/failed/
// closed). This page lists open episodes, overlays live LTP during market
// hours, and reuses the Screener's filter catalog so the tracked set can be
// narrowed the same way. See market-pipeline-aggregates' episode pass and
// market_breakout_tracker / market_breakout_snapshots.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, EmptyState, inputStyle } from "@/components/hud/HudControls";
import { DataTable, PctCell, fmtNum } from "@/components/hud/DataTable";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { AddToWatchlistButton } from "@/components/market/AddToWatchlistButton";
import ErrorBoundary from "@/components/hud/ErrorBoundary";
import { useBreakoutTracker, type BreakoutEpisode, type BreakoutStatus } from "@/lib/market/breakoutRun";
import { useScreenerData, useScreenerSectors, type ScreenerRow } from "@/lib/market/screenerRun";
import { todayIstDateString } from "@/lib/market/liveSnapshot";
import { quoteKey } from "@/lib/market/pnl";
import { isFreshTick, useLiveTickStore } from "@/lib/market/liveTickStore";
import { subscribeSymbolsForTicks, useRelayAlive } from "@/lib/market/useRealtimeTicks";
import {
  FILTERS, FILTER_BY_ID, filterMatches, latestTradeDateOf,
  type ActiveFilter, type FilterDef,
} from "@/lib/market/screenerCatalog";
import { AlertTriangle, RotateCcw, X } from "lucide-react";

// ---- Status presentation ----
const STATUS_META: Record<BreakoutStatus, { label: string; color: string }> = {
  active:   { label: "Active",   color: "var(--accent)" },
  extended: { label: "Extended", color: "var(--ok)" },
  cooled:   { label: "Cooled",   color: "var(--warn)" },
  failed:   { label: "Failed",   color: "var(--err)" },
  closed:   { label: "Closed",   color: "var(--text-muted)" },
};

type View = "open" | "new" | "all";

// Merged row: the tracker episode + its live screener row (for filters/LTP).
interface Row extends BreakoutEpisode {
  sr: ScreenerRow | null;
  liveLtp: number | null;
  isLive: boolean;
  liveReturnPct: number | null;
  company_name: string | null;
}

function daysAgo(dateStr: string): number {
  const then = Date.parse(`${dateStr}T00:00:00Z`);
  const today = Date.parse(`${todayIstDateString()}T00:00:00Z`);
  if (!Number.isFinite(then) || !Number.isFinite(today)) return 0;
  return Math.max(0, Math.round((today - then) / 86_400_000));
}

// Tiny score-trend sparkline (0-100 scaled).
function Sparkline({ points }: { points: number[] }) {
  if (points.length === 0) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const w = 64, h = 18, max = 100, min = 0;
  const y = (v: number) => h - ((v - min) / (max - min)) * h;
  if (points.length === 1) {
    return (
      <svg width={w} height={h} style={{ display: "block" }}>
        <circle cx={w / 2} cy={y(points[0])} r={2} fill="var(--accent)" />
      </svg>
    );
  }
  const step = w / (points.length - 1);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const up = points[points.length - 1] >= points[0];
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <path d={d} fill="none" stroke={up ? "var(--ok)" : "var(--err)"} strokeWidth={1.5} />
    </svg>
  );
}

// Carry filters over from the Screener page — same localStorage key it
// persists to, so switching sub-tabs inherits the current filter set.
const SCREENER_STATE_KEY = "screener.state.v2";
function readScreenerActive(): ActiveFilter[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SCREENER_STATE_KEY) ?? "null");
    return Array.isArray(raw?.active) ? (raw.active as ActiveFilter[]) : [];
  } catch { return []; }
}

function BreakoutInner() {
  const nav = useNavigate();
  const [view, setView] = useState<View>("open");
  const [active, setActive] = useState<ActiveFilter[]>(() => readScreenerActive());

  const { data: episodes = [], isFetching: epFetching, error } = useBreakoutTracker(view === "all");
  const { data: srRows = [], isFetching: srFetching } = useScreenerData("all");
  const sectorList = useScreenerSectors(srRows);
  const latestTradeDate = useMemo(() => latestTradeDateOf(srRows), [srRows]);

  const srBySymbol = useMemo(() => {
    const m = new Map<string, ScreenerRow>();
    for (const r of srRows) if (r.exchange === "NSE") m.set(r.symbol, r);
    return m;
  }, [srRows]);

  // "New today" should mean *today* (IST) — not just the max detection date
  // across whatever episodes we're holding, which on a weekend would silently
  // pin the label to Friday's list.
  const todayIst = todayIstDateString();
  const latestDetected = useMemo(
    () => episodes.reduce<string | null>((a, e) => (a == null || e.first_detected_date > a ? e.first_detected_date : a), null),
    [episodes],
  );
  const newDayLabel = latestDetected && latestDetected < todayIst ? latestDetected : todayIst;

  const relayAlive = useRelayAlive();
  const liveTicks = useLiveTickStore((s) => s.ticks);

  // Subscribe visible symbols to the live-tick relay. Key the effect on the
  // sorted symbol list (not the episodes array identity) so react-query
  // refetches don't churn the relay every time the same set of symbols
  // arrives as a new array reference.
  const tickKeys = useMemo(
    () => episodes.slice(0, 100).map((e) => quoteKey(e.exchange, e.symbol)).sort(),
    [episodes],
  );
  const tickKeysSig = tickKeys.join(",");
  useEffect(() => { subscribeSymbolsForTicks(tickKeys); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tickKeysSig]);

  const rows = useMemo<Row[]>(() => {
    return episodes
      .filter((e) => (view === "new" ? e.first_detected_date === newDayLabel : true))
      .map((e) => {
        const sr = srBySymbol.get(e.symbol) ?? null;
        const tick = liveTicks[quoteKey(e.exchange, e.symbol)];
        const live = isFreshTick(tick);
        const liveLtp = live ? tick!.ltp : sr?.ltp ?? e.current_close;
        const entry = e.entry_close;
        const liveReturnPct = entry != null && entry > 0 && liveLtp != null
          ? ((liveLtp - entry) / entry) * 100
          : e.current_return_pct;
        return {
          ...e, sr, liveLtp, isLive: live, liveReturnPct,
          company_name: sr?.company_name ?? null,
        };
      })
      // Reuse the Screener filter catalog. When the live screener row is
      // missing (symbol dropped from the current universe), fall back to a
      // synthetic row built from the episode's own fields so tracked
      // breakouts don't silently disappear the moment any filter is added.
      .filter((r) => {
        const target = r.sr ?? ({
          symbol: r.symbol, exchange: r.exchange,
          sector: r.sector, industry: null,
          market_cap: r.market_cap, close: r.current_close, ltp: r.current_close,
          breakout_score: r.last_score, trade_date: r.last_evaluated_date,
        } as any);
        return active.every((af) => filterMatches(target, af, latestTradeDate));
      });
  }, [episodes, view, newDayLabel, srBySymbol, liveTicks, active, latestTradeDate]);

  // ---- Data staleness banner (same logic as Screener) ----
  const isDataStale = useMemo(() => {
    if (!latestTradeDate) return false;
    const latest = Date.parse(`${latestTradeDate}T00:00:00Z`);
    const today = Date.parse(`${todayIstDateString()}T00:00:00Z`);
    if (!Number.isFinite(latest) || !Number.isFinite(today)) return false;
    const days = Math.round((today - latest) / 86_400_000);
    const dow = new Date(Date.now() + 5.5 * 3600_000).getUTCDay();
    return days > (dow === 1 ? 3 : 1);
  }, [latestTradeDate]);

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
      id: "score", header: "Score", accessorFn: (r) => r.last_score ?? -1, meta: { align: "right" },
      cell: ({ row }) => (
        <ScoreBadge score={row.original.last_score} components={row.original.sr?.score_components?.breakout ?? null} />
      ),
    },
    {
      id: "trend", header: "Trend", accessorFn: (r) => r.score_trend.length, enableSorting: false, meta: { align: "right" },
      cell: ({ row }) => <div style={{ display: "flex", justifyContent: "flex-end" }}><Sparkline points={row.original.score_trend} /></div>,
    },
    {
      id: "health", header: "Health", accessorFn: (r) => r.followthrough_score ?? -1, meta: { align: "right" },
      cell: ({ row }) => <ScoreBadge score={row.original.followthrough_score} />,
    },
    {
      id: "status", header: "Status", accessorKey: "status",
      cell: ({ row }) => {
        const m = STATUS_META[row.original.status];
        return <span style={{ color: m.color, fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase" }}>{m.label}</span>;
      },
    },
    {
      id: "action", header: "", enableSorting: false,
      cell: ({ row }) => <AddToWatchlistButton symbol={row.original.symbol} exchange="NSE" />,
    },
  ], []);

  const loading = (epFetching && episodes.length === 0) || (srFetching && srRows.length === 0);

  return (
    <div style={{ display: "flex", gap: 12, height: "100%", minHeight: 0 }}>
      {/* ---- Left rail: filters ---- */}
      <div style={{ width: 260, flexShrink: 0, display: "flex", flexDirection: "column", gap: 8, overflow: "auto" }}>
        <FilterRail active={active} setActive={setActive} sectorList={sectorList} />
      </div>

      {/* ---- Right pane ---- */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {/* View chips + count */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "6px 8px", border: "1px solid var(--edge)", background: "rgba(53, 214, 237, 0.03)" }}>
          {(["open", "new", "all"] as View[]).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className="hud-btn" data-variant={view === v ? "primary" : "ghost"} data-size="sm">
              {v === "open" ? "Tracking" : v === "new" ? "New today" : "All + history"}
            </button>
          ))}
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

        {isDataStale && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", border: "1px solid var(--err)", color: "var(--err)", fontSize: 12 }}>
            <AlertTriangle size={13} /> Data is behind — EOD pipeline hasn't caught up. Tracked returns use the last settled close until it does.
          </div>
        )}

        <HudPanel title="Breakout Tracker" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {error ? (
            <EmptyState hint={String((error as Error).message)}>failed to load tracker</EmptyState>
          ) : (
            <DataTable<Row>
              columns={columns}
              data={rows}
              numbered
              initialSort={[{ id: "health", desc: true }]}
              emptyLabel={loading ? "loading…" : "no breakouts tracked yet"}
              emptyHint={loading ? undefined : "Runs after the nightly aggregates pass detects qualifying breakouts."}
              onRowClick={(r) => nav(`/market/analysis/${r.symbol}`)}
            />
          )}
        </HudPanel>
      </div>
    </div>
  );
}

// ---- Compact filter rail: reuses the Screener filter catalog + filterMatches ----
function FilterRail({ active, setActive, sectorList }: {
  active: ActiveFilter[];
  setActive: React.Dispatch<React.SetStateAction<ActiveFilter[]>>;
  sectorList: string[];
}) {
  const [pick, setPick] = useState("");
  const addFilter = (id: string) => {
    if (!id || active.some((a) => a.id === id)) return;
    setActive((prev) => [...prev, { id }]);
    setPick("");
  };
  const update = (id: string, patch: Partial<ActiveFilter>) =>
    setActive((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const remove = (id: string) => setActive((prev) => prev.filter((a) => a.id !== id));

  return (
    <>
      <HudPanel title="Filters">
        <div style={{ display: "flex", gap: 6, alignItems: "center", padding: 6 }}>
          <select value={pick} onChange={(e) => addFilter(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
            <option value="">+ add filter…</option>
            {FILTERS.filter((f) => !active.some((a) => a.id === f.id)).map((f) => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>
          {active.length > 0 && (
            <Btn variant="ghost" size="sm" onClick={() => setActive([])} title="Clear all"><RotateCcw size={12} /></Btn>
          )}
        </div>
      </HudPanel>

      {active.length === 0 ? (
        <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-muted)" }}>
          No filters — showing every tracked breakout. Add filters to narrow (e.g. Sector, Market Cap, RSI).
        </div>
      ) : (
        active.map((af) => {
          const def: FilterDef | undefined = FILTER_BY_ID[af.id];
          if (!def) return null;
          const options = def.id === "sector" ? sectorList : def.options ?? [];
          return (
            <HudPanel key={af.id} title={def.label}>
              <div style={{ padding: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <Btn variant="ghost" size="sm" onClick={() => remove(af.id)} title="Remove"><X size={12} /></Btn>
                </div>
                {def.kind === "number" && (
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="number" placeholder="min" style={{ ...inputStyle, width: "50%" }}
                      value={af.min ?? ""} onChange={(e) => update(af.id, { min: e.target.value === "" ? "" : Number(e.target.value) })} />
                    <input type="number" placeholder="max" style={{ ...inputStyle, width: "50%" }}
                      value={af.max ?? ""} onChange={(e) => update(af.id, { max: e.target.value === "" ? "" : Number(e.target.value) })} />
                  </div>
                )}
                {def.kind === "boolean" && (
                  <div style={{ display: "flex", gap: 6 }}>
                    {[["Yes", true], ["No", false]].map(([lbl, val]) => (
                      <button key={String(val)} className="hud-btn" data-size="sm"
                        data-variant={af.bool === val ? "primary" : "ghost"}
                        onClick={() => update(af.id, { bool: val as boolean })}>{lbl as string}</button>
                    ))}
                  </div>
                )}
                {def.kind === "enum" && (
                  <div style={{ maxHeight: 160, overflow: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
                    {options.map((opt) => {
                      const on = (af.values ?? []).includes(opt);
                      return (
                        <label key={opt} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, cursor: "pointer" }}>
                          <input type="checkbox" checked={on}
                            onChange={() => update(af.id, {
                              values: on ? (af.values ?? []).filter((v) => v !== opt) : [...(af.values ?? []), opt],
                            })} />
                          {opt}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </HudPanel>
          );
        })
      )}
    </>
  );
}

export default function Breakout() {
  return (
    <ErrorBoundary>
      <BreakoutInner />
    </ErrorBoundary>
  );
}
