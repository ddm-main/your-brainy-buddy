// All-Stocks table under Analysis — technicals + fundamentals for every stock in
// one sortable grid. Replaces the old Option Chain tab. Data comes from the same
// unified market_data table the Screener uses, so it always covers the
// full active universe. Click a row to open its Analysis chart.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { DataTable, fmtInt, fmtNum, PctCell } from "@/components/hud/DataTable";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { useScreenerData, type ScreenerRow } from "@/lib/market/screenerRun";
import { UNIVERSES, type UniverseId } from "@/lib/market/screenerCatalog";

type View = "technical" | "fundamental" | "all";
const VIEWS: Array<{ id: View; label: string }> = [
  { id: "technical", label: "Technical" },
  { id: "fundamental", label: "Fundamental" },
  { id: "all", label: "All" },
];

// Column groups. Symbol + price are always shown; the rest depend on the view.
const IDENTITY = ["symbol", "sector", "close", "change_pct"];
const TECHNICAL = ["rsi", "macd", "adx", "atr_pct", "bb_width", "rel_volume", "pct_from_52w_high", "breakout_score", "prebreakout_score", "setup"];
const FUNDAMENTAL = ["market_cap", "pe", "pb", "peg", "eps", "roe", "roce", "debt_equity", "sales_growth", "profit_growth", "dividend_yield", "promoter_holding"];

