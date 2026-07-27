// Shared column registry for market screener-style tables.
// Used by /market/screener (results grid) and /market/ (Overview → Top Breakouts)
// so a saved screener renders the same columns in both places — minus columns
// that don't carry a meaningful numeric/text value (boolean filters like
// "Volume > 30D Avg Volume" show Yes/No which is redundant with the chip).
import type { ColumnDef } from "@tanstack/react-table";
import { fmtInt, fmtNum, PctCell, Return1DCell, deriveChangeAbs } from "../../components/hud/DataTable";
import { ScoreBadge } from "../../components/market/ScoreBadge";
import { AddToWatchlistButton } from "../../components/market/AddToWatchlistButton";
export { FILTER_TO_COL, colsFromActiveFilters, type ColsFromFiltersOpts } from "./screenerColumnModel";

/** Basic column defs suitable for the Overview widget. Headers/formatting mirror
 *  the Screener table so saved screens have the same visible result shape. */
export function overviewColumnMap<TRow extends Record<string, any>>(onScoreClick?: (symbol: string) => void): Record<string, ColumnDef<TRow, any>> {
  return {
    symbol: {
      header: "Stock", accessorKey: "symbol",
      cell: ({ row }: any) => (
        <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 1.2 }}>
          <span style={{ color: "var(--text)", fontWeight: 500 }}>{row.original.company_name ?? row.original.symbol}</span>
          <span style={{ color: "var(--accent)", fontSize: 10 }}>{row.original.symbol}</span>
        </span>
      ),
    },
    sector: { header: "Sector", accessorKey: "sector", cell: ({ getValue }: any) => <span style={{ fontSize: 11 }}>{(getValue() as string) ?? "—"}</span> },
    industry: { header: "Industry", accessorKey: "industry", cell: ({ getValue }: any) => <span style={{ fontSize: 11 }}>{(getValue() as string) ?? "—"}</span> },
    market_cap: {
      header: "Mcap (₹Cr)", accessorKey: "market_cap", meta: { align: "right" } as any,
      cell: ({ getValue }: any) => fmtInt(getValue() as number | null),
    },
    close: {
      id: "close", header: "LTP (₹)", meta: { align: "right" } as any,
      accessorFn: (r: any) => r.ltp ?? r.close ?? null,
      cell: ({ getValue }: any) => fmtNum(getValue() as number | null),
    },
    change_pct: {
      header: "1D Return", accessorKey: "change_pct", meta: { align: "right" } as any,
      cell: ({ row }: any) => {
        const r = row.original;
        const abs = r.change_abs ?? deriveChangeAbs(r.ltp ?? r.close ?? null, r.change_pct ?? null);
        return <Return1DCell abs={abs} pct={r.change_pct ?? null} />;
      },
    },
    volume:      { header: "Volume",     accessorKey: "volume",           meta: { align: "right" } as any, cell: ({ getValue }: any) => fmtInt(getValue() as number | null) },
    vol_avg30:   { header: "30D Avg Vol",accessorKey: "vol_avg30",        meta: { align: "right" } as any, cell: ({ getValue }: any) => fmtInt(getValue() as number | null) },
    rel_volume:  { header: "RVol",       accessorKey: "rel_volume",       meta: { align: "right" } as any, cell: ({ getValue }: any) => fmtNum(getValue() as number | null, 1) },
    pe:  { header: "PE",  accessorKey: "pe",  meta: { align: "right" } as any, cell: ({ getValue }: any) => fmtNum(getValue() as number | null, 1) },
    pb:  { header: "PB",  accessorKey: "pb",  meta: { align: "right" } as any, cell: ({ getValue }: any) => fmtNum(getValue() as number | null, 1) },
    peg: { header: "PEG", accessorKey: "peg", meta: { align: "right" } as any, cell: ({ getValue }: any) => fmtNum(getValue() as number | null, 2) },
    eps: { header: "EPS", accessorKey: "eps", meta: { align: "right" } as any, cell: ({ getValue }: any) => fmtNum(getValue() as number | null, 1) },
    book_value: { header: "Book Val", accessorKey: "book_value", meta: { align: "right" } as any, cell: ({ getValue }: any) => fmtNum(getValue() as number | null, 1) },
    roe:  { header: "ROE",  accessorKey: "roe",  meta: { align: "right" } as any, cell: ({ getValue }: any) => { const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(1)}%`; } },
    roce: { header: "ROCE", accessorKey: "roce", meta: { align: "right" } as any, cell: ({ getValue }: any) => { const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(1)}%`; } },
    debt_equity: { header: "D/E", accessorKey: "debt_equity", meta: { align: "right" } as any, cell: ({ getValue }: any) => fmtNum(getValue() as number | null, 2) },
    sales_growth:  { header: "Rev Grw", accessorKey: "sales_growth",  meta: { align: "right" } as any, cell: ({ getValue }: any) => <PctCell value={getValue() as number | null} /> },
    profit_growth: { header: "PAT Grw", accessorKey: "profit_growth", meta: { align: "right" } as any, cell: ({ getValue }: any) => <PctCell value={getValue() as number | null} /> },
    eps_growth:    { header: "EPS Grw", accessorKey: "eps_growth",    meta: { align: "right" } as any, cell: ({ getValue }: any) => <PctCell value={getValue() as number | null} /> },
    dividend_yield:        { header: "Div Yld",    accessorKey: "dividend_yield",        meta: { align: "right" } as any, cell: ({ getValue }: any) => { const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(2)}%`; } },
    promoter_holding:      { header: "Promoter %", accessorKey: "promoter_holding",      meta: { align: "right" } as any, cell: ({ getValue }: any) => { const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(1)}%`; } },
    dii_holding:           { header: "DII %",      accessorKey: "dii_holding",           meta: { align: "right" } as any, cell: ({ getValue }: any) => { const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(1)}%`; } },
    fii_holding:           { header: "FII %",      accessorKey: "fii_holding",           meta: { align: "right" } as any, cell: ({ getValue }: any) => { const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(1)}%`; } },
    institutional_holding: { header: "Instl % (D+F)", accessorKey: "institutional_holding", meta: { align: "right" } as any, cell: ({ getValue }: any) => { const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(1)}%`; } },
    rsi: { header: "RSI", accessorKey: "rsi", meta: { align: "right" } as any, cell: ({ getValue }: any) => fmtNum(getValue() as number | null, 0) },
    adx: { header: "ADX", accessorKey: "adx", meta: { align: "right" } as any, cell: ({ getValue }: any) => fmtNum(getValue() as number | null, 0) },
    pct_from_52w_high: { header: "52w Δ", accessorKey: "pct_from_52w_high", meta: { align: "right" } as any, cell: ({ getValue }: any) => <PctCell value={getValue() as number | null} /> },
    ret_5d:  { header: "5D %",  accessorKey: "ret_5d",  meta: { align: "right" } as any, cell: ({ getValue }: any) => <PctCell value={getValue() as number | null} /> },
    ret_21d: { header: "1M %",  accessorKey: "ret_21d", meta: { align: "right" } as any, cell: ({ getValue }: any) => <PctCell value={getValue() as number | null} /> },
    ret_ytd: { header: "YTD %", accessorKey: "ret_ytd", meta: { align: "right" } as any, cell: ({ getValue }: any) => <PctCell value={getValue() as number | null} /> },
    breakout_score: {
      header: "Breakout", accessorKey: "breakout_score", meta: { align: "right" } as any,
      cell: ({ row }: any) => <ScoreBadge score={row.original.breakout_score} components={row.original.score_components?.breakout} label="breakout components" provisional={row.original.context_complete === false} onClick={onScoreClick ? () => onScoreClick(row.original.symbol) : undefined} />,
    },
    prebreakout_score: {
      header: "Pre-BO", accessorKey: "prebreakout_score", meta: { align: "right" } as any,
      cell: ({ row }: any) => <ScoreBadge score={row.original.prebreakout_score} components={row.original.score_components?.prebreakout} label="pre-breakout components" provisional={row.original.context_complete === false} onClick={onScoreClick ? () => onScoreClick(row.original.symbol) : undefined} />,
    },
    actions: {
      id: "actions", header: "", enableSorting: false, meta: { align: "right" } as any,
      cell: ({ row }: any) => (
        <AddToWatchlistButton
          symbol={row.original.symbol}
          exchange={(row.original.exchange as "NSE" | "BSE") ?? "NSE"}
        />
      ),
    },
  };
}

export const OVERVIEW_COL_IDS = new Set(Object.keys(overviewColumnMap()));
