// Index detail page — Chart / Technicals / F&O / Constituents.
// Reached from Market Dashboard by clicking an index card.
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState } from "@/components/hud/HudControls";
import { DataTable, fmtInt, fmtNum, PctCell } from "@/components/hud/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { CandleChart, type IndicatorFlags, type ChartType } from "@/components/market/CandleChart";
import { TradingViewChart, tvInterval } from "@/components/market/TradingViewChart";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { useCandles, useIndexConstituents, useIndexWatch, useIndices, useOptionChain } from "@/lib/market/hooks";
import { findPreset, tvSymbolFor } from "@/lib/market/indices";
import { bollinger, ema, macd, rsi, sma } from "@/lib/market/chartIndicators";
import type { CandleDto, IndexConstituent } from "@/lib/market/types";

type Tab = "chart" | "technicals" | "fno" | "constituents";
const TIMEFRAMES = ["5m", "15m", "1h", "1D"] as const;

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
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>("1D");
  const [chartType, setChartType] = useState<ChartType>("candles");
  const [useTv, setUseTv] = useState(false);
  const [ind, setInd] = useState<IndicatorFlags>({ ema20: true, ema50: true, volume: true });

  const { data: candlesData, isLoading: candlesLoading } = useCandles(symbol, tf);
  const candles: CandleDto[] = candlesData?.candles ?? [];

  const chgPct = quote?.change_pct ?? null;
  const chgAbs = quote?.change_abs ?? null;

  const tvS = tvSymbolFor(symbol, region);
  const [tvExch, tvSym] = tvS.includes(":") ? tvS.split(":") : ["NSE", tvS];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel flow title={name} index="MK.IDX" actions={
        <Btn size="sm" onClick={() => nav("/market")}><ArrowLeft size={11} style={{ marginRight: 4 }} /> back</Btn>
      }>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--font-display)", fontSize: 30, color: "var(--text)" }}>
            {quote ? Number(quote.price).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
          </span>
          <span style={{ fontSize: 14, color: (chgPct ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}>
            {chgPct == null ? "—" : `${chgPct >= 0 ? "+" : ""}${chgPct.toFixed(2)}%`}
            {chgAbs != null && <span style={{ marginLeft: 6 }}>({chgAbs >= 0 ? "+" : ""}{fmtNum(chgAbs)})</span>}
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
        <HudPanel flow title="Chart" index="MK.IDX.C" actions={
          <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
            {TIMEFRAMES.map((t) => (
              <Btn key={t} size="sm" onClick={() => setTf(t)} style={{ opacity: tf === t ? 1 : 0.6 }}>{t}</Btn>
            ))}
            <span style={{ width: 8 }} />
            {(["candles", "line", "area"] as ChartType[]).map((t) => (
              <Btn key={t} size="sm" onClick={() => setChartType(t)} style={{ opacity: chartType === t ? 1 : 0.6 }}>{t}</Btn>
            ))}
            <span style={{ width: 8 }} />
            <Btn size="sm" onClick={() => setUseTv((v) => !v)}>{useTv ? "hud chart" : "tradingview"}</Btn>
          </div>
        }>
          {!useTv && (
            <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
              {(["ema20", "ema50", "ema200", "sma20", "bb", "vwap", "rsi", "macd", "volume"] as (keyof IndicatorFlags)[]).map((k) => (
                <Btn key={k} size="sm" onClick={() => setInd((i) => ({ ...i, [k]: !i[k] }))} style={{ opacity: ind[k] ? 1 : 0.55 }}>
                  {k}
                </Btn>
              ))}
            </div>
          )}
          <div style={{ height: 480, border: "1px solid var(--edge)" }}>
            {useTv ? (
              <TradingViewChart symbol={tvSym} exchange={tvExch} interval={tvInterval(tf)} />
            ) : candlesLoading ? (
              <div className="hud-label" style={{ padding: 24, textAlign: "center" }}>loading chart…</div>
            ) : candles.length === 0 ? (
              <EmptyState hint="try a different timeframe or check the symbol">no chart data</EmptyState>
            ) : (
              <CandleChart candles={candles} fill chartType={chartType} indicators={ind} />
            )}
          </div>
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
  const cols = useMemo<ColumnDef<IndexConstituent, any>[]>(() => [
    { header: "Symbol", accessorKey: "symbol",
      cell: ({ row }) => <span><span style={{ color: "var(--accent)" }}>{row.original.symbol}</span>
        {row.original.company && <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 10 }}>{row.original.company}</span>}
      </span> },
    { header: "Sector", accessorKey: "sector" },
    { header: "Price", accessorKey: "close", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue()) },
    { header: "Chg %", accessorKey: "change_pct", meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue()} /> },
    { header: "RVol", accessorKey: "rel_volume", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue(), 1) },
    { header: "RSI", accessorKey: "rsi14", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue(), 0) },
    { header: "Breakout", accessorKey: "breakout_score", meta: { align: "right" },
      cell: ({ getValue }) => <ScoreBadge score={getValue() as number | null} label="breakout score" /> },
  ], []);

  return (
    <HudPanel flow title="Constituents" index="MK.IDX.M">
      {isLoading ? <div className="hud-label">loading members…</div>
        : (data?.members ?? []).length === 0
          ? <EmptyState hint={data?.reason ?? "upstream empty"}>no constituents</EmptyState>
          : <DataTable columns={cols} data={data!.members} onRowClick={(r) => onRow(r.symbol)}
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
