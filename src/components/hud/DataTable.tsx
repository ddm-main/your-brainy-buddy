// Dense, sortable HUD-styled table on @tanstack/react-table.
import { useState, type CSSProperties } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type OnChangeFn,
} from "@tanstack/react-table";
import { EmptyState } from "@/components/hud/HudControls";

const thStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  background: "var(--bg-panel)",
  fontFamily: "var(--font-hud)",
  fontSize: 9,
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: "var(--accent-soft)",
  textAlign: "left",
  padding: "6px 8px",
  borderBottom: "1px solid var(--edge-strong)",
  cursor: "pointer",
  userSelect: "none",
  whiteSpace: "nowrap",
  zIndex: 1,
};

export function DataTable<T>({
  columns,
  data,
  onRowClick,
  initialSort,
  sorting: controlledSorting,
  onSortingChange,
  emptyLabel = "no data",
  emptyHint,
  maxHeight,
  numbered,
  startIndex = 0,
}: {
  columns: ColumnDef<T, any>[];
  data: T[];
  onRowClick?: (row: T) => void;
  initialSort?: SortingState;
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  emptyLabel?: string;
  emptyHint?: string;
  maxHeight?: number | string;
  /** Render a leading "#" column with 1-based row numbers. */
  numbered?: boolean;
  /** Zero-based offset for `numbered` (e.g. pageStart when paginated). */
  startIndex?: number;
}) {
  const [internalSorting, setInternalSorting] = useState<SortingState>(initialSort ?? []);
  const sorting = controlledSorting ?? internalSorting;
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: onSortingChange ?? setInternalSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    // Stable row identity so react-table reuses row objects across ticks —
    // otherwise every push-flush re-render allocates fresh row instances,
    // defeating any downstream cell memoization.
    getRowId: (row: any, index) =>
      (row?.key ?? row?.symbol ?? row?.id ?? String(index)) as string,
  });

  if (data.length === 0) return <EmptyState hint={emptyHint}>{emptyLabel}</EmptyState>;

  return (
    <div style={{ overflow: "auto", minHeight: 0, flex: "1 1 auto", maxHeight: maxHeight ?? "70vh" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {numbered && (
                <th style={{ ...thStyle, textAlign: "right", width: 36 }}>#</th>
              )}
              {hg.headers.map((h) => {
                const sorted = h.column.getIsSorted();
                const align = (h.column.columnDef.meta as any)?.align ?? "left";
                return (
                  <th
                    key={h.id}
                    onClick={h.column.getToggleSortingHandler()}
                    style={{ ...thStyle, textAlign: align }}
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {sorted && (
                      <span style={{ color: "var(--accent)", marginLeft: 4 }}>
                        {sorted === "asc" ? "▲" : "▼"}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row, idx) => (
            <tr
              key={row.id}
              onClick={onRowClick ? () => onRowClick(row.original) : undefined}
              style={{ cursor: onRowClick ? "pointer" : undefined }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(53,214,237,0.05)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              {numbered && (
                <td style={{
                  padding: "5px 8px",
                  borderBottom: "1px solid var(--edge)",
                  color: "var(--text-muted)",
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                  fontSize: 11,
                }}>{startIndex + idx + 1}</td>
              )}
              {row.getVisibleCells().map((cell) => {
                const align = (cell.column.columnDef.meta as any)?.align ?? "left";
                return (
                  <td
                    key={cell.id}
                    style={{
                      padding: "5px 8px",
                      borderBottom: "1px solid var(--edge)",
                      color: "var(--text)",
                      textAlign: align,
                      whiteSpace: "nowrap",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Formatting helpers shared by market tables
export const fmtNum = (v: number | null | undefined, digits = 2): string =>
  v == null || Number.isNaN(v) ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits });

export const fmtInt = (v: number | null | undefined): string =>
  v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: 0 });

// `signed` controls the leading "+" for non-negative values. Change % and
// return metrics benefit from the sign; yields, "% from 52w high" and other
// naturally single-signed values look odd with a "+" so pass `false`.
export const fmtPct = (v: number | null | undefined, digits = 2, signed = true): string =>
  v == null ? "—" : `${signed && v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;

export function PctCell({ value }: { value: number | null | undefined }) {
  if (value == null) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  return (
    <span style={{ color: value > 0 ? "var(--ok)" : value < 0 ? "var(--danger)" : "var(--text-dim)" }}>
      {fmtPct(value)}
    </span>
  );
}

// Unified "1D return" cell used everywhere day-change is surfaced:
//   +3.14 (+8.83%)   —abs and pct shown together (screener-parity).
// Falls back to whichever value is available; renders "—" when neither is.
// Sign/colour is driven by pct when present, otherwise by abs.
export function Return1DCell({ abs, pct, compact = false }: { abs: number | null | undefined; pct: number | null | undefined; compact?: boolean }) {
  const absOk = abs != null && Number.isFinite(abs);
  const pctOk = pct != null && Number.isFinite(pct);
  if (!absOk && !pctOk) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const sign = pctOk ? (pct as number) : (abs as number);
  const color = sign > 0 ? "var(--ok)" : sign < 0 ? "var(--danger)" : "var(--text-dim)";
  const absTxt = absOk ? `${(abs as number) >= 0 ? "+" : "−"}${Math.abs(abs as number).toFixed(2)}` : null;
  const pctTxt = pctOk ? `${(pct as number) >= 0 ? "+" : "−"}${Math.abs(pct as number).toFixed(2)}%` : null;
  return (
    <span style={{ color, whiteSpace: "nowrap" }}>
      {absTxt ?? pctTxt}
      {absTxt && pctTxt ? `${compact ? "" : " "}(${pctTxt})` : ""}
    </span>
  );
}

// Derive the absolute rupee day-change from an ltp + change_pct pair when the
// raw abs isn't in the payload (live-tick overlays, top-mover view, etc.):
//   abs = ltp * pct / (100 + pct)
// Returns null when either input is missing or the denominator collapses.
export function deriveChangeAbs(ltp: number | null | undefined, pct: number | null | undefined): number | null {
  if (ltp == null || !Number.isFinite(ltp) || pct == null || !Number.isFinite(pct)) return null;
  const denom = 100 + pct;
  if (Math.abs(denom) < 1e-6) return null;
  return (ltp * pct) / denom;
}
