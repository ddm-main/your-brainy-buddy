// Index detail page — Chart / Technicals / F&O / Constituents.
// Reached from Market Dashboard by clicking an index card.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState } from "@/components/hud/HudControls";
import { DataTable, deriveChangeAbs, fmtInt, fmtNum, Return1DCell } from "@/components/hud/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { CandleChart, type ChartType } from "@/components/market/CandleChart";
import { ChartToolbar, DEFAULT_SETTINGS, isIntraday, type ChartSettings } from "@/components/market/ChartToolbar";
import { IndicatorSettingsModal } from "@/components/market/IndicatorSettingsModal";
import { NewAlertModal, StockAlertsPanel } from "@/components/market/StockAlerts";
import { DEFAULT_STUDIES, makeStudy, type IndicatorType, type Study } from "@/lib/market/indicatorRegistry";
import { FullscreenShell } from "@/components/market/FullscreenShell";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { useCandles, useIndexConstituents, useIndexWatch, useIndices, useOptionChain, useQuotes } from "@/lib/market/hooks";
import { findPreset } from "@/lib/market/indices";
import { bollinger, ema, macd, rsi, sma } from "@/lib/market/chartIndicators";
import type { CandleDto, IndexConstituent } from "@/lib/market/types";
import { useNotifications } from "@/store/notificationStore";
import { quoteKey } from "@/lib/market/pnl";
import { isFreshTick, useLiveTickStore, useTicksRevision} from "@/lib/market/liveTickStore";
import { subscribeSymbolsForTicks } from "@/lib/market/useRealtimeTicks";

type Tab = "chart" | "technicals" | "fno" | "constituents";

