// Dense, sortable HUD-styled table on @tanstack/react-table.
import { useState, type CSSProperties } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
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
  emptyLabel = "no data",
  emptyHint,
  maxHeight,
}: {
  columns: ColumnDef<T, any>[];
  data: T[];
  onRowClick?: (row: T) => void;
  initialSort?: SortingState;
  emptyLabel?: string;
  emptyHint?: string;
  maxHeight?: number | string;
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSort ?? []);
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (data.length === 0) return <EmptyState hint={emptyHint}>{emptyLabel}</EmptyState>;

  return (
    <div style={{ overflow: "auto", minHeight: 0, flex: "1 1 auto", maxHeight: maxHeight ?? "70vh" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
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
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              onClick={onRowClick ? () => onRowClick(row.original) : undefined}
              style={{ cursor: onRowClick ? "pointer" : undefined }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(53,214,237,0.05)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
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

export const fmtPct = (v: number | null | undefined, digits = 2): string =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;

export function PctCell({ value }: { value: number | null | undefined }) {
  if (value == null) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  return (
    <span style={{ color: value > 0 ? "var(--ok)" : value < 0 ? "var(--danger)" : "var(--text-dim)" }}>
      {fmtPct(value)}
    </span>
  );
}
