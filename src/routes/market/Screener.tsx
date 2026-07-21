// Stock Screener — Tickertape/Screener.in-style 2-pane layout.
// Left rail: collapsible filter categories with search & data-coverage chips.
// Right pane: query chips → results grid with coverage note, pagination & CSV.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { DataTable, fmtInt, fmtNum, PctCell } from "@/components/hud/DataTable";
import { ScoreBadge } from "@/components/market/ScoreBadge";

import { useQuotes, useSavedScreeners, useScreenerMutations, marketOpen } from "@/lib/market/hooks";
import { quoteKey } from "@/lib/market/pnl";
import { isFreshTick, useLiveTickStore } from "@/lib/market/liveTickStore";
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
  
  filterMatches,
  coverageOf,
  excludedByMissingData,
  type ActiveFilter,
  type FilterDef,
  type UniverseId,
} from "@/lib/market/screenerCatalog";
import { Check, Database, Download, Plus, RotateCcw, Save, Search, Sparkles, X } from "lucide-react";

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
  { id: "pe",                 label: "PE",            align: "right", default: true },
  { id: "pb",                 label: "PB",            align: "right" },
  { id: "peg",                label: "PEG",           align: "right" },
  { id: "eps",                label: "EPS",           align: "right" },
  { id: "book_value",         label: "Book Val",      align: "right" },
  { id: "roe",                label: "ROE",           align: "right", default: true },
  { id: "debt_equity",        label: "D/E",           align: "right", default: true },
  { id: "sales_growth",       label: "Rev Grw",       align: "right" },
  { id: "profit_growth",      label: "PAT Grw",       align: "right" },
  { id: "eps_growth",         label: "EPS Grw",       align: "right" },
  { id: "dividend_yield",     label: "Div Yld",       align: "right" },
  { id: "promoter_holding",   label: "Promoter %",    align: "right" },
  { id: "dii_holding",        label: "Instl %",       align: "right" },
  { id: "rsi",                label: "RSI",           align: "right" },
  { id: "adx",                label: "ADX",           align: "right" },
  { id: "pct_from_52w_high",  label: "52w Δ",         align: "right", default: true },
  { id: "breakout_score",     label: "Breakout",      align: "right", default: true },
  { id: "prebreakout_score",  label: "Pre-BO",        align: "right" },
  { id: "setup",              label: "Setup" },
];
const DEFAULT_COLS = COLUMNS.filter((c) => c.default).map((c) => c.id);
const COLS_STORE_KEY = "screener.visibleCols.v3";
const PAGE_SIZE_KEY  = "screener.pageSize.v2";
const AUTO_SYNC_STORE_KEY = "screener.autoFundamentalsSyncAt.v1";
// Change%/Price filters run against a live-quote overlay (matching what the
// results table displays) when the market's open and the candidate set after
// every other filter is small enough to batch-quote without hammering the
// broker API — beyond this, fall back to the last EOD close/change% rather
// than fetching thousands of live quotes on every filter tweak.
const LIVE_FILTER_CANDIDATE_CAP = 300;
const LIVE_SENSITIVE_FILTER_IDS = new Set(["change_pct", "ltp"]);

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
    if (c === "close") return r.ltp == null ? "" : String(r.ltp);
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

  // Change %/Price come from the once-daily EOD pipeline (market_stock_scores),
  // while the results table's Chg%/Price columns overlay a live quote for
  // display — filtering on the stale value while showing the live one meant a
  // user's range could silently disagree with what they saw on screen. Defer
  // those two filters to a second pass, applied against the same live overlay
  // the columns already use, once the candidate set is narrowed by everything
  // else and small enough to batch-quote.
  const liveSensitiveActive = useMemo(() => active.filter((af) => LIVE_SENSITIVE_FILTER_IDS.has(af.id)), [active]);
  const marketIsOpen = marketOpen();
  const deferLiveFilters = marketIsOpen && liveSensitiveActive.length > 0;

  const preLiveFiltered = useMemo(() => {
    let out: ScreenerRow[] = rows;
    for (const af of active) {
      if (deferLiveFilters && LIVE_SENSITIVE_FILTER_IDS.has(af.id)) continue;
      out = out.filter((r) => filterMatches(r as any, af));
    }
    return out;
  }, [rows, active, deferLiveFilters]);

  const liveFilterTooManyCandidates = deferLiveFilters && preLiveFiltered.length > LIVE_FILTER_CANDIDATE_CAP;
  const liveFilterKeys = useMemo(
    () => (deferLiveFilters && !liveFilterTooManyCandidates ? preLiveFiltered.map((r) => `${r.exchange ?? "NSE"}:${r.symbol}`) : []),
    [deferLiveFilters, liveFilterTooManyCandidates, preLiveFiltered],
  );
  const { data: liveFilterQuotesData } = useQuotes(liveFilterKeys);
  const liveFilterQuoteByKey = useMemo(() => {
    const m = new Map<string, { ltp: number; change_pct: number | null }>();
    for (const q of liveFilterQuotesData?.quotes ?? []) m.set(quoteKey(q.exchange, q.symbol), q);
    return m;
  }, [liveFilterQuotesData]);

  const filtered = useMemo(() => {
    if (!deferLiveFilters || liveFilterTooManyCandidates) return preLiveFiltered;
    return preLiveFiltered.filter((r) => {
      const live = liveFilterQuoteByKey.get(quoteKey(r.exchange ?? "NSE", r.symbol));
      for (const af of liveSensitiveActive) {
        const overlaid = af.id === "change_pct"
          ? { ...r, change_pct: live?.change_pct ?? r.change_pct }
          : { ...r, ltp: live?.ltp ?? r.ltp };
        if (!filterMatches(overlaid as any, af)) return false;
      }
      return true;
    });
  }, [preLiveFiltered, deferLiveFilters, liveFilterTooManyCandidates, liveFilterQuoteByKey, liveSensitiveActive]);

  useEffect(() => { setPage(0); }, [active, universe, pageSize]);

  // ---- URL-serialized state (Phase 6): ?f=<b64(JSON)> — shareable screens ----
  const didHydrateFromUrlRef = useRef(false);
  useEffect(() => {
    if (didHydrateFromUrlRef.current) return;
    didHydrateFromUrlRef.current = true;
    try {
      const p = new URLSearchParams(window.location.search).get("f");
      if (!p) return;
      const bytes = Uint8Array.from(atob(decodeURIComponent(p)), (c) => c.charCodeAt(0));
      const raw = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(raw);
      if (parsed?.universe) setUniverse(parsed.universe as UniverseId);
      if (Array.isArray(parsed?.active)) setActive(parsed.active);
    } catch { /* ignore malformed */ }
  }, []);
  useEffect(() => {
    if (!didHydrateFromUrlRef.current) return;
    try {
      const payload = JSON.stringify({ universe, active });
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(payload)));
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


  // "+ Add Filter" picker: bring a filter into the sidebar with an empty
  // value, ready to edit — bypasses setFilterValue's auto-drop-when-empty
  // (below) since an intentionally-just-added filter should stick around
  // with blank inputs, not vanish immediately.
  const addFilter = (fid: string) => {
    if (active.some((a) => a.id === fid)) return;
    const def = FILTER_BY_ID[fid]; if (!def) return;
    const initial: ActiveFilter =
      def.kind === "boolean" ? { id: fid, bool: true } :
      def.kind === "enum"    ? { id: fid, values: [] } :
      { id: fid };
    setActive((a) => [...a, initial]);
  };

  // Inline sidebar editors call this directly on every keystroke/toggle —
  // adds the filter to `active` on first non-empty value, drops it again
  // once cleared back to empty, so there's no separate add/remove step.
  const setFilterValue = (fid: string, patch: Partial<ActiveFilter>) => {
    setActive((a) => {
      const existing = a.find((x) => x.id === fid);
      const merged: ActiveFilter = existing ? { ...existing, ...patch } : { id: fid, ...patch };
      const isEmpty =
        (merged.min === undefined || merged.min === "") &&
        (merged.max === undefined || merged.max === "") &&
        merged.bool === undefined &&
        (!merged.values || merged.values.length === 0);
      if (isEmpty) return a.filter((x) => x.id !== fid);
      return existing ? a.map((x) => (x.id === fid ? merged : x)) : [...a, merged];
    });
  };
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

  // Paginate visible rows client-side.
  const pageStart = page * pageSize;
  const paged = useMemo(() => filtered.slice(pageStart, pageStart + pageSize), [filtered, pageStart, pageSize]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));

  // Live quotes for the rows actually rendered on this page (bounded to
  // `pageSize`, never the full universe) — 1s refresh during market hours.
  // When the live-filter pass above already fetched a superset (candidates
  // pre-pagination), reuse that instead of firing a second overlapping batch.
  const quoteKeys = useMemo(
    () => paged.map((r) => `${r.exchange ?? "NSE"}:${r.symbol}`),
    [paged],
  );
  const skipPageQuoteFetch = deferLiveFilters && !liveFilterTooManyCandidates;
  const { data: liveQuotesData } = useQuotes(skipPageQuoteFetch ? [] : quoteKeys);
  const pushTicks = useLiveTickStore((s) => s.ticks);
  const liveQuoteByKey = useMemo(() => {
    const m = new Map<string, { ltp: number; change_pct: number | null }>();
    for (const [k, q] of liveFilterQuoteByKey) m.set(k, q);
    for (const q of liveQuotesData?.quotes ?? []) m.set(quoteKey(q.exchange, q.symbol), q);
    for (const [key, tick] of Object.entries(pushTicks)) {
      if (!isFreshTick(tick)) continue;
      m.set(key, { ltp: tick.ltp, change_pct: tick.change_pct });
    }
    return m;
  }, [liveFilterQuoteByKey, liveQuotesData, pushTicks]);

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
      close: {
        header: "Price", id: "livePrice", meta: { align: "right" },
        accessorFn: (r) => liveQuoteByKey.get(quoteKey(r.exchange ?? "NSE", r.symbol))?.ltp ?? r.ltp,
        cell: ({ getValue }) => fmtNum(getValue() as number | null),
      },
      change_pct: {
        header: "Chg %", id: "liveChangePct", meta: { align: "right" },
        accessorFn: (r) => liveQuoteByKey.get(quoteKey(r.exchange ?? "NSE", r.symbol))?.change_pct ?? r.change_pct,
        cell: ({ getValue }) => <PctCell value={getValue() as number | null} />,
      },
      volume: { header: "Vol", accessorKey: "volume", meta: { align: "right" }, cell: ({ getValue }) => fmtInt(getValue() as number | null) },
      rel_volume: { header: "RVol", accessorKey: "rel_volume", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 1) },
      pe: { header: "PE", accessorKey: "pe", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 1) },
      pb: { header: "PB", accessorKey: "pb", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 1) },
      peg: { header: "PEG", accessorKey: "peg", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 2) },
      eps: { header: "EPS", accessorKey: "eps", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 1) },
      book_value: { header: "Book Val", accessorKey: "book_value", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 1) },
      roe: { header: "ROE", accessorKey: "roe", meta: { align: "right" }, cell: ({ getValue }) => {
        const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(1)}%`;
      }},
      debt_equity: { header: "D/E", accessorKey: "debt_equity", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 2) },
      sales_growth: { header: "Rev Grw", accessorKey: "sales_growth", meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue() as number | null} /> },
      profit_growth: { header: "PAT Grw", accessorKey: "profit_growth", meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue() as number | null} /> },
      eps_growth:    { header: "EPS Grw", accessorKey: "eps_growth",    meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue() as number | null} /> },
      dividend_yield: { header: "Div Yld", accessorKey: "dividend_yield", meta: { align: "right" }, cell: ({ getValue }) => {
        const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(2)}%`;
      }},
      promoter_holding: { header: "Promoter %", accessorKey: "promoter_holding", meta: { align: "right" }, cell: ({ getValue }) => {
        const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(1)}%`;
      }},
      dii_holding: { header: "Instl %", accessorKey: "dii_holding", meta: { align: "right" }, cell: ({ getValue }) => {
        const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(1)}%`;
      }},
      rsi: { header: "RSI", accessorKey: "rsi", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 0) },
      adx: { header: "ADX", accessorKey: "adx", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 0) },
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleCols, liveQuoteByKey]);

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
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{ fontFamily: "var(--font-hud)", fontSize: 9, color: "var(--text-dim)", letterSpacing: "0.14em", textTransform: "uppercase", border: "1px solid var(--edge)", borderRadius: 2, padding: "2px 6px" }}
              title="Screener universe/scoring pipeline currently covers NSE-listed stocks only — BSE-only listings aren't tracked here."
            >
              NSE universe
            </span>
            <div style={{ fontFamily: "var(--font-hud)", fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.16em", textTransform: "uppercase" }}>
              {isFetching ? "loading…" : `${filtered.length} of ${rows.length} stocks`}
            </div>
          </div>
        </div>
        <DataHealthStrip rows={rows} universe={universe} />
      </HudPanel>

      {/* Two-pane workspace: filters sidebar (universe + add/remove filters) + results */}
      <div style={{ display: "grid", gridTemplateColumns: "370px 1fr", gap: 12, alignItems: "start" }}>
        <FilterRail rows={rows} active={active} onAdd={addFilter} onChange={setFilterValue} onClear={removeFilter}
          sectorList={sectorList} industryList={industryList}
          universe={universe} onUniverseChange={setUniverse} />

        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
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
                {/* Applied filters + coverage note — the sidebar edits values inline with
                    no separate query list, so this is the only place the active ranges
                    are visible at a glance. */}
                {active.length > 0 && rows.length > 0 && (
                  <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    <span style={{ fontFamily: "var(--font-hud)", fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.16em", textTransform: "uppercase" }}>Applied</span>
                    {active.map((af) => {
                      const c = coverageOf(rows as any[], af.id);
                      const pct = c.total ? Math.round((c.has / c.total) * 100) : 0;
                      const tone: "ok" | "warn" | "err" = pct >= 90 ? "ok" : pct >= 50 ? "warn" : "err";
                      return <Chip key={af.id} tone={tone}>{chipDesc(af)} · {c.has}/{c.total}</Chip>;
                    })}
                    {(() => {
                      const excluded = excludedByMissingData(rows as any[], active);
                      return excluded > 0 ? (
                        <Chip tone="warn" key="excluded">{excluded} excluded — no synced data yet (not out of range)</Chip>
                      ) : null;
                    })()}
                  </div>
                )}
                {liveSensitiveActive.length > 0 && (
                  <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    {!marketIsOpen ? (
                      <Chip tone="neutral">Change%/Price filtering last EOD close — market closed</Chip>
                    ) : liveFilterTooManyCandidates ? (
                      <Chip tone="warn">{preLiveFiltered.length} candidates — too many for live filtering (cap {LIVE_FILTER_CANDIDATE_CAP}), using last EOD close. Narrow with another filter first.</Chip>
                    ) : (
                      <Chip tone="ok">Change%/Price filtering live</Chip>
                    )}
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
// Left rail — Tickertape-style: Stock Universe fixed at top, then only the
// filters the user has explicitly added (each editable inline, removable),
// with a "+ Add Filter" picker below to bring in more.
// ============================================================================
function FilterRail({ rows, active, onAdd, onChange, onClear, sectorList, industryList, universe, onUniverseChange }: {
  rows: ScreenerRow[]; active: ActiveFilter[];
  onAdd: (id: string) => void;
  onChange: (id: string, patch: Partial<ActiveFilter>) => void;
  onClear: (id: string) => void;
  sectorList: string[]; industryList: string[];
  universe: UniverseId; onUniverseChange: (u: UniverseId) => void;
}) {
  return (
    <HudPanel flow title="Filters" index="MK.SC-R"
      actions={<span style={{ fontFamily: "var(--font-hud)", fontSize: 10, color: "var(--text-muted)" }}>{active.length} active</span>}
    >
      <div style={{ borderBottom: "1px solid var(--edge)", paddingBottom: 10, marginBottom: 10 }}>
        <div style={labelStyle}>Stock Universe</div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
          {UNIVERSES.map((u) => (
            <button key={u.id} onClick={() => onUniverseChange(u.id)}
              className="hud-btn" data-variant={universe === u.id ? "primary" : "ghost"} data-size="sm">
              {u.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14, maxHeight: "calc(100vh - 340px)", overflowY: "auto", paddingRight: 4 }}>
        {active.length === 0 ? (
          <div className="hud-label" style={{ color: "var(--text-dim)" }}>no filters added yet</div>
        ) : (
          active.map((af) => {
            const def = FILTER_BY_ID[af.id]; if (!def) return null;
            return (
              <InlineFilterEditor key={af.id} def={def} af={af} rows={rows}
                sectorList={sectorList} industryList={industryList}
                onChange={(patch) => onChange(af.id, patch)}
                onClear={() => onClear(af.id)} />
            );
          })
        )}
      </div>

      <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--edge)" }}>
        <AddFilterPicker activeIds={new Set(active.map((a) => a.id))} onPick={onAdd} rows={rows} />
      </div>
    </HudPanel>
  );
}

// "+ Add Filter" — anchored popover (same pattern as PresetPicker/SavedPicker)
// listing the full category tree, filtered to hide filters already added.
function AddFilterPicker({ activeIds, onPick, rows }: {
  activeIds: Set<string>; onPick: (id: string) => void; rows: ScreenerRow[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPos(triggerRef, open, "right", 300);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const term = q.trim().toLowerCase();

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button ref={triggerRef} className="hud-btn" data-variant="primary" data-size="sm"
        onClick={() => setOpen((o) => !o)} style={{ width: "100%" }}>
        <Plus size={11} style={{ marginRight: 4 }} />Add Filter
      </button>
      {open && pos && createPortal(
        <div ref={popRef} style={{ ...popoverStyle, ...pos, width: 300, maxHeight: 440, overflowY: "auto" }}>
          <div style={{ position: "relative", padding: 6, borderBottom: "1px solid var(--edge)" }}>
            <Search size={11} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search filters…" autoFocus
              style={{ ...inputStyle, padding: "6px 8px 6px 24px", fontSize: 12, width: "100%" }} />
          </div>
          {CATEGORIES.map((cat) => {
            const inCat = FILTERS.filter((f) => f.category === cat.id && !activeIds.has(f.id) && (!term || f.label.toLowerCase().includes(term)));
            if (inCat.length === 0) return null;
            return (
              <div key={cat.id}>
                <div style={{ padding: "4px 8px", fontFamily: "var(--font-hud)", fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.2em", textTransform: "uppercase", borderBottom: "1px solid var(--edge)" }}>{cat.label}</div>
                {inCat.map((f) => {
                  const cov = coverageOf(rows as any[], f.id);
                  const pct = cov.total ? Math.round((cov.has / cov.total) * 100) : 0;
                  const covTone: "ok" | "warn" | "err" | undefined = pct >= 90 ? undefined : pct >= 50 ? "warn" : "err";
                  return (
                    <button key={f.id} onClick={() => { onPick(f.id); setOpen(false); }}
                      title={f.hint}
                      style={{ ...popoverItem, padding: "6px 8px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(53,214,237,0.08)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                      <span>{f.label}</span>
                      {rows.length > 0 && f.kind !== "boolean" && covTone && <Chip tone={covTone}>{pct}%</Chip>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

// Compact per-filter editor rendered inline in the sidebar — value changes
// go straight to `active` (see setFilterValue), no add/remove step.
function InlineFilterEditor({ def, af, rows, sectorList, industryList, onChange, onClear }: {
  def: FilterDef; af: ActiveFilter | undefined; rows: ScreenerRow[];
  sectorList: string[]; industryList: string[];
  onChange: (patch: Partial<ActiveFilter>) => void; onClear: () => void;
}) {
  const cov = coverageOf(rows as any[], def.id);
  const pct = cov.total ? Math.round((cov.has / cov.total) * 100) : 0;
  const covTone: "ok" | "warn" | "err" | undefined = pct >= 90 ? undefined : pct >= 50 ? "warn" : "err";
  const isActive = af !== undefined;
  const inpS: React.CSSProperties = { ...inputStyle, padding: "4px 6px", width: "100%", fontSize: 11 };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: isActive ? "var(--accent)" : "var(--text)" }} title={def.hint}>{def.label}</span>
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          {rows.length > 0 && def.kind !== "boolean" && covTone && <Chip tone={covTone}>{pct}%</Chip>}
          {isActive && (
            <button onClick={onClear} title="Clear" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex", padding: 0 }}>
              <X size={10} />
            </button>
          )}
        </span>
      </div>

      {def.kind === "boolean" ? (
        <div style={{ display: "flex", gap: 4 }}>
          <button className="hud-btn" data-variant={af?.bool === true ? "primary" : "ghost"} data-size="sm" onClick={() => onChange({ bool: true })}>true</button>
          <button className="hud-btn" data-variant={af?.bool === false ? "primary" : "ghost"} data-size="sm" onClick={() => onChange({ bool: false })}>false</button>
        </div>
      ) : def.kind === "enum" ? (
        <EnumMultiSelect
          options={def.id === "sector" ? sectorList : def.id === "industry" ? industryList : (def.options ?? [])}
          values={af?.values ?? []}
          onChange={(values) => (values.length === 0 ? onClear() : onChange({ values }))}
        />
      ) : (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="number" value={af?.min ?? ""} step={def.step}
            placeholder={def.min !== undefined ? String(def.min) : "min"}
            onChange={(e) => onChange({ min: e.target.value === "" ? "" : Number(e.target.value) })} style={inpS} />
          <span style={{ fontSize: 9, color: "var(--text-muted)" }}>–</span>
          <input type="number" value={af?.max ?? ""} step={def.step}
            placeholder={def.max !== undefined ? String(def.max) : "max"}
            onChange={(e) => onChange({ max: e.target.value === "" ? "" : Number(e.target.value) })} style={inpS} />
          {def.unit && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{def.unit}</span>}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Preset / Saved pickers
// ============================================================================
function PresetPicker({ onPick, rows }: { onPick: (id: string) => void; rows: ScreenerRow[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPos(triggerRef, open, "right", 480);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const groups = ["Fundamental", "Technical", "Hybrid"] as const;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button ref={triggerRef} className="hud-btn" data-variant="ghost" data-size="sm" onClick={() => setOpen((o) => !o)}>
        <Sparkles size={11} style={{ marginRight: 4 }} />Presets
      </button>
      {open && pos && createPortal(
        <div ref={popRef} style={{ ...popoverStyle, ...pos, width: 320, maxHeight: 480, overflowY: "auto" }}>
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
        </div>,
        document.body,
      )}
    </div>
  );
}

function SavedPicker({ saved, onLoad, onDelete }: {
  saved: SavedScreener[]; onLoad: (s: SavedScreener) => void; onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPos(triggerRef, open, "right", 360);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button ref={triggerRef} className="hud-btn" data-variant="ghost" data-size="sm"
        onClick={() => setOpen((o) => !o)} disabled={saved.length === 0}>
        My Screens · {saved.length}
      </button>
      {open && saved.length > 0 && pos && createPortal(
        <div ref={popRef} style={{ ...popoverStyle, ...pos, width: 240, maxHeight: 360, overflowY: "auto" }}>
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
        </div>,
        document.body,
      )}
    </div>
  );
}

function EnumMultiSelect({ options, values, onChange }: { options: string[]; values: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPos(triggerRef, open, "left", 320);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const toggle = (v: string) => values.includes(v) ? onChange(values.filter((x) => x !== v)) : onChange([...values, v]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button ref={triggerRef} className="hud-btn" data-variant="ghost" data-size="sm" onClick={() => setOpen((o) => !o)}>
        {values.length ? `${values.length} selected` : "select…"}
      </button>
      {open && pos && createPortal(
        <div ref={popRef} style={{ ...popoverStyle, ...pos, maxHeight: 320, overflowY: "auto", width: 240 }}>
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
        </div>,
        document.body,
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPos(triggerRef, open, "right", 400);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const toggle = (id: string) => value.includes(id) ? onChange(value.filter((x) => x !== id)) : onChange([...value, id]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button ref={triggerRef} className="hud-btn" data-variant="ghost" data-size="sm" onClick={() => setOpen((o) => !o)}>
        Columns · {value.length}
      </button>
      {open && pos && createPortal(
        <div ref={popRef} style={{ ...popoverStyle, ...pos, width: 240, maxHeight: 400, overflowY: "auto" }}>
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
        </div>,
        document.body,
      )}
    </div>
  );
}

const popoverStyle: React.CSSProperties = {
  position: "fixed", zIndex: 9999,
  minWidth: 220, background: "var(--bg-panel)", border: "1px solid var(--edge-strong)",
  padding: 6, display: "flex", flexDirection: "column", gap: 2,
  boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
};
const popoverItem: React.CSSProperties = {
  background: "transparent", border: "none", textAlign: "left",
  padding: "6px 8px", cursor: "pointer", color: "var(--text)", width: "100%",
};

// Anchored popover position: computed from trigger rect, updates on scroll/resize.
// Uses "align" to snap left/right edge of the popover to the trigger, and prefers
// opening below unless there isn't enough room (then flips above). Combined with
// `position: fixed` + createPortal, this makes popovers escape any scrolling
// ancestor and render above everything else on the page.
function useAnchoredPos(
  triggerRef: React.RefObject<HTMLElement>,
  open: boolean,
  align: "left" | "right" = "right",
  estHeight = 320,
): { top: number; left?: number; right?: number } | null {
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const compute = () => {
      const el = triggerRef.current; if (!el) return;
      const r = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < estHeight && r.top > spaceBelow;
      const top = openUp ? Math.max(8, r.top - estHeight - 4) : r.bottom + 4;
      if (align === "left") setPos({ top, left: r.left });
      else setPos({ top, right: window.innerWidth - r.right });
    };
    compute();
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [open, triggerRef, align, estHeight]);
  return pos;
}

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
// Data Health strip — passive status. Sync happens on server crons + a silent
// background hook (`useMarketAutoSync`). Users only see a "last synced X ago"
// line; a discreet overflow menu keeps force-resync available for power users.
// ============================================================================
function DataHealthStrip({ rows }: { rows: ScreenerRow[]; universe: UniverseId }) {
  const push = useUi((s) => s.push);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<null | "fund" | "eod" | "agg">(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuPopRef = useRef<HTMLDivElement>(null);
  const menuPos = useAnchoredPos(menuTriggerRef, menuOpen, "right", 180);

  // Live pipeline status from the DB view — reflects reality regardless of
  // whether the current user has ever triggered a sync from this browser.
  const { data: pipeline } = useQuery({
    queryKey: ["market", "pipeline-status"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("market_pipeline_status").select("*").maybeSingle();
      if (error) throw error;
      return data as {
        active_stocks: number;
        fundamentals_covered: number;
        fundamentals_failed: number;
        fundamentals_last_updated_at: string | null;
        scores_last_trade_date: string | null;
        scores_last_count: number | null;
      } | null;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuTriggerRef.current?.contains(t) || menuPopRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  // Coverage stats — scope by applicability.
  //  Fundamentals: equity rows are the denominator; ETFs are structurally N/A.
  //  Sector: equity rows are the denominator (ETFs have no sector).
  //  Technicals: rows with a trade_date are the denominator (rows without an EOD score legitimately have no RSI).
  const stats = useMemo(() => {
    const equities = rows.filter((r) => (r.instrument_type ?? "EQ") === "EQ");
    const withScore = rows.filter((r) => r.trade_date != null);
    const total = equities.length;
    // market_data has no sync_status column (that was market_fundamentals_global's
    // field) — infer coverage from which core fundamentals actually landed.
    const ok      = equities.filter((r) => r.pe != null && r.roe != null).length;
    const partial = equities.filter((r) => !(r.pe != null && r.roe != null) && (r.pe != null || r.roe != null || r.market_cap != null)).length;
    const failed  = equities.filter((r) => r.pe == null && r.roe == null && r.market_cap == null).length;
    const withTech = withScore.filter((r) => r.rsi != null || r.adx != null).length;
    const withSector = equities.filter((r) => r.sector != null).length;
    return {
      total,
      ok, partial, failed,
      withTech, techTotal: withScore.length,
      withSector,
      nonEquity: rows.length - equities.length,
    };
  }, [rows]);


  const trigger = async (
    fn: "market-fundamentals-global-sync" | "market-pipeline-eod" | "market-pipeline-aggregates",
    label: string,
    key: "fund" | "eod" | "agg",
  ) => {
    if (busy) return;
    setBusy(key);
    setMenuOpen(false);
    const isChunked = fn === "market-fundamentals-global-sync" || fn === "market-pipeline-eod";
    try {
      if (!isChunked) {
        const { error } = await supabase.functions.invoke(fn, { body: {} });
        if (error) throw error;
      } else {
        // Drain up to 30 chunks, silently.
        for (let i = 0; i < 30; i++) {
          const { data, error } = await supabase.functions.invoke(fn, { body: {} });
          if (error) throw error;
          if ((data as any)?.drained) break;
        }
      }
      push(`${label} complete`, "ok");
      await qc.invalidateQueries({ queryKey: ["market"] });
    } catch (e) {
      push(`${label} failed: ${(e as Error).message}`, "err");
    } finally { setBusy(null); }
  };

  const pctOf = (n: number, d: number) => d ? Math.round((n / d) * 100) : 0;
  const healthyPct = pctOf(stats.ok + stats.partial, stats.total);
  const sectorPct  = pctOf(stats.withSector, stats.total);
  const techPct    = pctOf(stats.withTech, stats.techTotal);
  const anyLow = healthyPct < 80 || sectorPct < 80 || techPct < 80;

  // Calendar days between the EOD pipeline's last trade_date and today (IST).
  // >3 comfortably survives a normal weekend gap (Fri close still "fresh" on
  // Monday) while still catching a genuinely stuck/broken pipeline.
  const scoresLastTradeDate = pipeline?.scores_last_trade_date;
  const scoresStaleDays = useMemo((): number | null => {
    if (!scoresLastTradeDate) return null;
    const d = new Date(`${scoresLastTradeDate}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    const nowIst = new Date(Date.now() + 5.5 * 3600_000);
    const todayIst = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate());
    return Math.round((todayIst - d.getTime()) / 86_400_000);
  }, [scoresLastTradeDate]);
  const scoresStale = scoresStaleDays != null && scoresStaleDays > 3;

  if (rows.length === 0) return null;

  // Relative-time formatter.
  const ago = (iso: string | null | undefined): string => {
    if (!iso) return "never";
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <>
      {scoresStale && (
        <div style={{
          marginTop: 8, padding: "8px 10px", border: "1px solid var(--danger)",
          background: "rgba(255,95,109,0.08)", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 12, color: "var(--danger)" }}>
            ⚠ EOD technical data last updated {pipeline?.scores_last_trade_date} ({scoresStaleDays}d ago) — Change %, RSI,
            and related filters may not reflect current prices.
          </span>
          <Btn size="sm" variant="danger" onClick={() => trigger("market-pipeline-eod", "EOD technicals", "eod")} disabled={busy !== null}>
            {busy === "eod" ? "syncing…" : "resync now"}
          </Btn>
        </div>
      )}
      <div style={{
      marginTop: 8, padding: "6px 10px", border: `1px solid ${anyLow ? "var(--warn, #ffb400)" : "var(--edge)"}`,
      background: anyLow ? "rgba(255,180,0,0.05)" : "rgba(53,214,237,0.03)",
      display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
    }}>
      <span style={{ fontFamily: "var(--font-hud)", fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-muted)" }}>
        Data Health · applicable rows only
      </span>
      <Chip tone={healthyPct >= 95 ? "ok" : healthyPct >= 80 ? "warn" : "err"}>
        Fundamentals {stats.ok + stats.partial}/{stats.total} · {healthyPct}%
      </Chip>
      <Chip tone={sectorPct >= 95 ? "ok" : sectorPct >= 80 ? "warn" : "err"}>Sector {stats.withSector}/{stats.total} · {sectorPct}%</Chip>
      <Chip tone={techPct >= 95 ? "ok" : techPct >= 80 ? "warn" : "err"}>Technicals {stats.withTech}/{stats.techTotal} · {techPct}%</Chip>
      {stats.failed > 0 && <Chip tone="err">{stats.failed} upstream failures</Chip>}
      {stats.nonEquity > 0 && (
        <span style={{ fontFamily: "var(--font-hud)", fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.14em" }}>
          excludes {stats.nonEquity} ETF/non-equity
        </span>
      )}
      <span style={{ fontFamily: "var(--font-hud)", fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.14em" }}>
        Fundamentals synced {ago(pipeline?.fundamentals_last_updated_at)} · Scores {pipeline?.scores_last_trade_date ?? "—"}
      </span>
      <div ref={menuRef} style={{ marginLeft: "auto", position: "relative" }}>
        <button ref={menuTriggerRef} className="hud-btn" data-variant="ghost" data-size="sm"
          onClick={() => setMenuOpen((o) => !o)} disabled={busy !== null}
          title="Force a resync — runs immediately instead of waiting for the next background pass.">
          {busy ? "syncing…" : "⋯ Force resync"}
        </button>
        {menuOpen && menuPos && createPortal(
          <div ref={menuPopRef} style={{ ...popoverStyle, ...menuPos }}>
            <button style={popoverItem} onClick={() => trigger("market-fundamentals-global-sync", "Fundamentals", "fund")}>
              <Database size={11} style={{ marginRight: 6 }} />Fundamentals (stale/failed only)
            </button>
            <button style={popoverItem} onClick={() => trigger("market-pipeline-eod", "EOD technicals", "eod")}>
              Recompute technical indicators
            </button>
            <button style={popoverItem} onClick={() => trigger("market-pipeline-aggregates", "Aggregates", "agg")}>
              Recompute breadth &amp; sector strength
            </button>
          </div>,
          document.body,
        )}
      </div>
      </div>
    </>
  );
}