export default function IndexDetail() {
  const { symbol: rawSym } = useParams();
  const nav = useNavigate();
  const symbol = decodeURIComponent(rawSym ?? "");
  const { data: watch = [] } = useIndexWatch();
  const { data: indicesData } = useIndices();
  const preset = findPreset(symbol);
  const watchRow = watch.find((w) => w.symbol === symbol);
  const restQuote = indicesData?.quotes.find((q) => q.symbol === symbol);
  const indexTickKey = symbol ? `NSE:${symbol.toUpperCase()}` : "";
  const pushTick = useLiveTickStore((s) => (indexTickKey ? s.ticks[indexTickKey] : undefined));
  useEffect(() => {
    if (!indexTickKey) return;
    subscribeSymbolsForTicks([indexTickKey]);
  }, [indexTickKey]);
  const quote = useMemo(() => {
    if (isFreshTick(pushTick) && restQuote) {
      return {
        ...restQuote,
        price: pushTick.ltp,
        change_pct: pushTick.change_pct,
        change_abs: deriveChangeAbs(pushTick.ltp, pushTick.change_pct),
      };
    }
    return restQuote;
  }, [pushTick, restQuote]);

  const name = quote?.name ?? watchRow?.name ?? preset?.name ?? symbol;
  const region = (quote?.region ?? watchRow?.region ?? preset?.region ?? "IN") as "IN" | "GLOBAL";
  const nseSymbol = quote?.nse_symbol ?? watchRow?.nse_symbol ?? preset?.nse_symbol ?? null;
  const fno = (quote?.fno_enabled ?? watchRow?.fno_enabled ?? preset?.fno_enabled ?? false) && !!nseSymbol;
  const cSlug = quote?.constituents_slug ?? watchRow?.constituents_slug ?? preset?.constituents_slug ?? null;

  // Persist chart state per symbol so a refresh doesn't reset TF to "1D"
  // (Analysis.tsx does the same via STATE_STORE — parity fix).
  const stateKey = `jarvis.chart.state.index.${symbol}`;
  type Persisted = { tf: string; chartType: ChartType; studies: Study[]; settings: ChartSettings };
  const initial = useMemo<Persisted>(() => {
    const dflt: Persisted = { tf: "1D", chartType: "candles", studies: DEFAULT_STUDIES, settings: DEFAULT_SETTINGS };
    try {
      const raw = JSON.parse(localStorage.getItem(stateKey) ?? "{}");
      return {
        tf: typeof raw.tf === "string" ? raw.tf : dflt.tf,
        chartType: raw.chartType === "line" || raw.chartType === "area" || raw.chartType === "candles" ? raw.chartType : dflt.chartType,
        studies: Array.isArray(raw.studies) ? raw.studies : dflt.studies,
        settings: raw.settings ? { ...DEFAULT_SETTINGS, ...raw.settings } : dflt.settings,
      };
    } catch { return dflt; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey]);

  const [tab, setTab] = useState<Tab>("chart");
  const [tf, setTf] = useState(initial.tf);
  const [chartType, setChartType] = useState<ChartType>(initial.chartType);
  const [fs, setFs] = useState(false);
  const [studies, setStudies] = useState<Study[]>(initial.studies);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ChartSettings>(initial.settings);
  const [alertModalOpen, setAlertModalOpen] = useState(false);
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const notify = useNotifications((s) => s.add);
  const addStudy = useCallback((t: IndicatorType) => setStudies((s) => [...s, makeStudy(t)]), []);
  const resetStudies = useCallback(() => setStudies(DEFAULT_STUDIES), []);
  const toggleStudy = useCallback((id: string) => setStudies((s) => s.map((x) => (x.id === id ? { ...x, visible: !x.visible } : x))), []);
  const removeStudy = useCallback((id: string) => setStudies((s) => s.filter((x) => x.id !== id)), []);
  const updateStudy = useCallback((u: Study) => setStudies((s) => s.map((x) => (x.id === u.id ? u : x))), []);
  const editing = studies.find((s) => s.id === editingId) ?? null;

  // Persist on every change so a refresh restores the exact chart state.
  useEffect(() => {
    try {
      localStorage.setItem(stateKey, JSON.stringify({ tf, chartType, studies, settings } satisfies Persisted));
    } catch { /* quota / private mode — safe to ignore */ }
  }, [stateKey, tf, chartType, studies, settings]);

  // Indices are composites — Kotak/Yahoo both report 0 volume for them, so the
  // volume study just renders a flat "Volume 0" line. Auto-hide it here rather
  // than confuse the user; equity index proxies (with an nse_symbol like
  // BANKNIFTY) still get real volume on constituents via other panels.
  const isIndex = true; // this route only ever renders an index
  const effectiveStudies = useMemo(
    () => (isIndex ? studies.map((s) => (s.type === "volume" ? { ...s, visible: false } : s)) : studies),
    [studies, isIndex],
  );

  const { data: candlesData, isLoading: candlesLoading } = useCandles(symbol, tf, "NSE");
  const candles: CandleDto[] = candlesData?.candles ?? [];
  const visibleStudyCount = useMemo(() => effectiveStudies.filter((s) => s.visible).length, [effectiveStudies]);

  const price = quote?.price ?? null;
  const chgPct = quote?.change_pct ?? null;
  const chgAbs = quote?.change_abs ?? deriveChangeAbs(price, chgPct);




  const handleScreenshot = useCallback(() => {
    const wrap = chartWrapRef.current;
    if (!wrap) return;
    const canvases = wrap.querySelectorAll("canvas");
    if (canvases.length === 0) { notify("Chart not ready for screenshot"); return; }
    const rects = Array.from(canvases).map((c) => c.getBoundingClientRect());
    const wrapRect = wrap.getBoundingClientRect();
    const out = document.createElement("canvas");
    out.width = Math.ceil(wrapRect.width * devicePixelRatio);
    out.height = Math.ceil(wrapRect.height * devicePixelRatio);
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--bg").trim() || "#050b12";
    ctx.fillRect(0, 0, out.width, out.height);
    canvases.forEach((c, i) => {
      const r = rects[i];
      const x = (r.left - wrapRect.left) * devicePixelRatio;
      const y = (r.top - wrapRect.top) * devicePixelRatio;
      try { ctx.drawImage(c, x, y, r.width * devicePixelRatio, r.height * devicePixelRatio); } catch { /* noop */ }
    });
    out.toBlob((blob) => {
      if (!blob) { notify("Screenshot failed"); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${symbol ?? "chart"}-${tf}-${new Date().toISOString().slice(0, 10)}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      notify("Chart screenshot saved");
    }, "image/png");
  }, [tf, symbol, notify]);

  const layoutKey = `jarvis.chart.layouts.index.${symbol}`;
  const readLayouts = useCallback((): Record<string, any> => {
    try { return JSON.parse(localStorage.getItem(layoutKey) ?? "{}"); } catch { return {}; }
  }, [layoutKey]);
  const [savedLayouts, setSavedLayouts] = useState<string[]>(() => {
    try { return Object.keys(JSON.parse(localStorage.getItem(layoutKey) ?? "{}")); } catch { return []; }
  });


  const handleSaveLayout = useCallback((name: string) => {
    try {
      const all = readLayouts();
      all[name] = { tf, chartType, studies, settings };
      localStorage.setItem(layoutKey, JSON.stringify(all));
      setSavedLayouts(Object.keys(all));
      notify(`Layout "${name}" saved`);
    } catch { notify("Could not save layout"); }
  }, [notify, layoutKey, readLayouts, tf, chartType, studies, settings]);

  const handleLoadLayout = useCallback((name: string) => {
    const l = readLayouts()[name];
    if (!l) return;
    if (l.tf) setTf(l.tf);
    if (l.chartType) setChartType(l.chartType);
    if (Array.isArray(l.studies)) setStudies(l.studies);
    if (l.settings) setSettings({ ...DEFAULT_SETTINGS, ...l.settings });
    notify(`Layout "${name}" loaded`);
  }, [readLayouts, notify]);

  const handleDeleteLayout = useCallback((name: string) => {
    const all = readLayouts();
    delete all[name];
    localStorage.setItem(layoutKey, JSON.stringify(all));
    setSavedLayouts(Object.keys(all));
  }, [readLayouts, layoutKey]);

  const stats = useIndexTechnicals(candles);


  const wideTabs: Tab[] = [
    ...(cSlug ? (["constituents"] as Tab[]) : []),
    ...(fno && nseSymbol ? (["fno"] as Tab[]) : []),
  ];
  const activeWide = wideTabs.includes(tab) ? tab : wideTabs[0];

  return (
    <>
      <div className="mk-anl-grid">
        {/* Chart column — fills the viewport height */}
        <div className="mk-anl-chart" style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
          <HudPanel
            title={name}
            index="MK.IDX.C"
            live={candlesLoading ? "warn" : "ok"}
            style={{ flex: 1, minHeight: 0 }}
            actions={
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                {candlesData?.provider && (
                  <Chip tone={candlesData.provider === "kotak_neo" ? "ok" : "accent"}>
                    {candlesData.provider === "kotak_neo" ? "kotak" : "yahoo"}
                  </Chip>
                )}
                <Btn size="sm" onClick={() => nav("/market")}><ArrowLeft size={11} style={{ marginRight: 4 }} /> back</Btn>
              </div>
            }
          >
            <FullscreenShell fullscreen={fs} onExit={() => setFs(false)} title={`${name} · ${tf}`}>
              <ChartToolbar
                symbol={symbol}
                tf={tf}
                onTf={setTf}
                chartType={chartType}
                onChartType={setChartType}
                onAddStudy={addStudy}
                onResetStudies={resetStudies}
                studyCount={visibleStudyCount}
                totalStudyCount={studies.length}
                settings={settings}
                onSettings={(u) => setSettings(u)}
                onFullscreen={() => setFs(true)}
                onAlert={() => setAlertModalOpen(true)}
                onScreenshot={handleScreenshot}
                onSaveLayout={handleSaveLayout}
                onLoadLayout={handleLoadLayout}
                onDeleteLayout={handleDeleteLayout}
                savedLayouts={savedLayouts}
                intraday={isIntraday(tf)}
              />
              <div ref={chartWrapRef} style={{ flex: 1, minHeight: 0 }}>
                {candlesLoading ? (
                  <div className="hud-label" style={{ padding: 24, textAlign: "center" }}>loading chart…</div>
                ) : candles.length === 0 ? (
                  <EmptyState hint="try a different timeframe or check the symbol">no chart data</EmptyState>
                ) : (
                  <CandleChart
                    candles={candles} fill chartType={chartType}
                    studies={effectiveStudies}
                    intraday={isIntraday(tf)}
                    livePrice={quote?.price ?? null}
                    liveVolume={(quote as any)?.volume ?? null}
                    onToggleStudy={toggleStudy}
                    onEditStudy={setEditingId}
                    onRemoveStudy={removeStudy}
                    source={candlesData?.provider ?? null}
                  />
                )}
              </div>
            </FullscreenShell>
            <IndicatorSettingsModal study={editing} onChange={updateStudy} onRemove={removeStudy} onClose={() => setEditingId(null)} />
          </HudPanel>
        </div>

        {/* Right rail — scrolls independently */}
        <div className="mk-anl-rail">
          <HudPanel flow title="Quote" index="A1">
            <div style={{ fontFamily: "var(--font-display)", fontSize: 26, color: "var(--accent)" }}>
              {price != null ? price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
            </div>
            <div style={{ fontSize: 13 }}>
              <Return1DCell abs={chgAbs} pct={chgPct} />
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.1em" }}>{symbol} · {region}</span>
              {fno && <Chip tone="accent">F&O</Chip>}
            </div>
          </HudPanel>

          <StockAlertsPanel symbol={symbol} exchange="NSE" />

          <HudPanel flow title="Indicators (Daily)" index="A4">
            {candlesLoading ? <div className="hud-label">loading…</div> : !stats ? <EmptyState>not enough history</EmptyState> : (
              <>
                <Row label="RSI (14)" mono>{stats.rsi14 == null ? "—" : stats.rsi14.toFixed(1)}</Row>
                <Row label="MACD" mono>{fmtNum(stats.macd, 2)} / {fmtNum(stats.macdSig, 2)}</Row>
                <Row label="MACD Hist" mono>
                  <span style={{ color: (stats.macdHist ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}>{fmtNum(stats.macdHist, 2)}</span>
                </Row>
                <Row label="EMA 20/50/200" mono>
                  <span style={{ fontSize: 10 }}>{fmtNum(stats.ema20v, 0)} / {fmtNum(stats.ema50v, 0)} / {fmtNum(stats.ema200v, 0)}</span>
                </Row>
                <Row label="SMA 20" mono>{fmtNum(stats.sma20v)}</Row>
                <Row label="Bollinger U/L" mono>
                  <span style={{ fontSize: 10 }}>{fmtNum(stats.bbU, 0)} / {fmtNum(stats.bbL, 0)}</span>
                </Row>
                {stats.avgVol > 0 && <Row label="Avg Vol (20d)" mono>{fmtInt(stats.avgVol)}</Row>}
                {stats.last.volume > 0 && <Row label="Volume" mono>{fmtInt(stats.last.volume)}</Row>}
              </>
            )}
          </HudPanel>

          <HudPanel flow title="Range & Strength" index="A5">
            {candlesLoading ? <div className="hud-label">loading…</div> : !stats ? <EmptyState>not enough history</EmptyState> : (
              <>
                <Row label="Open" mono>{fmtNum(stats.last.open)}</Row>
                <Row label="Prev Close" mono>{fmtNum(stats.prev.close)}</Row>
                <Row label="Day High" mono>{fmtNum(stats.last.high)}</Row>
                <Row label="Day Low" mono>{fmtNum(stats.last.low)}</Row>
                <Row label="Day Change" mono>
                  <Return1DCell abs={stats.dayAbs} pct={stats.dayPct} />
                </Row>
                <Row label="52W High" mono>{fmtNum(stats.hi52)}</Row>
                <Row label="52W Low" mono>{fmtNum(stats.lo52)}</Row>
                <Row label="From 52W High" mono>
                  <span style={{ color: stats.fromHi > -5 ? "var(--ok)" : "var(--text)" }}>{stats.fromHi.toFixed(2)}%</span>
                </Row>
                <Row label="From 52W Low" mono>
                  <span style={{ color: "var(--ok)" }}>+{stats.fromLo.toFixed(2)}%</span>
                </Row>
              </>
            )}
          </HudPanel>

          {fno && nseSymbol && <FnOSummary nseSymbol={nseSymbol} />}
        </div>
      </div>

      {/* Wide, table-shaped views live under the workbench */}
      {wideTabs.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div role="tablist" style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--edge)", marginBottom: 10 }}>
            {wideTabs.map((t) => {
              const active = activeWide === t;
              return (
                <button key={t} role="tab" aria-selected={active} onClick={() => setTab(t)}
                  style={{
                    padding: "6px 12px", background: "transparent", border: 0,
                    borderBottom: `2px solid ${active ? "var(--accent)" : "transparent"}`,
                    color: active ? "var(--accent)" : "var(--text-dim)",
                    fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase", cursor: "pointer",
                  }}>
                  {t === "fno" ? "F&O chain" : t}
                </button>
              );
            })}
          </div>
          {activeWide === "fno" && fno && nseSymbol && <FnOPanel nseSymbol={nseSymbol} />}
          {activeWide === "constituents" && cSlug && (
            <ConstituentsPanel slug={cSlug} onRow={(s) => nav(`/market/analysis/${s}`)} />
          )}
        </div>
      )}

      {alertModalOpen && (
        <NewAlertModal symbol={symbol} exchange="NSE" onClose={() => setAlertModalOpen(false)}
          onCreated={() => setAlertModalOpen(false)} />
      )}
    </>
  );
}

// Shared daily technical readout for the rail panels.
function useIndexTechnicals(candles: CandleDto[]) {
  return useMemo(() => {
    if (candles.length < 2) return null;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const win = candles.slice(-252);
    const hi52 = Math.max(...win.map((c) => c.high));
    const lo52 = Math.min(...win.map((c) => c.low));
    const bb = bollinger(candles, 20, 2);
    const macdv = macd(candles);
    const vols = candles.slice(-20).map((c) => c.volume).filter((v) => v > 0);
    const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
    const dayAbs = last.close - prev.close;
    return {
      last, prev, hi52, lo52,
      ema20v: ema(candles, 20).at(-1) ?? null,
      ema50v: ema(candles, 50).at(-1) ?? null,
      ema200v: ema(candles, 200).at(-1) ?? null,
      sma20v: sma(candles, 20).at(-1) ?? null,
      bbU: bb.upper.at(-1) ?? null,
      bbL: bb.lower.at(-1) ?? null,
      rsi14: rsi(candles, 14).at(-1) ?? null,
      macd: macdv.macd.at(-1) ?? null,
      macdSig: macdv.signal.at(-1) ?? null,
      macdHist: macdv.hist.at(-1) ?? null,
      avgVol,
      dayAbs,
      dayPct: prev.close ? (dayAbs / prev.close) * 100 : 0,
      fromHi: hi52 ? ((last.close - hi52) / hi52) * 100 : 0,
      fromLo: lo52 ? ((last.close - lo52) / lo52) * 100 : 0,
    };
  }, [candles]);
}

function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid var(--edge)", fontSize: 12 }}>
      <span className="hud-label" style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={mono ? { fontVariantNumeric: "tabular-nums", color: "var(--text)" } : undefined}>{children}</span>
    </div>
  );
}

function FnOSummary({ nseSymbol }: { nseSymbol: string }) {
  const { data, isLoading, error } = useOptionChain(nseSymbol);
  const hasRows = (data?.rows?.length ?? 0) > 0;
  return (
    <HudPanel flow title="F&O Snapshot" index="A7">
      {isLoading ? <div className="hud-label">loading option chain…</div>
        : error || !data ? <EmptyState hint={String((error as any)?.message ?? "")}>option chain unavailable</EmptyState>
        : !hasRows ? <EmptyState hint={data.warning ?? "NSE returned no strikes for this expiry."}>option chain unavailable</EmptyState>
        : (
          <>
            <Row label="Spot" mono>{fmtNum(data.underlying)}</Row>
            <Row label="PCR (OI)" mono>
              <span style={{ color: data.pcr == null ? "var(--text)" : data.pcr > 1 ? "var(--ok)" : "var(--danger)" }}>
                {data.pcr == null ? "—" : data.pcr.toFixed(2)}
              </span>
            </Row>
            <Row label="Total Call OI" mono>{fmtInt(data.total_call_oi)}</Row>
            <Row label="Total Put OI" mono>{fmtInt(data.total_put_oi)}</Row>
            <Row label="Expiry" mono>{data.expiry}</Row>
          </>
        )}
    </HudPanel>
  );
}


function FnOPanel({ nseSymbol }: { nseSymbol: string }) {
  const { data, isLoading, error } = useOptionChain(nseSymbol);
  const rows = useMemo(() => {
    if (!data?.rows?.length) return [];
    const atmIdx = data.rows.reduce((best, r, i) => {
      const cur = data.rows[best];
      return Math.abs(r.strike - data.underlying) < Math.abs(cur.strike - data.underlying) ? i : best;
    }, 0);
    const start = Math.max(0, atmIdx - 10);
    const end = Math.min(data.rows.length, atmIdx + 11);
    return data.rows.slice(start, end).map((r) => ({ ...r, isAtm: r.strike === data.rows[atmIdx].strike }));
  }, [data]);

  if (isLoading) return <HudPanel flow title="F&O" index="MK.IDX.F"><div className="hud-label">loading option chain…</div></HudPanel>;
  if (error) return <HudPanel flow title="F&O" index="MK.IDX.F"><EmptyState hint={String((error as any)?.message ?? "")}>option chain unavailable</EmptyState></HudPanel>;
  if (!data) return null;
  if (rows.length === 0) return <HudPanel flow title={`F&O · ${nseSymbol}`} index="MK.IDX.F"><EmptyState hint={data.warning ?? "NSE returned no strikes for this expiry."}>option chain unavailable</EmptyState></HudPanel>;

  return (
    <HudPanel flow title={`F&O · ${nseSymbol}`} index="MK.IDX.F">
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
        <Stat label="Spot" value={fmtNum(data.underlying)} />
        <Stat label="PCR (OI)" value={data.pcr == null ? "—" : data.pcr.toFixed(2)} tone={data.pcr == null ? undefined : data.pcr > 1 ? "ok" : "err"} />
        <Stat label="Total Call OI" value={fmtInt(data.total_call_oi)} />
        <Stat label="Total Put OI" value={fmtInt(data.total_put_oi)} />
        <Stat label="Expiry" value={data.expiry} />
      </div>
      <div style={{ overflowX: "auto", border: "1px solid var(--edge)" }}>
        <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
          <thead>
            <tr style={{ background: "rgba(53,214,237,0.05)", color: "var(--text-dim)" }}>
              <th style={th}>Call OI</th><th style={th}>Call LTP</th><th style={th}>Strike</th><th style={th}>Put LTP</th><th style={th}>Put OI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.strike} style={{ background: r.isAtm ? "rgba(53,214,237,0.12)" : "transparent", borderBottom: "1px solid var(--edge)" }}>
                <td style={td}>{fmtInt(r.call?.oi)}</td>
                <td style={td}>{fmtNum(r.call?.ltp)}</td>
                <td style={{ ...td, color: r.isAtm ? "var(--accent)" : "var(--text)", fontWeight: r.isAtm ? 600 : 400 }}>{r.strike}</td>
                <td style={td}>{fmtNum(r.put?.ltp)}</td>
                <td style={td}>{fmtInt(r.put?.oi)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </HudPanel>
  );
}

function ConstituentsPanel({ slug, onRow }: { slug: string; onRow: (sym: string) => void }) {
  const nav = useNavigate();
  const { data, isLoading } = useIndexConstituents(slug);
  const members = data?.members ?? [];

  // Live overlay for Price / Chg% — filters/other columns stay on EOD, but
  // the two most price-sensitive columns get Kotak push + REST poll.
  const keysJoined = useMemo(
    () => Array.from(new Set(members.map((m) => quoteKey("NSE", m.symbol)))).sort().join(","),
    [members],
  );
  const keys = useMemo(() => (keysJoined ? keysJoined.split(",") : []), [keysJoined]);
  const { data: liveQuotes } = useQuotes(keys, { intervalMs: 2_000 });
  const _ticksRev_pushTicks = useTicksRevision();
  const pushTicks = useLiveTickStore.getState().ticks;
  void _ticksRev_pushTicks; // re-render on any tick flush; read fresh map above
  useEffect(() => { subscribeSymbolsForTicks(keys); }, [keysJoined]);
  const liveByKey = useMemo(() => {
    const m = new Map<string, { ltp: number | null; change_pct: number | null; change_abs: number | null }>();
    for (const q of liveQuotes?.quotes ?? []) {
      const ltp = q.ltp ?? null;
      const pct = q.change_pct ?? null;
      const abs = q.day_change ?? (ltp != null && q.previous_close != null ? ltp - q.previous_close : deriveChangeAbs(ltp, pct));
      m.set(quoteKey(q.exchange, q.symbol), { ltp, change_pct: pct, change_abs: abs });
    }
    for (const [key, tick] of Object.entries(pushTicks)) {
      if (!isFreshTick(tick)) continue;
      m.set(key, { ltp: tick.ltp, change_pct: tick.change_pct, change_abs: deriveChangeAbs(tick.ltp, tick.change_pct) });
    }
    return m;
  }, [liveQuotes, pushTicks]);

  const cols = useMemo<ColumnDef<IndexConstituent, any>[]>(() => [
    { header: "Symbol", accessorKey: "symbol",
      cell: ({ row }) => <span><span style={{ color: "var(--accent)" }}>{row.original.symbol}</span>
        {row.original.company && <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 10 }}>{row.original.company}</span>}
      </span> },
    { header: "Sector", accessorKey: "sector" },
    { header: "Price", id: "livePrice", meta: { align: "right" },
      accessorFn: (r) => liveByKey.get(quoteKey("NSE", r.symbol))?.ltp ?? r.close,
      cell: ({ getValue }) => fmtNum(getValue() as number | null) },
    { header: "1D Return", id: "liveChangePct", meta: { align: "right" },
      accessorFn: (r) => liveByKey.get(quoteKey("NSE", r.symbol))?.change_pct ?? r.change_pct,
      cell: ({ row }) => {
        const live = liveByKey.get(quoteKey("NSE", row.original.symbol));
        const pct = live?.change_pct ?? row.original.change_pct ?? null;
        const abs = live?.change_abs ?? deriveChangeAbs(live?.ltp ?? row.original.close ?? null, pct);
        return <Return1DCell abs={abs} pct={pct} />;
      } },
    { header: "RVol", accessorKey: "rel_volume", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue(), 1) },
    { header: "RSI", accessorKey: "rsi14", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue(), 0) },
    { header: "Breakout", accessorKey: "breakout_score", meta: { align: "right" },
      cell: ({ row }) => <ScoreBadge score={row.original.breakout_score as number | null} label="breakout score" onClick={() => nav(`/market/score/${encodeURIComponent(String(row.original.symbol))}/explain?exchange=NSE`)} /> },
  ], [liveByKey, nav]);

  return (
    <HudPanel flow title="Constituents" index="MK.IDX.M">
      {isLoading ? <div className="hud-label">loading members…</div>
        : members.length === 0
          ? <EmptyState hint={data?.reason ?? "upstream empty"}>no constituents</EmptyState>
          : <DataTable columns={cols} data={members} onRowClick={(r) => onRow(r.symbol)}
              initialSort={[{ id: "breakout_score", desc: true }]} emptyLabel="no members" />}
    </HudPanel>
  );
}

const th: React.CSSProperties = { padding: "6px 8px", textAlign: "right", fontWeight: 400, letterSpacing: "0.1em", textTransform: "uppercase" };
const td: React.CSSProperties = { padding: "5px 8px", textAlign: "right" };

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "err" }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--danger)" : "var(--text)";
  return (
    <div style={{ padding: "8px 10px", border: "1px solid var(--edge)", minWidth: 140 }}>
      <div className="hud-label" style={{ color: "var(--text-dim)" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 16, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}