const num = (d = 2) => ({ getValue }: any) => fmtNum(getValue() as number | null, d);
const pct = () => ({ getValue }: any) => <PctCell value={getValue() as number | null} />;
const pctSuffix = (d = 1) => ({ getValue }: any) => { const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(d)}%`; };

const COLS: Record<string, ColumnDef<ScreenerRow, any>> = {
  symbol: {
    header: "Symbol", accessorKey: "symbol",
    cell: ({ row }) => (
      <span>
        <span style={{ color: "var(--accent)" }}>{row.original.symbol}</span>
        {row.original.company_name && <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 10 }}>{row.original.company_name}</span>}
      </span>
    ),
  },
  sector: { header: "Sector", accessorKey: "sector", cell: ({ getValue }) => <span style={{ fontSize: 11 }}>{(getValue() as string) ?? "—"}</span> },
  close: { header: "Price", accessorKey: "ltp", meta: { align: "right" }, cell: num(2) },
  change_pct: { header: "Chg %", accessorKey: "change_pct", meta: { align: "right" }, cell: pct() },
  // technical
  rsi: { header: "RSI", accessorKey: "rsi", meta: { align: "right" }, cell: num(0) },
  macd: { header: "MACD", accessorKey: "macd", meta: { align: "right" }, cell: num(2) },
  adx: { header: "ADX", accessorKey: "adx", meta: { align: "right" }, cell: num(0) },
  atr_pct: { header: "ATR %", accessorKey: "atr_pct", meta: { align: "right" }, cell: num(2) },
  bb_width: { header: "BB Wid", accessorKey: "bb_width", meta: { align: "right" }, cell: num(3) },
  rel_volume: { header: "RVol", accessorKey: "rel_volume", meta: { align: "right" }, cell: num(1) },
  pct_from_52w_high: { header: "52w Δ", accessorKey: "pct_from_52w_high", meta: { align: "right" }, cell: pct() },
  breakout_score: {
    header: "Breakout", accessorKey: "breakout_score", meta: { align: "right" },
    cell: ({ row }) => <ScoreBadge score={row.original.breakout_score} components={row.original.score_components?.breakout} label="breakout components" />,
  },
  prebreakout_score: {
    header: "Pre-BO", accessorKey: "prebreakout_score", meta: { align: "right" },
    cell: ({ row }) => <ScoreBadge score={row.original.prebreakout_score} components={row.original.score_components?.prebreakout} label="pre-breakout components" />,
  },
  setup: {
    header: "Setup", id: "setup", enableSorting: false,
    cell: ({ row }) => (
      <span style={{ display: "flex", gap: 4 }}>
        {row.original.bb_squeeze && <Chip tone="accent">squeeze</Chip>}
        {row.original.higher_lows && <Chip tone="ok">HL</Chip>}
        {row.original.near_resistance && <Chip tone="warn">@res</Chip>}
        {row.original.above_ema_200 && <Chip tone="ok">&gt;200</Chip>}
      </span>
    ),
  },
  // fundamental
  market_cap: { header: "Mcap (Cr)", accessorKey: "market_cap", meta: { align: "right" }, cell: ({ getValue }) => fmtInt(getValue() as number | null) },
  pe: { header: "PE", accessorKey: "pe", meta: { align: "right" }, cell: num(1) },
  pb: { header: "PB", accessorKey: "pb", meta: { align: "right" }, cell: num(1) },
  peg: { header: "PEG", accessorKey: "peg", meta: { align: "right" }, cell: num(2) },
  eps: { header: "EPS", accessorKey: "eps", meta: { align: "right" }, cell: num(1) },
  roe: { header: "ROE", accessorKey: "roe", meta: { align: "right" }, cell: pctSuffix(1) },
  roce: { header: "ROCE", accessorKey: "roce", meta: { align: "right" }, cell: pctSuffix(1) },
  debt_equity: { header: "D/E", accessorKey: "debt_equity", meta: { align: "right" }, cell: num(2) },
  sales_growth: { header: "Rev Grw", accessorKey: "sales_growth", meta: { align: "right" }, cell: pct() },
  profit_growth: { header: "PAT Grw", accessorKey: "profit_growth", meta: { align: "right" }, cell: pct() },
  dividend_yield: { header: "Div Yld", accessorKey: "dividend_yield", meta: { align: "right" }, cell: pctSuffix(2) },
  promoter_holding: { header: "Promoter %", accessorKey: "promoter_holding", meta: { align: "right" }, cell: pctSuffix(1) },
};

export default function StockTable() {
  const nav = useNavigate();
  const [universe, setUniverse] = useState<UniverseId>("all");
  const [view, setView] = useState<View>("technical");
  const [q, setQ] = useState("");

  const { data: rows = [], isFetching, error } = useScreenerData(universe);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) =>
      r.symbol.toLowerCase().includes(term) ||
      (r.company_name?.toLowerCase().includes(term) ?? false) ||
      (r.sector?.toLowerCase().includes(term) ?? false));
  }, [rows, q]);

  const columns = useMemo<ColumnDef<ScreenerRow, any>[]>(() => {
    const ids = view === "technical" ? [...IDENTITY, ...TECHNICAL]
      : view === "fundamental" ? [...IDENTITY, ...FUNDAMENTAL]
      : [...IDENTITY, ...TECHNICAL, ...FUNDAMENTAL];
    return ids.map((id) => COLS[id]).filter(Boolean);
  }, [view]);

  const initialSort = view === "fundamental"
    ? [{ id: "market_cap", desc: true }]
    : [{ id: "breakout_score", desc: true }];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel
        flow
        title="All Stocks · Technicals & Fundamentals"
        index="MK.STK"
        live={isFetching ? "warn" : error ? "err" : "ok"}
        actions={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ display: "flex", gap: 4 }}>
              {VIEWS.map((v) => (
                <button key={v.id} className="hud-btn" data-variant={view === v.id ? "primary" : "ghost"} data-size="sm" onClick={() => setView(v.id)}>
                  {v.label}
                </button>
              ))}
            </div>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search symbol / sector…"
              style={{ ...inputStyle, padding: "6px 8px", fontSize: 11, width: 180 }} />
          </div>
        }
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <div>
            <div style={labelStyle}>Universe</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {UNIVERSES.map((u) => (
                <button key={u.id} onClick={() => setUniverse(u.id)}
                  className="hud-btn" data-variant={universe === u.id ? "primary" : "ghost"} data-size="sm">
                  {u.label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ marginLeft: "auto", fontFamily: "var(--font-hud)", fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.16em", textTransform: "uppercase" }}>
            {isFetching ? "loading…" : `${filtered.length} of ${rows.length} stocks`}
          </div>
        </div>
      </HudPanel>

      <HudPanel flow title="Stocks" index="MK.STK.T" live={isFetching ? "warn" : error ? "err" : "ok"}>
        {error ? (
          <EmptyState hint={String((error as Error).message)}>failed to load</EmptyState>
        ) : (
          <DataTable
            columns={columns}
            data={filtered}
            onRowClick={(r) => nav(`/market/analysis/${r.symbol}`)}
            initialSort={initialSort}
            emptyLabel={rows.length === 0 && !isFetching ? "market pipeline is warming up" : "no matches"}
            emptyHint={rows.length === 0 && !isFetching ? "automatic sync is enabled; refresh shortly" : "clear the search or change the universe"}
          />
        )}
      </HudPanel>
    </div>
  );
}
