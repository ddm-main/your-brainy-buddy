// Index detail page — Chart / Technicals / F&O / Constituents.
// Reached from Market Dashboard by clicking an index card.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState } from "@/components/hud/HudControls";
import { DataTable, deriveChangeAbs, fmtInt, fmtNum, PctCell, Return1DCell } from "@/components/hud/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { CandleChart, type ChartType } from "@/components/market/CandleChart";
import { ChartToolbar, DEFAULT_SETTINGS, type ChartSettings } from "@/components/market/ChartToolbar";
import { IndicatorSettingsModal } from "@/components/market/IndicatorSettingsModal";
import { NewAlertModal } from "@/components/market/StockAlerts";
import { DEFAULT_STUDIES, makeStudy, type IndicatorType, type Study } from "@/lib/market/indicatorRegistry";
import { TradingViewChart, tvInterval } from "@/components/market/TradingViewChart";
import { FullscreenShell } from "@/components/market/FullscreenShell";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { useCandles, useIndexConstituents, useIndexWatch, useIndices, useOptionChain, useQuotes } from "@/lib/market/hooks";
import { findPreset, tvSymbolFor } from "@/lib/market/indices";
import { bollinger, ema, macd, rsi, sma } from "@/lib/market/chartIndicators";
import type { CandleDto, IndexConstituent } from "@/lib/market/types";
import { useNotifications } from "@/store/notificationStore";
import { quoteKey } from "@/lib/market/pnl";
import { isFreshTick, useLiveTickStore } from "@/lib/market/liveTickStore";
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
  const quote = indicesData?.quotes.find((q) => q.symbol === symbol);

  const name = quote?.name ?? watchRow?.name ?? preset?.name ?? symbol;
  const region = (quote?.region ?? watchRow?.region ?? preset?.region ?? "IN") as "IN" | "GLOBAL";
  const nseSymbol = quote?.nse_symbol ?? watchRow?.nse_symbol ?? preset?.nse_symbol ?? null;
  const fno = (quote?.fno_enabled ?? watchRow?.fno_enabled ?? preset?.fno_enabled ?? false) && !!nseSymbol;
  const cSlug = quote?.constituents_slug ?? watchRow?.constituents_slug ?? preset?.constituents_slug ?? null;

  const [tab, setTab] = useState<Tab>("chart");
  const [tf, setTf] = useState("1D");
  const [chartType, setChartType] = useState<ChartType>("candles");
  const [tvMode, setTvMode] = useState(false);
  const [fs, setFs] = useState(false);
  const [studies, setStudies] = useState<Study[]>(DEFAULT_STUDIES);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ChartSettings>(DEFAULT_SETTINGS);
  const [alertModalOpen, setAlertModalOpen] = useState(false);
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const notify = useNotifications((s) => s.add);
  const addStudy = useCallback((t: IndicatorType) => setStudies((s) => [...s, makeStudy(t)]), []);
  const resetStudies = useCallback(() => setStudies(DEFAULT_STUDIES), []);
  const toggleStudy = useCallback((id: string) => setStudies((s) => s.map((x) => (x.id === id ? { ...x, visible: !x.visible } : x))), []);
  const removeStudy = useCallback((id: string) => setStudies((s) => s.filter((x) => x.id !== id)), []);
  const updateStudy = useCallback((u: Study) => setStudies((s) => s.map((x) => (x.id === u.id ? u : x))), []);
  const editing = studies.find((s) => s.id === editingId) ?? null;

  const { data: candlesData, isLoading: candlesLoading } = useCandles(symbol, tf, "NSE");
  const candles: CandleDto[] = candlesData?.candles ?? [];

  const chgPct = quote?.change_pct ?? null;
  const chgAbs = quote?.change_abs ?? null;

  const tvS = tvSymbolFor(symbol, region);
  const [tvExch, tvSym] = tvS.includes(":") ? tvS.split(":") : ["NSE", tvS];
  // TradingView's free widget doesn't carry NSE — those symbols render a wrong
  // fallback (Apple). Only offer TradingView when the mapped exchange is one the
  // widget actually serves (BSE / global exchanges).
  const tvSupported = tvExch.toUpperCase() !== "NSE";
  const showTv = tvMode && tvSupported;

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

  const handleSaveLayout = useCallback((name: string) => {
    try {
      const key = `jarvis.chart.layouts.index.${symbol}`;
      const all = JSON.parse(localStorage.getItem(key) ?? "{}");
      all[name] = { tf, chartType, studies, settings };
      localStorage.setItem(key, JSON.stringify(all));
      notify(`Layout "${name}" saved`);
    } catch { notify("Could not save layout"); }
  }, [notify, symbol, tf, chartType, studies, settings]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel flow title={name} index="MK.IDX" actions={
        <Btn size="sm" onClick={() => nav("/market")}><ArrowLeft size={11} style={{ marginRight: 4 }} /> back</Btn>
      }>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--font-display)", fontSize: 30, color: "var(--text)" }}>
            {quote ? Number(quote.price).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
          </span>
          <span style={{ fontSize: 14 }}>
            <Return1DCell abs={chgAbs} pct={chgPct} />
          </span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{symbol} · {region}</span>
          {fno && <Chip tone="accent">F&O</Chip>}
        </div>

        <div role="tablist" style={{ display: "flex", gap: 4, marginTop: 12, borderBottom: "1px solid var(--edge)" }}>
          {(["chart", "technicals", "fno", "constituents"] as Tab[]).map((t) => {
            const disabled = (t === "fno" && !fno) || (t === "constituents" && !cSlug);
            const active = tab === t;
            return (
              <button key={t} disabled={disabled} role="tab" aria-selected={active}
                onClick={() => setTab(t)}
                style={{
                  padding: "6px 12px", background: "transparent", border: 0,
                  borderBottom: `2px solid ${active ? "var(--accent)" : "transparent"}`,
                  color: disabled ? "var(--text-muted)" : active ? "var(--accent)" : "var(--text-dim)",
                  fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase",
                  cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
                }}
                title={t === "fno" && !fno ? "Not available for this index" : t === "constituents" && !cSlug ? "Only for Indian indices" : ""}>
                {t === "fno" ? "F&O" : t}
              </button>
            );
          })}
        </div>
      </HudPanel>

      {tab === "chart" && (
        <HudPanel flow title="Chart" index="MK.IDX.C" style={{ flex: 1, minHeight: 0 }}>
          <FullscreenShell fullscreen={fs} onExit={() => setFs(false)} title={`${name} · ${tf}`}>
            <ChartToolbar
              symbol={symbol}
              tf={tf}
              onTf={setTf}
              chartType={chartType}
              onChartType={setChartType}
              onAddStudy={addStudy}
              onResetStudies={resetStudies}
              studyCount={studies.length}
              settings={settings}
              onSettings={(u) => setSettings(u)}
              tvMode={tvMode}
              onTvMode={(v) => {
                if (v && !tvSupported) { notify("TradingView widget unavailable for NSE indices — showing native chart"); return; }
                setTvMode(v);
              }}
              onFullscreen={() => setFs(true)}
              onAlert={() => setAlertModalOpen(true)}
              onScreenshot={handleScreenshot}
              onSaveLayout={handleSaveLayout}
            />
            <div ref={chartWrapRef} style={{ flex: 1, minHeight: 0 }}>
              {showTv ? (
                <TradingViewChart symbol={tvSym} exchange={tvExch} interval={tvInterval(tf)} />
              ) : candlesLoading ? (
                <div className="hud-label" style={{ padding: 24, textAlign: "center" }}>loading chart…</div>
              ) : candles.length === 0 ? (
                <EmptyState hint="try a different timeframe or check the symbol">no chart data</EmptyState>
              ) : (
                <CandleChart
                  candles={candles} fill chartType={chartType}
                  studies={studies}
                  intraday={tf !== "1D"}
                  livePrice={quote?.price ?? null}
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
      )}

      {tab === "technicals" && (
        <TechnicalsPanel candles={candles} loading={candlesLoading} />
      )}

      {tab === "fno" && fno && nseSymbol && (
        <FnOPanel nseSymbol={nseSymbol} />
      )}

      {tab === "constituents" && cSlug && (
        <ConstituentsPanel slug={cSlug} onRow={(s) => nav(`/market/analysis/${s}`)} />
      )}

      {alertModalOpen && (
        <NewAlertModal symbol={symbol} exchange="NSE" onClose={() => setAlertModalOpen(false)}
          onCreated={() => setAlertModalOpen(false)} />
      )}
    </div>
  );
}

function TechnicalsPanel({ candles, loading }: { candles: CandleDto[]; loading: boolean }) {
  const stats = useMemo(() => {
    if (candles.length < 2) return null;
    const closes = candles.map((c) => c.close);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const win = candles.slice(-252);
    const hi52 = Math.max(...win.map((c) => c.high));
    const lo52 = Math.min(...win.map((c) => c.low));
    const ema20v = ema(candles, 20).at(-1) ?? null;
    const ema50v = ema(candles, 50).at(-1) ?? null;
    const ema200v = ema(candles, 200).at(-1) ?? null;
    const sma20v = sma(candles, 20).at(-1) ?? null;
    const bb = bollinger(candles, 20, 2);
    const rsi14 = rsi(candles, 14).at(-1) ?? null;
    const macdv = macd(candles);
    const vols = candles.slice(-20).map((c) => c.volume).filter((v) => v > 0);
    const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
    return {
      last, prev, hi52, lo52, ema20v, ema50v, ema200v, sma20v,
      bbU: bb.upper.at(-1) ?? null, bbL: bb.lower.at(-1) ?? null, bbM: bb.mid.at(-1) ?? null,
      rsi14,
      macd: macdv.macd.at(-1) ?? null, macdSig: macdv.signal.at(-1) ?? null, macdHist: macdv.hist.at(-1) ?? null,
      avgVol, closes,
    };
  }, [candles]);

  if (loading) return <HudPanel flow title="Technicals" index="MK.IDX.T"><div className="hud-label">loading…</div></HudPanel>;
  if (!stats) return <HudPanel flow title="Technicals" index="MK.IDX.T"><EmptyState>not enough history</EmptyState></HudPanel>;

  const { last, prev, hi52, lo52, ema20v, ema50v, ema200v, sma20v, bbU, bbL, rsi14, macd: m, macdSig, macdHist, avgVol } = stats;
  const fromHi = hi52 ? ((last.close - hi52) / hi52) * 100 : 0;
  const fromLo = lo52 ? ((last.close - lo52) / lo52) * 100 : 0;
  const dayAbs = last.close - prev.close;
  const dayPct = prev.close ? (dayAbs / prev.close) * 100 : 0;

  const signal = (v: number | null, ref: number | null) =>
    v == null || ref == null ? null : v > ref ? "above" : "below";
  const tone = (s: string | null) => s === "above" ? "ok" : s === "below" ? "err" : undefined;

  return (
    <HudPanel flow title="Technicals" index="MK.IDX.T">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
        <Stat label="Open" value={fmtNum(last.open)} />
        <Stat label="Prev Close" value={fmtNum(prev.close)} />
        <Stat label="Day High" value={fmtNum(last.high)} />
        <Stat label="Day Low" value={fmtNum(last.low)} />
        <Stat label="Day Change" value={`${dayAbs >= 0 ? "+" : ""}${fmtNum(dayAbs)} (${dayPct.toFixed(2)}%)`} tone={dayAbs >= 0 ? "ok" : "err"} />
        <Stat label="52W High" value={fmtNum(hi52)} />
        <Stat label="52W Low" value={fmtNum(lo52)} />
        <Stat label="From 52W High" value={`${fromHi >= 0 ? "+" : ""}${fromHi.toFixed(2)}%`} tone={fromHi >= -5 ? "ok" : undefined} />
        <Stat label="From 52W Low" value={`${fromLo >= 0 ? "+" : ""}${fromLo.toFixed(2)}%`} tone="ok" />
        {last.volume > 0 && <Stat label="Volume" value={fmtInt(last.volume)} />}
        {avgVol > 0 && <Stat label="Avg Vol (20d)" value={fmtInt(avgVol)} />}
        <Stat label="EMA 20" value={fmtNum(ema20v)} tone={tone(signal(last.close, ema20v))} />
        <Stat label="EMA 50" value={fmtNum(ema50v)} tone={tone(signal(last.close, ema50v))} />
        <Stat label="EMA 200" value={fmtNum(ema200v)} tone={tone(signal(last.close, ema200v))} />
        <Stat label="SMA 20" value={fmtNum(sma20v)} tone={tone(signal(last.close, sma20v))} />
        <Stat label="Bollinger Upper" value={fmtNum(bbU)} />
        <Stat label="Bollinger Lower" value={fmtNum(bbL)} />
        <Stat label="RSI 14" value={rsi14 == null ? "—" : rsi14.toFixed(1)} tone={rsi14 == null ? undefined : rsi14 > 70 ? "err" : rsi14 < 30 ? "ok" : undefined} />
        <Stat label="MACD" value={m == null ? "—" : m.toFixed(2)} />
        <Stat label="MACD Signal" value={macdSig == null ? "—" : macdSig.toFixed(2)} />
        <Stat label="MACD Hist" value={macdHist == null ? "—" : macdHist.toFixed(2)} tone={macdHist == null ? undefined : macdHist >= 0 ? "ok" : "err"} />
      </div>
    </HudPanel>
  );
}

function FnOPanel({ nseSymbol }: { nseSymbol: string }) {
  const { data, isLoading, error } = useOptionChain(nseSymbol);
  const rows = useMemo(() => {
    if (!data) return [];
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
  const pushTicks = useLiveTickStore((s) => s.ticks);
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
      cell: ({ getValue }) => <ScoreBadge score={getValue() as number | null} label="breakout score" /> },
  ], [liveByKey]);

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
