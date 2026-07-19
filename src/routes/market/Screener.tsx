// Stock Screener — Tickertape/Screener.in-style 2-pane layout.
// Left rail: collapsible filter categories with search & data-coverage chips.
// Right pane: query chips → results grid with coverage note, pagination & CSV.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { DataTable, fmtInt, fmtNum, PctCell } from "@/components/hud/DataTable";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { HistogramSlider } from "@/components/market/HistogramSlider";
import { useSavedScreeners, useScreenerMutations } from "@/lib/market/hooks";
import { useScreenerData, useScreenerSectors, useScreenerIndustries, type ScreenerRow } from "@/lib/market/screenerRun";
import { useUi } from "@/store/uiStore";
import { supabase } from "@/integrations/supabase/client";
import type { SavedScreener } from "@/lib/market/types";
import { COLUMN_PRESETS } from "@/lib/market/columnPresets";
import {
  CATEGORIES,
  FILTERS,
  FILTER_BY_ID,
  PRESETS,
  UNIVERSES,
  CAP_TIERS,
  filterMatches,
  coverageOf,
  type ActiveFilter,
  type FilterCategory,
  type FilterDef,
  type UniverseId,
} from "@/lib/market/screenerCatalog";
import { Check, ChevronDown, ChevronRight, Database, Download, RotateCcw, Save, Search, Sparkles, X } from "lucide-react";

// ---- Columns ----
interface ColSpec { id: string; label: string; align?: "right" | "left"; default?: boolean }
const COLUMNS: ColSpec[] = [
  { id: "symbol",             label: "Symbol",       default: true },
  { id: "sector",             label: "Sector",       default: true },
  { id: "industry",           label: "Industry" },
  { id: "market_cap",         label: "Mcap (Cr)",     align: "right", default: true },
  { id: "close",              label: "Price",         align: "right", default: true },
  { id: "change_pct",         label: "Chg %",         align: "right", default: true },
  { id: "volume",             label: "Volume",        align: "right" },
  { id: "rel_volume",         label: "RVol",          align: "right" },
  { id: "pe_ttm",             label: "PE",            align: "right", default: true },
  { id: "pb",                 label: "PB",            align: "right" },
  { id: "peg",                label: "PEG",           align: "right" },
  { id: "eps_ttm",            label: "EPS",           align: "right" },
  { id: "book_value",         label: "Book Val",      align: "right" },
  { id: "roe",                label: "ROE",           align: "right", default: true },
  { id: "debt_to_equity",     label: "D/E",           align: "right", default: true },
  { id: "revenue_growth_yoy", label: "Rev Grw",       align: "right" },
  { id: "profit_growth_yoy",  label: "PAT Grw",       align: "right" },
  { id: "eps_growth_yoy",     label: "EPS Grw",       align: "right" },
  { id: "dividend_yield",     label: "Div Yld",       align: "right" },
  { id: "promoter_holding",   label: "Promoter %",    align: "right" },
  { id: "dii_holding",        label: "Instl %",       align: "right" },
  { id: "rsi14",              label: "RSI",           align: "right" },
  { id: "adx14",              label: "ADX",           align: "right" },
  { id: "pct_from_52w_high",  label: "52w Δ",         align: "right", default: true },
  { id: "breakout_score",     label: "Breakout",      align: "right", default: true },
  { id: "prebreakout_score",  label: "Pre-BO",        align: "right" },
  { id: "setup",              label: "Setup" },
];
const DEFAULT_COLS = COLUMNS.filter((c) => c.default).map((c) => c.id);
const COLS_STORE_KEY = "screener.visibleCols.v2";
const OPEN_STORE_KEY = "screener.openCats.v2";
const PAGE_SIZE_KEY  = "screener.pageSize.v2";
const AUTO_SYNC_STORE_KEY = "screener.autoFundamentalsSyncAt.v1";

function fmtBound(def: FilterDef, v: number | "" | undefined): string {
  if (v === undefined || v === "") return "*";
  const digits = def.step && def.step < 1 ? 2 : 0;
  const num = Number(v).toLocaleString("en-IN", { maximumFractionDigits: digits });
  return def.unit ? (def.unit === "₹" ? `₹${num}` : `${num}${def.unit === "%" || def.unit === "x" ? def.unit : " " + def.unit}`) : num;
}

function chipDesc(af: ActiveFilter): string {
  const def = FILTER_BY_ID[af.id];
  if (!def) return af.id;
  if (def.kind === "boolean") return af.bool === undefined ? def.label : `${def.label}: ${af.bool ? "yes" : "no"}`;
  if (def.kind === "enum")    return af.values && af.values.length ? `${def.label}: ${af.values.length} sel` : def.label;
  const lo = af.min !== undefined && af.min !== "" ? fmtBound(def, af.min) : null;
  const hi = af.max !== undefined && af.max !== "" ? fmtBound(def, af.max) : null;
  if (!lo && !hi) return def.label;
  return `${def.label} ${lo ?? "*"}–${hi ?? "*"}`;
}

function toCsv(rows: ScreenerRow[], cols: string[]): string {
  const header = cols.map((c) => COLUMNS.find((x) => x.id === c)?.label ?? c);
  const body = rows.map((r) => cols.map((c) => {
    if (c === "setup") {
      const tags: string[] = [];
      if (r.bb_squeeze) tags.push("squeeze");
      if (r.higher_lows) tags.push("HL");
      if (r.near_resistance) tags.push("@res");
      return tags.join("|");
    }
    const v = (r as any)[c];
    if (v == null) return "";
    if (typeof v === "string") return v.includes(",") ? `"${v.replace(/"/g, '""')}"` : v;
    return String(v);
  }));
  return [header, ...body].map((row) => row.join(",")).join("\n");
}

export default function Screener() {
  const push = useUi((s) => s.push);
  const nav = useNavigate();

  const [universe, setUniverse] = useState<UniverseId>("all");
  const [active, setActive] = useState<ActiveFilter[]>([]);
  const [visibleCols, setVisibleCols] = useState<string[]>(() => {
    try { const raw = localStorage.getItem(COLS_STORE_KEY); if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) return p; } } catch { /* */ }
    return DEFAULT_COLS;
  });
  useEffect(() => { try { localStorage.setItem(COLS_STORE_KEY, JSON.stringify(visibleCols)); } catch { /* */ } }, [visibleCols]);

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(() => {
    try { return Number(localStorage.getItem(PAGE_SIZE_KEY)) || 50; } catch { return 50; }
  });
  useEffect(() => { try { localStorage.setItem(PAGE_SIZE_KEY, String(pageSize)); } catch { /* */ } }, [pageSize]);

  const { data: rows = [], isFetching, error } = useScreenerData(universe);
  const sectorList = useScreenerSectors(rows);
  const industryList = useScreenerIndustries(rows);
  const { data: saved = [] } = useSavedScreeners();
  const { save, remove } = useScreenerMutations();

  const filtered = useMemo(() => {
    let out: ScreenerRow[] = rows;
    for (const af of active) out = out.filter((r) => filterMatches(r as any, af));
    return out;
  }, [rows, active]);

  useEffect(() => { setPage(0); }, [active, universe, pageSize]);

  // ---- URL-serialized state (Phase 6): ?f=<b64(JSON)> — shareable screens ----
  const didHydrateFromUrlRef = useRef(false);
  useEffect(() => {
    if (didHydrateFromUrlRef.current) return;
    didHydrateFromUrlRef.current = true;
    try {
      const p = new URLSearchParams(window.location.search).get("f");
      if (!p) return;
      const raw = decodeURIComponent(escape(atob(decodeURIComponent(p))));
      const parsed = JSON.parse(raw);
      if (parsed?.universe) setUniverse(parsed.universe as UniverseId);
      if (Array.isArray(parsed?.active)) setActive(parsed.active);
    } catch { /* ignore malformed */ }
  }, []);
  useEffect(() => {
    if (!didHydrateFromUrlRef.current) return;
    try {
      const payload = JSON.stringify({ universe, active });
      const b64 = btoa(unescape(encodeURIComponent(payload)));
      const url = new URL(window.location.href);
      if (active.length === 0 && universe === "all") url.searchParams.delete("f");
      else url.searchParams.set("f", b64);
      window.history.replaceState(null, "", url.toString());
    } catch { /* */ }
  }, [universe, active]);
  const shareLink = () => {
    try {
      navigator.clipboard?.writeText(window.location.href);
      push("Share link copied", "ok");
    } catch { push("Copy failed", "err"); }
  };


  const addFilter = (fid: string) => {
    if (active.some((a) => a.id === fid)) { push("Filter already added", "warn"); return; }
    const def = FILTER_BY_ID[fid]; if (!def) return;
    const initial: ActiveFilter =
      def.kind === "boolean" ? { id: fid, bool: true } :
      def.kind === "enum"    ? { id: fid, values: [] } :
      { id: fid };
    setActive((a) => [...a, initial]);
  };
  const updateFilter = (fid: string, patch: Partial<ActiveFilter>) =>
    setActive((a) => a.map((af) => af.id === fid ? { ...af, ...patch } : af));
  const removeFilter = (fid: string) => setActive((a) => a.filter((af) => af.id !== fid));

  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id); if (!p) return;
    setActive(p.filters);
    if (p.universe) setUniverse(p.universe);
    push(`Loaded preset: ${p.name}`, "ok");
  };

  const [saveName, setSaveName] = useState("");
  const saveScreener = () => {
    if (!saveName.trim()) { push("Name the screener first", "warn"); return; }
    save.mutate(
      { name: saveName.trim(), filters: { v: 3, universe, active } as any },
      { onSuccess: () => { push("Screener saved", "ok"); setSaveName(""); }, onError: (e) => push(e.message, "err") }
    );
  };
  const loadSaved = (s: SavedScreener) => {
    const f: any = s.filters;
    if (f && typeof f === "object" && !Array.isArray(f) && (f.v === 2 || f.v === 3)) {
      setUniverse((f.universe as UniverseId) ?? "all");
      setActive(Array.isArray(f.active) ? f.active : []);
    } else if (Array.isArray(f)) {
      const conds = f[0]?.conditions ?? [];
      const mapped: ActiveFilter[] = [];
      for (const c of conds) {
        if (!FILTER_BY_ID[c.column]) continue;
        const isBool = FILTER_BY_ID[c.column].kind === "boolean";
        if (isBool) mapped.push({ id: c.column, bool: c.op === "is_true" });
        else if (c.op === "gte" || c.op === "gt") mapped.push({ id: c.column, min: Number(c.value) });
        else if (c.op === "lte" || c.op === "lt") mapped.push({ id: c.column, max: Number(c.value) });
        else if (c.op === "eq") mapped.push({ id: c.column, min: Number(c.value), max: Number(c.value) });
      }
      setActive(mapped); setUniverse("all");
    }
    push(`Loaded: ${s.name}`, "ok");
  };

  const exportCsv = () => {
    const csv = toCsv(filtered, visibleCols);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `screener_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const columns = useMemo<ColumnDef<ScreenerRow, any>[]>(() => {
    const all: Record<string, ColumnDef<ScreenerRow, any>> = {
      symbol: {
        header: "Symbol", accessorKey: "symbol",
        cell: ({ row }) => (
          <span>
            <span style={{ color: "var(--accent)" }}>{row.original.symbol}</span>
            {row.original.company_name && (
              <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 10 }}>{row.original.company_name}</span>
            )}
          </span>
        ),
      },
      sector:  { header: "Sector",  accessorKey: "sector",  cell: ({ getValue }) => <span style={{ fontSize: 11 }}>{getValue() as string ?? "—"}</span> },
      industry:{ header: "Industry",accessorKey: "industry",cell: ({ getValue }) => <span style={{ fontSize: 11 }}>{getValue() as string ?? "—"}</span> },
      market_cap: { header: "Mcap (Cr)", accessorKey: "market_cap", meta: { align: "right" }, cell: ({ getValue }) => fmtInt(getValue() as number | null) },
      close: { header: "Price", accessorKey: "close", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null) },
      change_pct: { header: "Chg %", accessorKey: "change_pct", meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue() as number | null} /> },
      volume: { header: "Vol", accessorKey: "volume", meta: { align: "right" }, cell: ({ getValue }) => fmtInt(getValue() as number | null) },
      rel_volume: { header: "RVol", accessorKey: "rel_volume", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 1) },
      pe_ttm: { header: "PE", accessorKey: "pe_ttm", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 1) },
      pb: { header: "PB", accessorKey: "pb", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 1) },
      peg: { header: "PEG", accessorKey: "peg", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 2) },
      eps_ttm: { header: "EPS", accessorKey: "eps_ttm", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 1) },
      book_value: { header: "Book Val", accessorKey: "book_value", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 1) },
      roe: { header: "ROE", accessorKey: "roe", meta: { align: "right" }, cell: ({ getValue }) => {
        const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(1)}%`;
      }},
      debt_to_equity: { header: "D/E", accessorKey: "debt_to_equity", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 2) },
      revenue_growth_yoy: { header: "Rev Grw", accessorKey: "revenue_growth_yoy", meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue() as number | null} /> },
      profit_growth_yoy:  { header: "PAT Grw", accessorKey: "profit_growth_yoy",  meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue() as number | null} /> },
      eps_growth_yoy:     { header: "EPS Grw", accessorKey: "eps_growth_yoy",     meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue() as number | null} /> },
      dividend_yield: { header: "Div Yld", accessorKey: "dividend_yield", meta: { align: "right" }, cell: ({ getValue }) => {
        const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(2)}%`;
      }},
      promoter_holding: { header: "Promoter %", accessorKey: "promoter_holding", meta: { align: "right" }, cell: ({ getValue }) => {
        const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(1)}%`;
      }},
      dii_holding: { header: "Instl %", accessorKey: "dii_holding", meta: { align: "right" }, cell: ({ getValue }) => {
        const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(1)}%`;
      }},
      rsi14: { header: "RSI", accessorKey: "rsi14", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 0) },
      adx14: { header: "ADX", accessorKey: "adx14", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 0) },
      pct_from_52w_high: { header: "52w Δ", accessorKey: "pct_from_52w_high", meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue() as number | null} /> },
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
          </span>
        ),
      },
    };
    return visibleCols.map((id) => all[id]).filter(Boolean);
  }, [visibleCols]);

  // Paginate visible rows client-side.
  const pageStart = page * pageSize;
  const paged = useMemo(() => filtered.slice(pageStart, pageStart + pageSize), [filtered, pageStart, pageSize]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Top bar */}
      <HudPanel flow title="Screener" index="MK.SC0"
        actions={
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <PresetPicker onPick={applyPreset} rows={rows} />
            <SavedPicker saved={saved} onLoad={loadSaved} onDelete={(id) => remove.mutate(id, { onError: (e) => push(e.message, "err") })} />
            <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="save as…"
              style={{ ...inputStyle, padding: "6px 8px", fontSize: 11, width: 130 }} />
            <Btn size="sm" onClick={saveScreener}><Save size={11} style={{ marginRight: 4 }} />Save</Btn>
            <Btn size="sm" onClick={shareLink} title="Copy shareable link">Share</Btn>
            {active.length > 0 && (
              <Btn size="sm" variant="danger" onClick={() => setActive([])}>
                <RotateCcw size={11} style={{ marginRight: 4 }} />Reset
              </Btn>
            )}
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
        <DataHealthStrip rows={rows} />
      </HudPanel>

      {/* Two-pane workspace */}
      <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 12, alignItems: "start" }}>
        <FilterRail rows={rows} active={active} onAdd={addFilter} sectorList={sectorList} industryList={industryList} />

        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          {/* Active filters (query chips + editors) */}
          <HudPanel flow title="Query" index="MK.SC1">
            {active.length === 0 ? (
              <EmptyState hint="pick a preset or add filters from the left rail">no filters yet</EmptyState>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {active.map((af) => (
                  <FilterRow key={af.id} af={af} rows={rows} sectorList={sectorList} industryList={industryList}
                    onUpdate={(patch) => updateFilter(af.id, patch)} onRemove={() => removeFilter(af.id)} />
                ))}
              </div>
            )}
          </HudPanel>

          {/* Results */}
          <HudPanel flow title={`Results · ${filtered.length}${filtered.length !== rows.length ? ` of ${rows.length}` : ""}`}
            index="MK.SC2" live={isFetching ? "warn" : error ? "err" : "ok"}
            actions={
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <ColumnPresetPicker onPick={setVisibleCols} />
                <ColumnPicker value={visibleCols} onChange={setVisibleCols} />
                <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}
                  style={{ ...inputStyle, padding: "4px 6px", fontSize: 11 }}>
                  {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}/page</option>)}
                </select>
                <Btn size="sm" onClick={exportCsv} disabled={filtered.length === 0}>
                  <Download size={11} style={{ marginRight: 4 }} />CSV
                </Btn>
              </div>
            }
          >
            {error ? (
              <EmptyState hint={String((error as Error).message)}>failed to load</EmptyState>
            ) : (
              <>
                <DataTable
                  columns={columns}
                  data={paged}
                  onRowClick={(r) => nav(`/market/analysis/${r.symbol}`)}
                  initialSort={[{ id: "breakout_score", desc: true }]}
                  emptyLabel={rows.length === 0 && !isFetching ? "market pipeline is warming up" : "no matches"}
                  emptyHint={rows.length === 0 && !isFetching ? "automatic sync is enabled; refresh shortly" : "loosen the filters or change the universe"}
                />
                {/* Coverage note */}
                {active.length > 0 && rows.length > 0 && (
                  <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    <span style={{ fontFamily: "var(--font-hud)", fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.16em", textTransform: "uppercase" }}>Data coverage</span>
                    {active.map((af) => {
                      const c = coverageOf(rows as any[], af.id);
                      const pct = c.total ? Math.round((c.has / c.total) * 100) : 0;
                      const tone: "ok" | "warn" | "err" = pct >= 90 ? "ok" : pct >= 50 ? "warn" : "err";
                      const def = FILTER_BY_ID[af.id];
                      return <Chip key={af.id} tone={tone}>{def?.label ?? af.id}: {c.has}/{c.total}</Chip>;
                    })}
                  </div>
                )}
                {/* Pagination */}
                {filtered.length > pageSize && (
                  <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span style={{ fontFamily: "var(--font-hud)", fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.14em" }}>
                      Showing {pageStart + 1}–{Math.min(pageStart + pageSize, filtered.length)} of {filtered.length}
                    </span>
                    <div style={{ display: "flex", gap: 4 }}>
                      <Btn size="sm" onClick={() => setPage(0)} disabled={page === 0}>« First</Btn>
                      <Btn size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>‹ Prev</Btn>
                      <span style={{ padding: "4px 10px", fontFamily: "var(--font-hud)", fontSize: 11, color: "var(--accent)" }}>{page + 1} / {totalPages}</span>
                      <Btn size="sm" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>Next ›</Btn>
                      <Btn size="sm" onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1}>Last »</Btn>
                    </div>
                  </div>
                )}
              </>
            )}
          </HudPanel>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Left rail — collapsible category groups + search + coverage chips
// ============================================================================
function FilterRail({ rows, active, onAdd, sectorList, industryList }: {
  rows: ScreenerRow[]; active: ActiveFilter[]; onAdd: (id: string) => void;
  sectorList: string[]; industryList: string[];
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<FilterCategory, boolean>>(() => {
    try { const raw = localStorage.getItem(OPEN_STORE_KEY); if (raw) return JSON.parse(raw); } catch { /* */ }
    return { basics: true, valuation: true, profitability: true, growth: false, health: false, ownership: false, technicals: true, momentum: false, signals: false };
  });
  useEffect(() => { try { localStorage.setItem(OPEN_STORE_KEY, JSON.stringify(open)); } catch { /* */ } }, [open]);
  const activeIds = new Set(active.map((a) => a.id));
  const term = q.trim().toLowerCase();

  return (
    <HudPanel flow title="Filters" index="MK.SC-R"
      actions={<span style={{ fontFamily: "var(--font-hud)", fontSize: 10, color: "var(--text-muted)" }}>{active.length} active</span>}
    >
      <div style={{ position: "relative", marginBottom: 8 }}>
        <Search size={11} style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search filters…"
          style={{ ...inputStyle, padding: "6px 8px 6px 24px", fontSize: 12, width: "100%" }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: "72vh", overflowY: "auto", paddingRight: 4 }}>
        {CATEGORIES.map((cat) => {
          const inCat = FILTERS.filter((f) => f.category === cat.id && (!term || f.label.toLowerCase().includes(term)));
          if (term && inCat.length === 0) return null;
          const isOpen = term ? true : open[cat.id];
          const activeInCat = FILTERS.filter((f) => f.category === cat.id && activeIds.has(f.id)).length;
          return (
            <div key={cat.id} style={{ borderTop: "1px solid var(--edge)", paddingTop: 4 }}>
              <button onClick={() => setOpen((o) => ({ ...o, [cat.id]: !o[cat.id] }))}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
                         background: "transparent", border: "none", padding: "4px 2px", cursor: "pointer",
                         color: "var(--text)", fontFamily: "var(--font-hud)", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  {cat.label}
                </span>
                {activeInCat > 0 && <Chip tone="accent">{activeInCat}</Chip>}
              </button>
              {isOpen && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingLeft: 4, marginTop: 2 }}>
                  {inCat.map((f) => {
                    const cov = coverageOf(rows as any[], f.id);
                    const pct = cov.total ? Math.round((cov.has / cov.total) * 100) : 0;
                    const covTone: "ok" | "warn" | "err" | undefined = pct >= 90 ? undefined : pct >= 50 ? "warn" : "err";
                    const disabled = activeIds.has(f.id);
                    return (
                      <button key={f.id} disabled={disabled} onClick={() => onAdd(f.id)}
                        title={f.hint}
                        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6,
                                 padding: "4px 6px", background: "transparent", border: "1px solid transparent",
                                 borderRadius: 2, cursor: disabled ? "not-allowed" : "pointer",
                                 opacity: disabled ? 0.4 : 1, color: "var(--text)", textAlign: "left", fontSize: 11 }}
                        onMouseEnter={(e) => !disabled && (e.currentTarget.style.background = "rgba(53,214,237,0.08)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                        <span>{f.label}</span>
                        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                          {rows.length > 0 && f.kind !== "boolean" && covTone && <Chip tone={covTone}>{pct}%</Chip>}
                          {disabled && <Chip tone="ok">✓</Chip>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </HudPanel>
  );
}

// ============================================================================
// Preset / Saved pickers
// ============================================================================
function PresetPicker({ onPick, rows }: { onPick: (id: string) => void; rows: ScreenerRow[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const groups = ["Fundamental", "Technical", "Hybrid"] as const;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <Btn size="sm" onClick={() => setOpen((o) => !o)}>
        <Sparkles size={11} style={{ marginRight: 4 }} />Presets
      </Btn>
      {open && (
        <div style={{ ...popoverStyle, width: 320, maxHeight: 480, overflowY: "auto" }}>
          {groups.map((g) => (
            <div key={g}>
              <div style={{ padding: "4px 8px", fontFamily: "var(--font-hud)", fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.2em", textTransform: "uppercase", borderBottom: "1px solid var(--edge)" }}>{g}</div>
              {PRESETS.filter((p) => p.group === g).map((p) => {
                // Coverage warning if any required col has <50% coverage.
                const missing = (p.requires ?? []).filter((rid) => {
                  const c = coverageOf(rows as any[], rid);
                  return c.total > 0 && c.has / c.total < 0.5;
                });
                return (
                  <button key={p.id} onClick={() => { onPick(p.id); setOpen(false); }}
                    style={{ ...popoverItem, padding: "6px 8px" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(53,214,237,0.08)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                      <div style={{ color: "var(--accent)", fontFamily: "var(--font-hud)", fontSize: 11, letterSpacing: "0.1em" }}>{p.name}</div>
                      {missing.length > 0 && <Chip tone="warn">low data</Chip>}
                    </div>
                    <div style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 2 }}>{p.desc}</div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SavedPicker({ saved, onLoad, onDelete }: {
  saved: SavedScreener[]; onLoad: (s: SavedScreener) => void; onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <Btn size="sm" onClick={() => setOpen((o) => !o)} disabled={saved.length === 0}>
        My Screens · {saved.length}
      </Btn>
      {open && saved.length > 0 && (
        <div style={{ ...popoverStyle, width: 240, maxHeight: 360, overflowY: "auto" }}>
          {saved.map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 6px", borderBottom: "1px solid var(--edge)" }}>
              <button onClick={() => { onLoad(s); setOpen(false); }}
                style={{ flex: 1, background: "none", border: "none", textAlign: "left", cursor: "pointer",
                         color: "var(--accent)", fontFamily: "var(--font-hud)", fontSize: 11, letterSpacing: "0.1em" }}>
                {s.name}
              </button>
              <button onClick={() => onDelete(s.id)} title="Delete"
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}>
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Filter row editor
// ============================================================================
function FilterRow({ af, rows, sectorList, industryList, onUpdate, onRemove }: {
  af: ActiveFilter; rows: ScreenerRow[]; sectorList: string[]; industryList: string[];
  onUpdate: (patch: Partial<ActiveFilter>) => void; onRemove: () => void;
}) {
  const def = FILTER_BY_ID[af.id]; if (!def) return null;
  const inpS: React.CSSProperties = { ...inputStyle, padding: "4px 6px", width: 92, fontSize: 12 };
  const cov = coverageOf(rows as any[], af.id);
  const pct = cov.total ? Math.round((cov.has / cov.total) * 100) : 0;

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "6px 8px", border: "1px solid var(--edge)", background: "rgba(255,255,255,0.02)" }}>
      <div style={{ minWidth: 180, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12, color: "var(--text)" }}>{def.label}</span>
        {def.hint && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>· {def.hint}</span>}
      </div>

      {def.kind === "boolean" ? (
        <div style={{ display: "flex", gap: 4 }}>
          <button className="hud-btn" data-variant={af.bool === true ? "primary" : "ghost"} data-size="sm" onClick={() => onUpdate({ bool: true })}>true</button>
          <button className="hud-btn" data-variant={af.bool === false ? "primary" : "ghost"} data-size="sm" onClick={() => onUpdate({ bool: false })}>false</button>
          <button className="hud-btn" data-variant={af.bool === undefined ? "primary" : "ghost"} data-size="sm" onClick={() => onUpdate({ bool: undefined })} title="Either — filter matches all rows">either</button>
        </div>
      ) : def.kind === "enum" ? (
        <EnumMultiSelect
          options={af.id === "sector" ? sectorList : af.id === "industry" ? industryList : (def.options ?? [])}
          values={af.values ?? []}
          onChange={(values) => onUpdate({ values })}
        />
      ) : (
        <>
          {/* Cap-tier chips for market_cap */}
          {af.id === "market_cap" && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {CAP_TIERS.map((t) => {
                const isSel = af.min === t.min && (af.max ?? undefined) === t.max;
                return (
                  <button key={t.id}
                    className="hud-btn" data-variant={isSel ? "primary" : "ghost"} data-size="sm"
                    onClick={() => onUpdate({ min: t.min, max: t.max ?? "" })}>{t.label.split(" ")[0]}</button>
                );
              })}
            </div>
          )}
          {/* Histogram + range slider (Tickertape-style distribution). */}
          {cov.has > 0 && def.min !== undefined && def.max !== undefined && (
            <HistogramSlider
              values={(rows as any[]).map((r) => r[af.id])}
              min={def.min}
              max={def.max}
              step={def.step ?? 1}
              lo={af.min}
              hi={af.max}
              onChange={(patch) => onUpdate(patch)}
            />
          )}
          <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-hud)" }}>MIN</span>
          <input type="number" value={af.min ?? ""} step={def.step}
            placeholder={def.min !== undefined ? String(def.min) : ""}
            onChange={(e) => onUpdate({ min: e.target.value === "" ? "" : Number(e.target.value) })} style={inpS} />
          <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-hud)" }}>MAX</span>
          <input type="number" value={af.max ?? ""} step={def.step}
            placeholder={def.max !== undefined ? String(def.max) : ""}
            onChange={(e) => onUpdate({ max: e.target.value === "" ? "" : Number(e.target.value) })} style={inpS} />
          {def.unit && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{def.unit}</span>}
        </>
      )}

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
        {def.kind !== "boolean" && rows.length > 0 && cov.has === 0 && (
          <span
            title="This column has no data yet — run Sync fundamentals in the Data Health strip below."
            style={{ fontSize: 10, color: "#ffb400", fontFamily: "var(--font-hud)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
            no data · sync fundamentals
          </span>
        )}
        {def.kind !== "boolean" && rows.length > 0 && (
          <Chip tone={pct >= 90 ? "ok" : pct >= 50 ? "warn" : "err"}>{cov.has}/{cov.total}</Chip>
        )}
        <span style={{ fontSize: 10, color: "var(--accent-soft)", fontFamily: "var(--font-hud)", letterSpacing: "0.12em" }}>
          {chipDesc(af)}
        </span>
        <button className="hud-btn" data-variant="ghost" data-size="sm" title="Remove" onClick={onRemove}>
          <X size={11} />
        </button>
      </div>
    </div>
  );
}

function EnumMultiSelect({ options, values, onChange }: { options: string[]; values: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const toggle = (v: string) => values.includes(v) ? onChange(values.filter((x) => x !== v)) : onChange([...values, v]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <Btn size="sm" onClick={() => setOpen((o) => !o)}>{values.length ? `${values.length} selected` : "select…"}</Btn>
      {open && (
        <div style={{ ...popoverStyle, maxHeight: 320, overflowY: "auto", width: 240, left: 0, right: "auto" }}>
          {options.length === 0
            ? <span style={{ fontSize: 11, color: "var(--text-muted)", padding: 6 }}>no options yet</span>
            : options.map((o) => (
              <button key={o} onClick={() => toggle(o)}
                style={{ ...popoverItem, padding: "4px 8px", display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(53,214,237,0.08)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <span style={{ width: 11, height: 11, border: "1px solid var(--edge-strong)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                  {values.includes(o) && <Check size={9} style={{ color: "var(--accent)" }} />}
                </span>
                <span>{o}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Column picker
// ============================================================================
function ColumnPicker({ value, onChange }: { value: string[]; onChange: (cols: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const toggle = (id: string) => value.includes(id) ? onChange(value.filter((x) => x !== id)) : onChange([...value, id]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <Btn size="sm" onClick={() => setOpen((o) => !o)}>Columns · {value.length}</Btn>
      {open && (
        <div style={{ ...popoverStyle, width: 240, maxHeight: 400, overflowY: "auto" }}>
          {COLUMNS.map((c) => (
            <button key={c.id} onClick={() => toggle(c.id)}
              style={{ ...popoverItem, padding: "6px 8px", display: "flex", alignItems: "center", gap: 8 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(53,214,237,0.08)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              <span style={{ width: 12, height: 12, border: "1px solid var(--edge-strong)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                {value.includes(c.id) && <Check size={10} style={{ color: "var(--accent)" }} />}
              </span>
              <span style={{ fontSize: 12, color: "var(--text)" }}>{c.label}</span>
            </button>
          ))}
          <div style={{ display: "flex", gap: 4, padding: 6, borderTop: "1px solid var(--edge)" }}>
            <Btn size="sm" onClick={() => onChange(DEFAULT_COLS)}>defaults</Btn>
            <Btn size="sm" onClick={() => onChange(COLUMNS.map((c) => c.id))}>all</Btn>
            <Btn size="sm" onClick={() => onChange([])}>none</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

const popoverStyle: React.CSSProperties = {
  position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 40,
  minWidth: 220, background: "var(--bg-panel)", border: "1px solid var(--edge-strong)",
  padding: 6, display: "flex", flexDirection: "column", gap: 2,
  boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
};
const popoverItem: React.CSSProperties = {
  background: "transparent", border: "none", textAlign: "left",
  padding: "6px 8px", cursor: "pointer", color: "var(--text)", width: "100%",
};

// ============================================================================
// Column preset picker — one-click column-set swap (Screener.in style)
// ============================================================================
function ColumnPresetPicker({ onPick }: { onPick: (cols: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <Btn size="sm" onClick={() => setOpen((o) => !o)} title="Swap the visible columns to a curated preset">
        View
      </Btn>
      {open && (
        <div style={{ ...popoverStyle, width: 240 }}>
          {COLUMN_PRESETS.map((p) => (
            <button key={p.id} onClick={() => { onPick(p.cols); setOpen(false); }}
              style={{ ...popoverItem, padding: "6px 8px" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(53,214,237,0.08)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              <div style={{ color: "var(--accent)", fontFamily: "var(--font-hud)", fontSize: 11, letterSpacing: "0.12em" }}>{p.label}</div>
              <div style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 2 }}>{p.desc}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Data Health strip — shows fundamentals coverage + one-click resync
// ============================================================================
function DataHealthStrip({ rows }: { rows: ScreenerRow[] }) {
  const push = useUi((s) => s.push);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<null | "fund" | "eod" | "agg">(null);
  const stats = useMemo(() => {
    const total = rows.length;
    const withFundamentals = rows.filter((r) => r.pe_ttm != null || r.roe != null || r.market_cap != null).length;
    const withTechnicals = rows.filter((r) => r.rsi14 != null || r.adx14 != null).length;
    const withSector = rows.filter((r) => r.sector != null).length;
    return { total, withFundamentals, withTechnicals, withSector };
  }, [rows]);

  const trigger = async (fn: "market-fundamentals-global-sync" | "market-pipeline-eod" | "market-pipeline-aggregates", label: string, key: "fund" | "eod" | "agg", quiet = false) => {
    if (busy) return;
    setBusy(key);
    // Chunked pipelines (fund + eod) auto-drain across multiple invocations.
    const isChunked = fn === "market-fundamentals-global-sync" || fn === "market-pipeline-eod";
    if (!isChunked) {
      if (!quiet) push(`${label} started`, "warn");
      try {
        const { error } = await supabase.functions.invoke(fn, { body: {} });
        if (error) throw error;
        if (!quiet) push(`${label} complete`, "ok");
        await qc.invalidateQueries({ queryKey: ["market", "screener-rows-v2"] });
      } catch (e) {
        if (!quiet) push(`${label} failed: ${(e as Error).message}`, "err");
      } finally {
        setBusy(null);
      }
      return;
    }

    const MAX_CALLS = 30;
    let totalProcessed = 0, totalSynced = 0, totalFailed = 0;
    if (!quiet) push(`${label} started — chunked run, this may take a few minutes`, "warn");
    try {
      for (let i = 0; i < MAX_CALLS; i++) {
        const { data, error } = await supabase.functions.invoke(fn, { body: {} });
        if (error) throw error;
        const d = (data ?? {}) as { drained?: boolean; processed?: number; synced?: number; failed?: number; remaining?: number };
        totalProcessed += d.processed ?? 0;
        totalSynced += d.synced ?? 0;
        totalFailed += d.failed ?? 0;
        if (d.drained) break;
        if (!quiet && i % 3 === 2) {
          push(`${label} … ${totalSynced} synced${d.remaining != null ? ` · ${d.remaining} remaining` : ""}`, "warn");
        }
      }
      if (!quiet) push(`${label} complete — ${totalSynced} synced, ${totalFailed} failed`, "ok");
      await qc.invalidateQueries({ queryKey: ["market", "screener-rows-v2"] });
    } catch (e) {
      if (!quiet) push(`${label} stopped: ${(e as Error).message} (synced ${totalSynced}/${totalProcessed})`, "err");
    } finally {
      setBusy(null);
    }
  };

  const pct = (n: number) => stats.total ? Math.round((n / stats.total) * 100) : 0;
  const fundPct = pct(stats.withFundamentals);
  const techPct = pct(stats.withTechnicals);
  const sectorPct = pct(stats.withSector);
  const anyLow = fundPct < 50 || sectorPct < 50;

  useEffect(() => {
    if (rows.length === 0 || busy) return;
    if (fundPct >= 80 && sectorPct >= 80) return;
    const last = Number(localStorage.getItem(AUTO_SYNC_STORE_KEY) || 0);
    if (Date.now() - last < 30 * 60_000) return;
    localStorage.setItem(AUTO_SYNC_STORE_KEY, String(Date.now()));
    void trigger("market-fundamentals-global-sync", "Fundamentals auto-sync", "fund", true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, fundPct, sectorPct]);

  if (rows.length === 0) return null;

  return (
    <div style={{
      marginTop: 8, padding: "6px 10px", border: `1px solid ${anyLow ? "var(--warn, #ffb400)" : "var(--edge)"}`,
      background: anyLow ? "rgba(255,180,0,0.05)" : "rgba(53,214,237,0.03)",
      display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
    }}>
      <span style={{ fontFamily: "var(--font-hud)", fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-muted)" }}>Data Health · auto-sync</span>
      <Chip tone={fundPct >= 80 ? "ok" : fundPct >= 40 ? "warn" : "err"}>Fundamentals {stats.withFundamentals}/{stats.total} · {fundPct}%</Chip>
      <Chip tone={sectorPct >= 80 ? "ok" : sectorPct >= 40 ? "warn" : "err"}>Sector {stats.withSector}/{stats.total} · {sectorPct}%</Chip>
      <Chip tone={techPct >= 80 ? "ok" : techPct >= 40 ? "warn" : "err"}>Technicals {stats.withTechnicals}/{stats.total} · {techPct}%</Chip>
      <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
        <Btn size="sm" onClick={() => trigger("market-fundamentals-global-sync", "Fundamentals sync", "fund")} disabled={busy !== null}
          title="Populates PE, ROE, D/E, growth, sector, industry, market cap from Yahoo (~2 min).">
          <Database size={11} style={{ marginRight: 4 }} />{busy === "fund" ? "syncing…" : "Sync fundamentals"}
        </Btn>
        <Btn size="sm" onClick={() => trigger("market-pipeline-eod", "EOD batch", "eod")} disabled={busy !== null}
          title="Fetches EOD candles + technical indicators (~100 stocks per invocation).">
          {busy === "eod" ? "running…" : "EOD batch"}
        </Btn>
        <Btn size="sm" onClick={() => trigger("market-pipeline-aggregates", "Aggregates", "agg")} disabled={busy !== null}
          title="Finalizes breadth, sector strength, relative strength.">
          {busy === "agg" ? "finalizing…" : "Aggregates"}
        </Btn>
      </div>
    </div>
  );
}
