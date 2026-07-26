// Stock Screener — Tickertape/Screener.in-style 2-pane layout.
// Left rail: collapsible filter categories with search & data-coverage chips.
// Right pane: query chips → results grid with coverage note, pagination & CSV.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { HudPanel } from "@/components/hud/HudPanel";
import { HudModal } from "@/components/hud/HudModal";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { DataTable, deriveChangeAbs, fmtInt, fmtNum, PctCell, Return1DCell } from "@/components/hud/DataTable";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { AddToWatchlistButton } from "@/components/market/AddToWatchlistButton";

import { useSavedScreeners, useScreenerMutations, useQuotes, useMarketSettings } from "@/lib/market/hooks";
import { useScreenerData, useScreenerSectors, useScreenerIndustries, type ScreenerRow } from "@/lib/market/screenerRun";
import { todayIstDateString } from "@/lib/market/liveSnapshot";
import { quoteKey } from "@/lib/market/pnl";
import { isFreshTick, useLiveTickStore } from "@/lib/market/liveTickStore";
import { subscribeSymbolsForTicks, useRelayAlive } from "@/lib/market/useRealtimeTicks";
import { Link } from "react-router-dom";
import { useUi } from "@/store/uiStore";
import { supabase } from "@/integrations/supabase/client";
import type { SavedScreener } from "@/lib/market/types";

import {
  CATEGORIES,
  FILTERS,
  FILTER_BY_ID,
  UNIVERSES,
  filterMatches,
  coverageOf,
  canonicalFilterId,
  latestTradeDateOf,
  isEquityRow,
  TECH_FRESHNESS_LAG_DAYS,
  type ActiveFilter,
  type FilterDef,
  type UniverseId,
} from "@/lib/market/screenerCatalog";
import { AlertTriangle, Check, Database, Download, Plus, RotateCcw, Save, Search, X } from "lucide-react";
import ErrorBoundary from "@/components/hud/ErrorBoundary";
import { safeStorage } from "@/lib/safeStorage";

// ---- Columns ----
interface ColSpec { id: string; label: string; align?: "right" | "left"; default?: boolean }
const COLUMNS: ColSpec[] = [
  { id: "symbol",             label: "Stock",        default: true },
  { id: "sector",             label: "Sector" },
  { id: "industry",           label: "Industry" },
  { id: "market_cap",         label: "Mcap (₹Cr)",   align: "right", default: true },
  { id: "close",              label: "LTP (₹)",      align: "right", default: true },
  { id: "change_pct",         label: "1D Return (₹ / %)",align: "right", default: true },
  { id: "volume",             label: "Volume",       align: "right" },
  { id: "vol_avg30",          label: "30D Avg Vol",  align: "right" },
  { id: "vol_gt_avg30",       label: "Vol > 30D",    align: "right" },
  { id: "rel_volume",         label: "RVol",         align: "right" },
  { id: "pe",                 label: "PE",            align: "right" },
  { id: "pb",                 label: "PB",            align: "right" },
  { id: "peg",                label: "PEG",           align: "right" },
  { id: "eps",                label: "EPS",           align: "right" },
  { id: "book_value",         label: "Book Val",      align: "right" },
  { id: "roe",                label: "ROE",           align: "right" },
  { id: "roce",               label: "ROCE",          align: "right" },
  { id: "debt_equity",        label: "D/E",           align: "right" },
  { id: "sales_growth",       label: "Rev Grw",       align: "right" },
  { id: "profit_growth",      label: "PAT Grw",       align: "right" },
  { id: "eps_growth",         label: "EPS Grw",       align: "right" },
  { id: "dividend_yield",     label: "Div Yld",       align: "right" },
  { id: "promoter_holding",   label: "Promoter %",    align: "right" },
  { id: "dii_holding",        label: "DII %",         align: "right" },
  { id: "fii_holding",        label: "FII %",         align: "right" },
  { id: "institutional_holding", label: "Instl % (D+F)", align: "right" },

  { id: "rsi",                label: "RSI",           align: "right" },
  { id: "adx",                label: "ADX",           align: "right" },
  { id: "pct_from_52w_high",  label: "52w Δ",         align: "right", default: true },
  { id: "ret_5d",             label: "5D %",          align: "right" },
  { id: "ret_21d",            label: "1M %",          align: "right" },
  { id: "ret_ytd",            label: "YTD %",         align: "right" },
  { id: "breakout_score",     label: "Breakout",      align: "right", default: true },
  { id: "prebreakout_score",  label: "Pre-BO",        align: "right" },
  { id: "swing_score",        label: "Swing",         align: "right" },
  { id: "intraday_score",     label: "Intraday",      align: "right" },
  { id: "avg_turnover_cr",    label: "Turnover (₹Cr)",align: "right" },
  { id: "setup",              label: "Setup" },
];
// Explicit, in this exact order — not derived from COLUMNS' declaration
// order (which is grouped by category for the column picker, not display
// intent). Every user (not just whoever customised their own localStorage)
// lands on the same full default view: Stock, MCAP, LTP, 1D Return, Volume,
// RVol, PE, ROE, 52w Δ, Breakout.
const DEFAULT_COLS = [
  "symbol", "market_cap", "close", "change_pct", "volume",
  "rel_volume", "pe", "roe", "pct_from_52w_high", "breakout_score",
];
// v4: bumped so browsers holding the old 6-column v3 selection pick up the
// current default instead of rendering a stale, narrower table.
const COLS_STORE_KEY = "screener.visibleCols.v4";
const HIDE_ILLIQUID_KEY = "screener.hideIlliquid.v1";
const PAGE_SIZE_KEY  = "screener.pageSize.v2";
const DEFAULT_SAVED_KEY = "market.screener.defaultSavedId";
const STATE_STORE_KEY = "screener.state.v2"; // { universe, active, savedId } — persists across visits so re-opening doesn't reset filters or the attached saved screen

// Filter-id → column-id map used when the user has active filters. The
// results grid then renders ONLY the columns matching what they filtered on
// (plus Symbol as the row identity), matching Tickertape-style behaviour.
// FILTER_TO_COL and colsFromActiveFilters live in ../../lib/market/screenerColumns
// so /market Overview → Top Breakouts renders the same columns as this page.
import { colsFromActiveFilters as sharedColsFromActiveFilters } from "@/lib/market/screenerColumns";
const COL_IDS = new Set(COLUMNS.map((c) => c.id));
function colsFromActiveFilters(active: ActiveFilter[]): string[] {
  // Restrict to columns this Screener table actually renders and skip boolean
  // filters (Yes/No values are redundant with the active-filter chip).
  return sharedColsFromActiveFilters(active, { skipBooleans: true, allowedCols: COL_IDS });
}

function normalizeActiveFilters(filters: ActiveFilter[]): ActiveFilter[] {
  const byId = new Map<string, ActiveFilter>();
  const dropped: string[] = [];
  for (const raw of filters) {
    if (!raw?.id) continue;
    const id = canonicalFilterId(raw.id);
    if (!FILTER_BY_ID[id]) { dropped.push(raw.id); continue; }
    byId.set(id, { ...byId.get(id), ...raw, id });
  }
  if (dropped.length > 0 && typeof window !== "undefined") {
    // Non-fatal — a newer save format referenced a filter this build no longer
    // knows about. Warn once so shared links don't silently drop filters.
    console.warn("[screener] dropped unknown filters on load:", dropped);
  }
  return Array.from(byId.values());
}

function fmtBound(def: FilterDef, v: number | "" | undefined): string {
  if (v === undefined || v === "") return "*";
  const digits = def.step && def.step < 1 ? 2 : 0;
  const num = Number(v).toLocaleString("en-IN", { maximumFractionDigits: digits });
  const suffix = def.maxIsOpenEnded && def.max !== undefined && Number(v) === def.max ? "+" : "";
  return def.unit ? (def.unit === "₹" ? `₹${num}${suffix}` : `${num}${suffix}${def.unit === "%" || def.unit === "x" ? def.unit : " " + def.unit}`) : `${num}${suffix}`;
}

function chipDesc(af: ActiveFilter): string {
  const id = canonicalFilterId(af.id);
  const def = FILTER_BY_ID[id];
  if (!def) return id;
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

function ScreenerInner() {
  const push = useUi((s) => s.push);
  const nav = useNavigate();
  const qc = useQueryClient();

  // Persisted across visits — the Screener page should resume where the user left it,
  // not reset to All Stocks / no filters every time they navigate away and back.
  const persisted = useMemo(() => {
    const v2 = safeStorage.getJSON<{ universe?: UniverseId; active?: ActiveFilter[]; savedId?: string | null } | null>(STATE_STORE_KEY, null);
    if (v2) return v2;
    // One-shot migration off the old v1 key so returning users keep their setup.
    const v1 = safeStorage.getJSON<{ universe?: UniverseId; active?: ActiveFilter[] } | null>("screener.state.v1", null);
    return v1 ? { ...v1, savedId: null } : null;
  }, []);
  const [universe, setUniverse] = useState<UniverseId>(persisted?.universe ?? "all");
  const [active, setActive] = useState<ActiveFilter[]>(() => normalizeActiveFilters(persisted?.active ?? []));
  const [visibleCols, setVisibleCols] = useState<string[]>(() => {
    const parsed = safeStorage.getJSON<string[] | null>(COLS_STORE_KEY, null);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_COLS;
  });
  useEffect(() => { safeStorage.setJSON(COLS_STORE_KEY, visibleCols); }, [visibleCols]);

  // Penny/illiquid names are hidden by default (see LIQUIDITY_MIN_* gate in
  // scoring.ts) — an explicit opt-in surfaces them rather than silently
  // excluding names with no way back. `is_liquid_tradable == null` (gate not
  // yet computed for this row, e.g. pre-migration backfill) is treated as
  // "unknown" and always shown so this never hides the whole universe.
  const [hideIlliquid, setHideIlliquid] = useState<boolean>(() => safeStorage.getJSON<boolean>(HIDE_ILLIQUID_KEY, true));
  useEffect(() => { safeStorage.setJSON(HIDE_ILLIQUID_KEY, hideIlliquid); }, [hideIlliquid]);

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(() => {
    const raw = safeStorage.get(PAGE_SIZE_KEY);
    return raw ? Number(raw) || 50 : 50;
  });
  useEffect(() => { safeStorage.set(PAGE_SIZE_KEY, String(pageSize)); }, [pageSize]);

  const { data: rows = [], isFetching, error } = useScreenerData(universe);
  const sectorList = useScreenerSectors(rows);
  const industryList = useScreenerIndustries(rows);
  const { data: saved = [] } = useSavedScreeners();
  const { save, remove } = useScreenerMutations();

  // A symbol whose sync keeps failing (rename, delisting, thin Yahoo data)
  // keeps its last-successful trade_date/change_pct indefinitely — the pipeline
  // still advances its cursor so it isn't retried, but the row silently looks
  // "synced" while its numbers are for some earlier day, not today. Tech-scoped
  // filters (1D Return, Volume, Breakout, …) only trust rows on the freshest
  // trade_date actually present, everything else is treated as N/A.
  const latestTradeDate = useMemo(() => latestTradeDateOf(rows), [rows]);

  // Relative freshness (above) can't catch a pipeline that's stale across a
  // large chunk of the universe at once — those rows aren't outliers
  // relative to each other, they just look like "today's data." This checks
  // the freshest trade_date actually present against today's real IST date,
  // allowing extra slack on Mondays (Fri/Sat/Sun is a normal gap before the
  // day's EOD pipeline has run yet) so it doesn't false-positive every
  // Monday morning.
  const dataStaleDays = useMemo(() => {
    if (!latestTradeDate) return null;
    const latest = Date.parse(`${latestTradeDate}T00:00:00Z`);
    const today = Date.parse(`${todayIstDateString()}T00:00:00Z`);
    if (!Number.isFinite(latest) || !Number.isFinite(today)) return null;
    return Math.round((today - latest) / 86_400_000);
  }, [latestTradeDate]);
  const istDow = new Date(Date.now() + 5.5 * 3600_000).getUTCDay(); // 0=Sun..6=Sat, IST-shifted
  const staleThresholdDays = istDow === 1 ? 3 : 1; // Monday: Fri/Sat/Sun gap is normal
  const isDataStale = dataStaleDays != null && dataStaleDays > staleThresholdDays;

  // Worst-of-3 coverage summary for the compact status pill in the Results
  // header. Full breakdown still lives behind the Health modal.
  const healthSummary = useMemo(() => {
    const eq = rows.filter(isEquityRow);
    if (eq.length === 0) return null;
    const fundOk = eq.filter((r) => r.pe != null || r.roe != null || r.market_cap != null).length;
    const sectorOk = eq.filter((r) => r.sector != null).length;
    const withScore = eq.filter((r) => r.trade_date != null);
    const techOk = withScore.filter((r) => r.rsi != null || r.adx != null).length;
    const fundPct = Math.round((fundOk / eq.length) * 100);
    const sectorPct = Math.round((sectorOk / eq.length) * 100);
    const techPct = withScore.length ? Math.round((techOk / withScore.length) * 100) : 0;
    const worst = Math.min(fundPct, sectorPct, techPct);
    const tone: "ok" | "warn" | "err" = worst >= 95 ? "ok" : worst >= 80 ? "warn" : "err";
    return { fundPct, sectorPct, techPct, tone, eod: latestTradeDate };
  }, [rows, latestTradeDate]);

  const illiquidCount = useMemo(() => rows.filter((r) => r.is_liquid_tradable === false).length, [rows]);

  // Change %/Price come from the once-daily EOD pipeline (market_stock_scores),
  // while the results table's Chg%/Price columns overlay a live quote for
  // display — filtering on the stale value while showing the live one meant a
  // user's range could silently disagree with what they saw on screen. Defer
  // those two filters to a second pass, applied against the same live overlay
  // the columns already use, once the candidate set is narrowed by everything
  // else and small enough to batch-quote.
  // Screener parity is EOD-first: filters and visible Price/Chg% are evaluated
  // from the same settled row, matching Tickertape-style screeners. Live quote
  // overlays made the result set drift during market hours.
  // Freshness is enforced by rowIsApplicable inside filterMatches (tech scope),
  // which allows a small lag window (see TECH_FRESHNESS_LAG_DAYS). Dropping
  // every row not on the exact latestTradeDate here was silently removing
  // symbols one trading-day behind (Yahoo skipped a session) and made the
  // result count differ from Tickertape. The scoped applicability check now
  // owns freshness; this pass just runs the active filters.
  const filtered = useMemo(() => {
    let out: ScreenerRow[] = rows;
    if (hideIlliquid) out = out.filter((r) => r.is_liquid_tradable !== false);
    for (const af of active) {
      out = out.filter((r) => filterMatches(r as any, af, latestTradeDate));
    }
    return out;
  }, [rows, active, latestTradeDate, hideIlliquid]);


  useEffect(() => { setPage(0); }, [active, universe, pageSize]);

  // ---- URL-serialized state (Phase 6): ?f=<b64(JSON)> — shareable screens ----
  const didHydrateFromUrlRef = useRef(false);
  useEffect(() => {
    if (didHydrateFromUrlRef.current) return;
    try {
      const p = new URLSearchParams(window.location.search).get("f");
      if (!p) return;
      const bytes = Uint8Array.from(atob(decodeURIComponent(p)), (c) => c.charCodeAt(0));
      const raw = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(raw);
      if (parsed?.universe) setUniverse(parsed.universe as UniverseId);
      if (Array.isArray(parsed?.active)) setActive(normalizeActiveFilters(parsed.active));
      didHydrateFromUrlRef.current = true;
    } catch { /* ignore malformed */ }
  }, []);
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (active.length === 0 && universe === "all") {
        url.searchParams.delete("f");
      } else {
        const payload = JSON.stringify({ universe, active });
        const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(payload)));
        url.searchParams.set("f", b64);
      }
      window.history.replaceState(null, "", url.toString());
    } catch { /* */ }
  }, [universe, active]);


  // "+ Add Filter" picker: bring a filter into the sidebar with an empty
  // value, ready to edit — bypasses setFilterValue's auto-drop-when-empty
  // (below) since an intentionally-just-added filter should stick around
  // with blank inputs, not vanish immediately.
  const addFilter = (fid: string) => {
    const id = canonicalFilterId(fid);
    if (active.some((a) => canonicalFilterId(a.id) === id)) return;
    const def = FILTER_BY_ID[id]; if (!def) return;
    const initial: ActiveFilter =
      def.kind === "boolean" ? { id, bool: true } :
      def.kind === "enum"    ? { id, values: [] } :
      { id };
    setActive((a) => [...a, initial]);
  };

  // Inline sidebar editors call this on every keystroke/toggle. We keep the
  // row in `active` even when its value is empty — removal is explicit via
  // the row's X button (onClear→removeFilter). Auto-dropping on empty made
  // "+ Add Filter" seem to instantly delete the row when the editor's
  // initial onChange fired with a blank value.
  const setFilterValue = (fid: string, patch: Partial<ActiveFilter>) => {
    const id = canonicalFilterId(fid);
    setActive((a) => {
      const existing = a.find((x) => canonicalFilterId(x.id) === id);
      const merged: ActiveFilter = existing ? { ...existing, ...patch, id } : { id, ...patch };
      return existing ? a.map((x) => (canonicalFilterId(x.id) === id ? merged : x)) : [...a, merged];
    });
  };

  const removeFilter = (fid: string) => {
    const id = canonicalFilterId(fid);
    setActive((a) => a.filter((af) => canonicalFilterId(af.id) !== id));
  };

  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveModalName, setSaveModalName] = useState("");
  // Ctrl/Cmd+S opens the Save-as modal (or Save-in-place when attached).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setSaveModalOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Track which saved screen is currently loaded so we can badge it on the
  // page (name + "modified" state) and update-in-place instead of always
  // inserting duplicates on Save.
  const [activeSavedId, setActiveSavedId] = useState<string | null>(persisted?.savedId ?? null);
  const [activeSavedSig, setActiveSavedSig] = useState<string | null>(null);
  // Normalize before hashing so identical-looking states (e.g. "" vs undefined,
  // "5" vs 5, unsorted enum values) don't get mis-flagged as "modified".
  const sigOf = (u: UniverseId, a: ActiveFilter[]) => {
    const norm = a
      .map((x) => {
        const id = canonicalFilterId(x.id);
        const min = x.min === "" || x.min === undefined ? null : Number(x.min);
        const max = x.max === "" || x.max === undefined ? null : Number(x.max);
        const bool = x.bool === undefined ? null : Boolean(x.bool);
        const values = Array.isArray(x.values) ? [...x.values].sort() : null;
        return { id, min, max, bool, values };
      })
      .sort((x, y) => x.id.localeCompare(y.id));
    return JSON.stringify({ u, a: norm });
  };
  const currentSig = sigOf(universe, active);
  const activeSaved = activeSavedId ? saved.find((s) => s.id === activeSavedId) ?? null : null;
  const isModified = !!activeSaved && activeSavedSig !== null && currentSig !== activeSavedSig;
  // Persist filters + attached saved-id so a page reload restores the badge too.
  useEffect(() => { safeStorage.setJSON(STATE_STORE_KEY, { universe, active, savedId: activeSavedId }); }, [universe, active, activeSavedId]);
  // Clear ?f= as soon as a saved screen is attached — the savedId in
  // localStorage is enough, and a stale ?f= would otherwise override on reload.
  useEffect(() => {
    if (!activeSavedId) return;
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("f")) {
        url.searchParams.delete("f");
        window.history.replaceState(null, "", url.toString());
      }
    } catch { /* */ }
  }, [activeSavedId]);
  const detachSaved = () => {
    setActiveSavedId(null);
    setActiveSavedSig(null);
    try { localStorage.removeItem(DEFAULT_SAVED_KEY); } catch { /* */ }
  };

  const saveScreener = (nameArg?: string) => {
    // If a saved screen is loaded and no explicit name was given, update
    // it in place. Otherwise insert a new row under the given name.
    const trimmed = (nameArg ?? "").trim();
    if (activeSaved && !trimmed) {
      save.mutate(
        { id: activeSaved.id, name: activeSaved.name, filters: { v: 3, universe, active } as any },
        {
          onSuccess: () => {
            push(`Updated: ${activeSaved.name}`, "ok");
            setActiveSavedSig(currentSig);
          },
          onError: (e) => push(e.message, "err"),
        }
      );
      return;
    }
    if (!trimmed) { push("Name the screener first", "warn"); return; }
    save.mutate(
      { name: trimmed, filters: { v: 3, universe, active } as any },
      {
        onSuccess: () => {
          push("Screener saved", "ok");
          setSaveModalOpen(false);
          setSaveModalName("");
        },
        onError: (e) => push(e.message, "err"),
      }
    );
  };
  const loadSaved = (s: SavedScreener) => {
    const f: any = s.filters;
    let nextUniverse: UniverseId = "all";
    let nextActive: ActiveFilter[] = [];
    if (f && typeof f === "object" && !Array.isArray(f) && (f.v === 2 || f.v === 3)) {
      nextUniverse = (f.universe as UniverseId) ?? "all";
      nextActive = Array.isArray(f.active) ? normalizeActiveFilters(f.active) : [];
    } else if (Array.isArray(f)) {
      const conds = f[0]?.conditions ?? [];
      const mapped: ActiveFilter[] = [];
      for (const c of conds) {
        const id = canonicalFilterId(c.column);
        if (!FILTER_BY_ID[id]) continue;
        const isBool = FILTER_BY_ID[id].kind === "boolean";
        if (isBool) mapped.push({ id, bool: c.op === "is_true" });
        else if (c.op === "gte" || c.op === "gt") mapped.push({ id, min: Number(c.value) });
        else if (c.op === "lte" || c.op === "lt") mapped.push({ id, max: Number(c.value) });
        else if (c.op === "eq") mapped.push({ id, min: Number(c.value), max: Number(c.value) });
      }
      nextActive = normalizeActiveFilters(mapped);
      nextUniverse = "all";
    }
    setUniverse(nextUniverse);
    setActive(nextActive);
    setActiveSavedId(s.id);
    setActiveSavedSig(sigOf(nextUniverse, nextActive));
    try { localStorage.setItem(DEFAULT_SAVED_KEY, s.id); } catch { /* */ }
    push(`Loaded: ${s.name}`, "ok");
  };

  // Auto-apply the last-loaded saved screener on mount (unless a shared ?f= link
  // is present — URL state wins). Runs once, when `saved` first resolves.
  // If persisted state already has a savedId, we re-attach it (no filter
  // rewrite — persisted filters win, we just restore the badge + baseline sig).
  const didAutoLoadRef = useRef(false);
  useEffect(() => {
    if (didAutoLoadRef.current) return;
    if (saved.length === 0) return;
    try {
      if (new URLSearchParams(window.location.search).get("f")) { didAutoLoadRef.current = true; return; }
      // Re-attach previously-loaded saved screen so the "★ Screen 2" badge
      // survives reloads even when persisted filters win.
      if (activeSavedId) {
        const match = saved.find((s) => s.id === activeSavedId);
        if (match) {
          const f: any = match.filters;
          const baseUniverse: UniverseId = (f && typeof f === "object" && !Array.isArray(f) && f.universe) ? f.universe as UniverseId : "all";
          const baseActive: ActiveFilter[] = (f && typeof f === "object" && !Array.isArray(f) && Array.isArray(f.active))
            ? normalizeActiveFilters(f.active) : [];
          setActiveSavedSig(sigOf(baseUniverse, baseActive));
          didAutoLoadRef.current = true;
          return;
        }
      }
      if (persisted && ((persisted.active && persisted.active.length > 0) || (persisted.universe && persisted.universe !== "all"))) {
        didAutoLoadRef.current = true; return;
      }
      const id = localStorage.getItem(DEFAULT_SAVED_KEY);
      if (!id) { didAutoLoadRef.current = true; return; }
      const match = saved.find((s) => s.id === id);
      if (match) loadSaved(match);
    } catch { /* */ }
    didAutoLoadRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  // When the user has active filters, the results grid renders ONLY the
  // columns matching those filters (plus Symbol). With no filters we fall
  // back to the user's saved column preset. This mirrors Tickertape's
  // "columns follow filters" behaviour.
  // Core columns always lead, in this fixed order, regardless of which
  // filters are active — otherwise LTP/1D Return/MCAP/Breakout silently
  // disappear or reorder whenever the active filter set doesn't happen to
  // touch them (matches the same fix on the Dashboard's Top Breakouts table).
  const effectiveCols = useMemo(
    () => {
      if (active.length === 0) return visibleCols;
      // When filters are active, show the core columns + whichever extra
      // columns correspond to each selected filter — nothing else beyond that.
      const filterCols = colsFromActiveFilters(active).filter((id) => !DEFAULT_COLS.includes(id));
      const seen = new Set<string>();
      return [...DEFAULT_COLS, ...filterCols].filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
    },
    [active, visibleCols],
  );

  // Always default-sort by breakout_score, regardless of active filters —
  // previously a "change_pct" filter silently switched the default sort to
  // 1D Return instead.
  const defaultSorting = useMemo<SortingState>(() => [{ id: "breakout_score", desc: true }], []);
  const [sorting, setSorting] = useState<SortingState>(defaultSorting);
  useEffect(() => { setSorting(defaultSorting); }, [defaultSorting]);

  const sorted = useMemo(() => {
    if (sorting.length === 0) return filtered;
    const { id, desc } = sorting[0];
    const field = id === "livePrice" ? "ltp" : id === "liveChangePct" ? "change_pct" : id;
    return [...filtered].sort((a, b) => {
      const av = (a as any)[field];
      const bv = (b as any)[field];
      if (av == null && bv == null) return a.symbol.localeCompare(b.symbol);
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return (desc ? -cmp : cmp) || a.symbol.localeCompare(b.symbol);
    });
  }, [filtered, sorting]);

  const exportCsv = () => {
    const csv = toCsv(sorted, effectiveCols);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url; a.download = `screener_${universe}_${active.length}f_${sorted.length}rows_${stamp}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  // Paginate only after globally sorting the complete filtered collection.
  const pageStart = page * pageSize;
  const paged = useMemo(() => sorted.slice(pageStart, pageStart + pageSize), [sorted, pageStart, pageSize]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));

  // ---- Live overlay for visible rows (Kotak WS push + 2s REST poll) --------
  // Filter math stays on EOD (see comment at "Screener parity is EOD-first"
  // above). But the *displayed* Price and 1D% shouldn't sit frozen at
  // yesterday's close all session — overlay live quotes on top of the
  // currently paginated set only (Kotak batch quote limit + relay cap ~100).
  const visibleKeysJoined = useMemo(
    () => Array.from(new Set(paged.map((r) => quoteKey(r.exchange ?? "NSE", r.symbol)))).sort().join(","),
    [paged],
  );
  const visibleKeys = useMemo(() => (visibleKeysJoined ? visibleKeysJoined.split(",") : []), [visibleKeysJoined]);
  const { data: liveQuotes } = useQuotes(visibleKeys, { intervalMs: 2_000 });
  const pushTicks = useLiveTickStore((s) => s.ticks);
  const relayAlive = useRelayAlive();
  useEffect(() => { subscribeSymbolsForTicks(visibleKeys); }, [visibleKeysJoined]);
  const liveByKey = useMemo(() => {
    const m = new Map<string, { ltp: number | null; change_pct: number | null; provider: string | null }>();
    for (const q of liveQuotes?.quotes ?? []) {
      m.set(quoteKey(q.exchange, q.symbol), {
        ltp: q.ltp ?? null,
        change_pct: q.change_pct ?? null,
        provider: (q as any).provider ?? q.source ?? null,
      });
    }
    // Push ticks always come from the Kotak WS relay — treat as "kotak".
    for (const [key, tick] of Object.entries(pushTicks)) {
      if (!isFreshTick(tick)) continue;
      m.set(key, { ltp: tick.ltp, change_pct: tick.change_pct, provider: "kotak" });
    }
    return m;
  }, [liveQuotes, pushTicks]);
  const anyPush = useMemo(() => visibleKeys.some((k) => isFreshTick(pushTicks[k])), [visibleKeys, pushTicks]);
  const quoteProvider = (liveQuotes as any)?.provider as
    | "kotak" | "yahoo" | "mixed" | "cache" | "none" | undefined;
  // "push" > "kotak" (REST) > "mixed" > "yahoo/cache/closed"
  const nowIst = new Date(Date.now() + 5.5 * 3600_000);
  const istMin = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes();
  const istDay = nowIst.getUTCDay();
  const nseOpenNow = istDay >= 1 && istDay <= 5 && istMin >= 555 && istMin < 930;
  const liveState = useMemo<"push" | "kotak" | "mixed" | "yahoo" | "cache" | "closed" | "idle">(() => {
    if (visibleKeys.length === 0) return "idle";
    if (anyPush || relayAlive) return "push";
    if (quoteProvider === "kotak") return "kotak";
    if (quoteProvider === "mixed") return "mixed";
    if (quoteProvider === "cache") return nseOpenNow ? "cache" : "closed";
    return nseOpenNow ? "yahoo" : "closed";
  }, [visibleKeys.length, anyPush, relayAlive, quoteProvider, nseOpenNow]);

  // Provider guardrail — Kotak disconnected banner + reconnect prompt.
  const { data: mkSettings = [] } = useMarketSettings();
  const kotakRow = mkSettings.find((s: any) => s.active_provider === "kotak_neo");
  const kotakConnected = kotakRow?.connection_status === "connected";
  const kotakConfigured = !!kotakRow?.consumer_key;
  const kotakDisconnected = kotakConfigured && !kotakConnected;
  const showKotakBanner =
    !kotakConnected &&
    (quoteProvider === "yahoo" || quoteProvider === "mixed" || quoteProvider === "cache") &&
    typeof window !== "undefined" && !sessionStorage.getItem("mk.screener.kotak-banner.dismissed");
  const openKotakReconnect = () => {
    try { window.dispatchEvent(new Event("kotak:reconnect")); } catch { /* */ }
  };

  const columns = useMemo<ColumnDef<ScreenerRow, any>[]>(() => {
    const all: Record<string, ColumnDef<ScreenerRow, any>> = {
      symbol: {
        header: "Stock", accessorKey: "symbol",
        cell: ({ row }) => {
          const stale = latestTradeDate != null && row.original.trade_date != null && row.original.trade_date !== latestTradeDate;
          const name = row.original.company_name;
          return (
            <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 1.2 }}>
              <span style={{ color: "var(--text)", fontWeight: 500 }}>
                {name ?? row.original.symbol}
                {stale && (
                  <span title={`EOD stale: ${row.original.trade_date} vs latest ${latestTradeDate}`}
                    style={{ marginLeft: 6, fontSize: 9, color: "var(--danger, #ff6a6a)", border: "1px solid currentColor", padding: "0 4px", borderRadius: 2 }}>STALE</span>
                )}
              </span>
              <span style={{ color: "var(--accent)", fontSize: 10 }}>{row.original.symbol}</span>
            </span>
          );
        },
      },
      sector:  {
        header: "Sector",  accessorKey: "sector",
        cell: ({ row }) => (
          <span style={{ fontSize: 11 }} title={row.original.sub_sector ?? row.original.industry ?? undefined}>
            {row.original.sector ?? "—"}
          </span>
        ),
      },
      industry:{ header: "Industry",accessorKey: "industry",cell: ({ getValue }) => <span style={{ fontSize: 11 }}>{getValue() as string ?? "—"}</span> },
      market_cap: {
        header: "Mcap (₹Cr)", accessorKey: "market_cap", meta: { align: "right" },
        cell: ({ row, getValue }) => {
          const v = getValue() as number | null;
          const prov = row.original.data_provenance as Record<string, any> | null | undefined;
          const src = prov?.market_cap_source ?? prov?.mcap_source ?? prov?.source;
          const asOf = prov?.market_cap_as_of ?? prov?.mcap_as_of;
          const tip = src ? `source: ${src}${asOf ? ` · ${new Date(asOf).toLocaleDateString("en-IN")}` : ""}` : undefined;
          return <span title={tip}>{fmtInt(v)}</span>;
        },
      },
      close: {
        header: "LTP (₹)", id: "livePrice", meta: { align: "right" },
        accessorFn: (r) => {
          const live = liveByKey.get(quoteKey(r.exchange ?? "NSE", r.symbol));
          // Only overlay when the live value actually came from Kotak (push
          // tick or Kotak REST). Yahoo/cache values would silently disagree
          // with the EOD row the filter matched on, so we stay on EOD.
          if (live && live.provider === "kotak" && live.ltp != null) return live.ltp;
          return r.ltp;
        },
        cell: ({ getValue }) => fmtNum(getValue() as number | null),
      },
      change_pct: {
        header: "1D Return", id: "liveChangePct", meta: { align: "right" },
        accessorFn: (r) => {
          const live = liveByKey.get(quoteKey(r.exchange ?? "NSE", r.symbol));
          if (live && live.provider === "kotak" && live.change_pct != null) return live.change_pct;
          return r.change_pct;
        },
        cell: ({ row }) => {
          const r = row.original;
          const live = liveByKey.get(quoteKey(r.exchange ?? "NSE", r.symbol));
          const livePct = live && live.provider === "kotak" && live.change_pct != null ? live.change_pct : null;
          const pct = livePct ?? r.change_pct ?? null;
          const abs = live && live.provider === "kotak" && live.ltp != null && live.change_pct != null
            ? deriveChangeAbs(live.ltp, live.change_pct)
            : (r.change_abs ?? null);
          return <Return1DCell abs={abs} pct={pct} />;
        },
      },
      volume: {
        header: "Volume", accessorKey: "volume", meta: { align: "right" },
        cell: ({ getValue }) => {
          const v = getValue() as number | null;
          return v == null ? "—" : fmtInt(v);
        },
      },
      vol_avg30: { header: "30D Avg Vol", accessorKey: "vol_avg30", meta: { align: "right" }, cell: ({ getValue }) => fmtInt(getValue() as number | null) },
      vol_gt_avg30: { header: "Vol > 30D", accessorKey: "vol_gt_avg30", meta: { align: "right" }, cell: ({ getValue }) => getValue() == null ? "—" : getValue() ? "Yes" : "No" },
      rel_volume: { header: "RVol", accessorKey: "rel_volume", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 1) },
      pe: { header: "PE", accessorKey: "pe", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 1) },
      pb: { header: "PB", accessorKey: "pb", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 1) },
      peg: { header: "PEG", accessorKey: "peg", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 2) },
      eps: { header: "EPS", accessorKey: "eps", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 1) },
      book_value: { header: "Book Val", accessorKey: "book_value", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 1) },
      roe: { header: "ROE", accessorKey: "roe", meta: { align: "right" }, cell: ({ getValue }) => {
        const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(1)}%`;
      }},
      roce: { header: "ROCE", accessorKey: "roce", meta: { align: "right" }, cell: ({ getValue }) => {
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
      dii_holding: { header: "DII %", accessorKey: "dii_holding", meta: { align: "right" }, cell: ({ getValue }) => {
        const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(1)}%`;
      }},
      fii_holding: { header: "FII %", accessorKey: "fii_holding", meta: { align: "right" }, cell: ({ getValue }) => {
        const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(1)}%`;
      }},
      institutional_holding: { header: "Instl % (D+F)", accessorKey: "institutional_holding", meta: { align: "right" }, cell: ({ getValue }) => {
        const v = getValue() as number | null; return v == null ? "—" : `${v.toFixed(1)}%`;
      }},

      rsi: { header: "RSI", accessorKey: "rsi", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 0) },
      adx: { header: "ADX", accessorKey: "adx", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 0) },
      pct_from_52w_high: { header: "52w Δ", accessorKey: "pct_from_52w_high", meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue() as number | null} /> },
      ret_5d:  { header: "5D %",  accessorKey: "ret_5d",  meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue() as number | null} /> },
      ret_21d: { header: "1M %",  accessorKey: "ret_21d", meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue() as number | null} /> },
      ret_ytd: { header: "YTD %", accessorKey: "ret_ytd", meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue() as number | null} /> },
      breakout_score: {
        header: "Breakout", accessorKey: "breakout_score", meta: { align: "right" },
        cell: ({ row }) => <ScoreBadge score={row.original.breakout_score} components={row.original.score_components?.breakout} label="breakout components" onClick={() => nav(`/market/ai/${row.original.symbol}`)} />,
      },
      prebreakout_score: {
        header: "Pre-BO", accessorKey: "prebreakout_score", meta: { align: "right" },
        cell: ({ row }) => <ScoreBadge score={row.original.prebreakout_score} components={row.original.score_components?.prebreakout} label="pre-breakout components" onClick={() => nav(`/market/ai/${row.original.symbol}`)} />,
      },
      swing_score: {
        header: "Swing", accessorKey: "swing_score", meta: { align: "right" },
        cell: ({ row }) => <ScoreBadge score={row.original.swing_score} components={row.original.swing_components} label="swing components" onClick={() => nav(`/market/ai/${row.original.symbol}`)} />,
      },
      intraday_score: {
        header: "Intraday", accessorKey: "intraday_score", meta: { align: "right" },
        cell: ({ row }) => <ScoreBadge score={row.original.intraday_score} components={row.original.intraday_components} label="intraday components" onClick={() => nav(`/market/ai/${row.original.symbol}`)} />,
      },
      avg_turnover_cr: {
        header: "Turnover (₹Cr)", accessorKey: "avg_turnover_cr", meta: { align: "right" },
        cell: ({ getValue }) => fmtNum(getValue() as number | null, 1),
      },
      atr_pct: { header: "ATR %", accessorKey: "atr_pct", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 1) },
      macd_hist: { header: "MACD Hist", accessorKey: "macd_hist", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 2) },
      bb_width: { header: "BB Width", accessorKey: "bb_width", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 3) },
      rel_strength_nifty: { header: "RS vs NIFTY", accessorKey: "rel_strength_nifty", meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue() as number | null} /> },
      sector_strength: { header: "Sector Str", accessorKey: "sector_strength", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 2) },
      high_52w: { header: "52w High", accessorKey: "high_52w", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null) },
      low_52w: { header: "52w Low", accessorKey: "low_52w", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null) },
      current_ratio: { header: "Current Ratio", accessorKey: "current_ratio", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 2) },
      quick_ratio: { header: "Quick Ratio", accessorKey: "quick_ratio", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue() as number | null, 2) },
      sales: { header: "Sales (₹Cr)", accessorKey: "sales", meta: { align: "right" }, cell: ({ getValue }) => fmtInt(getValue() as number | null) },
      net_profit: { header: "Net Profit (₹Cr)", accessorKey: "net_profit", meta: { align: "right" }, cell: ({ getValue }) => fmtInt(getValue() as number | null) },
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
    return effectiveCols.map((id) => all[id]).filter(Boolean);
  }, [effectiveCols, latestTradeDate, liveByKey, nav]);

  const columnsWithActions = useMemo<ColumnDef<ScreenerRow, any>[]>(() => {
    return [
      ...columns,
      {
        id: "actions", header: "", enableSorting: false, meta: { align: "right" } as any,
        cell: ({ row }: any) => (
          <AddToWatchlistButton
            symbol={row.original.symbol}
            exchange={(row.original.exchange as "NSE" | "BSE") ?? "NSE"}
          />
        ),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns]);

  const [healthOpen, setHealthOpen] = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%", minHeight: 0 }}>
      {/* Slim toolbar — no wasted vertical space, no duplicate name. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: "6px 8px", border: "1px solid var(--edge)",
        background: "rgba(53,214,237,0.03)",
      }}>
        
        <SavedPicker saved={saved} activeId={activeSavedId} onLoad={loadSaved} onDelete={(id) => {
          try { if (localStorage.getItem(DEFAULT_SAVED_KEY) === id) localStorage.removeItem(DEFAULT_SAVED_KEY); } catch { /* */ }
          if (activeSavedId === id) { setActiveSavedId(null); setActiveSavedSig(null); }
          remove.mutate(id, { onError: (e) => push(e.message, "err") });
        }} />
        <Btn size="sm" onClick={() => {
          if (activeSaved && isModified) { saveScreener(); return; }
          setSaveModalName(activeSaved ? "" : "");
          setSaveModalOpen(true);
        }}>
          <Save size={11} style={{ marginRight: 4 }} />
          {activeSaved && isModified ? "Update" : "Save"}
        </Btn>
        {active.length > 0 && (
          <Btn size="sm" variant="ghost" onClick={() => setActive([])} title="Clear all filter values (keeps saved screen attached)">
            <RotateCcw size={11} style={{ marginRight: 4 }} />Clear values
          </Btn>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontFamily: "var(--font-hud)", fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
            {isFetching ? "loading…" : `${filtered.length} / ${rows.length}`}
          </span>
        </div>
      </div>

      {isDataStale && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
          border: "1px solid var(--danger)", borderRadius: 2, background: "rgba(255,80,80,0.08)",
        }}>
          <AlertTriangle size={14} color="var(--danger)" style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: "var(--danger)" }}>
            Data is {dataStaleDays} day{dataStaleDays === 1 ? "" : "s"} behind — EOD pipeline hasn't caught up.
          </span>
        </div>
      )}

      {showKotakBanner && (
        <div role="status" style={{
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          padding: "6px 10px", border: "1px dashed var(--edge-strong, var(--edge))", borderRadius: 3,
          fontSize: 11, color: "var(--text-dim, var(--text-muted))", background: "rgba(255,180,60,0.04)", flexShrink: 0,
        }}>
          <span style={{ color: "var(--warn, #f5a524)" }}>●</span>
          <span>Prices are <b>~15 minutes delayed</b> (Yahoo Finance). Connect Kotak Neo for real-time quotes.</span>
          <Link to="/market/settings" style={{
            marginLeft: "auto", color: "var(--accent)", textDecoration: "none",
            border: "1px solid var(--edge)", padding: "2px 8px", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase",
          }}>Connect Kotak Neo</Link>
          <button
            onClick={() => { sessionStorage.setItem("mk.screener.kotak-banner.dismissed", "1"); qc.invalidateQueries({ queryKey: ["market"] }); }}
            aria-label="Dismiss for this session"
            className="hud-btn focus-outline" data-variant="ghost" data-size="sm"
            title="Dismiss for this session"
          ><X size={12} /></button>
        </div>
      )}

      {/* Save-as modal — replaces the always-visible inline input. */}
      <HudModal open={saveModalOpen} onClose={() => setSaveModalOpen(false)}
        title={activeSaved ? `Save a copy of "${activeSaved.name}"` : "Save screener"} width={380}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={labelStyle}>Name</label>
          <input autoFocus value={saveModalName} onChange={(e) => setSaveModalName(e.target.value)}
            placeholder="e.g. High-volume breakouts"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveScreener(saveModalName); } }}
            style={{ ...inputStyle, padding: "8px 10px", fontSize: 12 }} />
          {saveModalName.trim() && saved.some((s) => s.name.trim().toLowerCase() === saveModalName.trim().toLowerCase() && s.id !== activeSaved?.id) && (
            <span style={{ fontSize: 11, color: "var(--warn, #d29a2b)" }}>
              A screen named "{saveModalName.trim()}" already exists — this will create a duplicate.
            </span>
          )}
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 4 }}>
            <Btn size="sm" variant="ghost" onClick={() => setSaveModalOpen(false)}>Cancel</Btn>
            <Btn size="sm" onClick={() => saveScreener(saveModalName)} disabled={!saveModalName.trim()}>Save</Btn>
          </div>
        </div>
      </HudModal>

      {/* Health drawer — chips no longer clutter the header. */}
      <HudModal open={healthOpen} onClose={() => setHealthOpen(false)} title="Data health & pipeline" width={520}>
        <DataHealthStrip rows={rows} universe={universe} filteredCount={filtered.length} loading={isFetching} />
      </HudModal>

      {/* Two-pane workspace — fills the remaining viewport, no wasted space. */}
      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 8, alignItems: "stretch", flex: 1, minHeight: 0 }}>
        <div style={{ minHeight: 0, overflow: "auto" }}>
          <FilterRail rows={rows} active={active} onAdd={addFilter} onChange={setFilterValue} onClear={removeFilter}
            sectorList={sectorList} industryList={industryList}
            universe={universe} onUniverseChange={setUniverse} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, minHeight: 0 }}>
          <HudPanel flow title={`Results · ${filtered.length}${filtered.length !== rows.length ? ` of ${rows.length}` : ""}`} style={{ flex: 1, minHeight: 0 }}
            live={isFetching ? "warn" : error ? "err" : "ok"}
            actions={
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {(() => {
                  const disc = kotakDisconnected && (liveState === "yahoo" || liveState === "cache" || liveState === "mixed" || liveState === "idle");
                  const label = disc
                    ? "kotak disconnected · reconnect"
                    : liveState === "push"   ? "push · kotak"
                    : liveState === "kotak"  ? "live · kotak"
                    : liveState === "mixed"  ? "live · mixed"
                    : liveState === "yahoo"  ? "delayed · yahoo"
                    : liveState === "cache"  ? "cached"
                    : liveState === "closed" ? "closed" : "idle";
                  const tone = disc ? "var(--danger, #ff6a6a)"
                    : liveState === "push" || liveState === "kotak" ? "var(--ok, #4ade80)"
                    : liveState === "mixed" ? "var(--warn, #d29a2b)"
                    : liveState === "yahoo" || liveState === "cache" ? "var(--danger, #ff6a6a)"
                    : "var(--text-muted)";
                  const Cmp: any = disc ? "button" : "span";
                  return (
                    <Cmp
                      onClick={disc ? openKotakReconnect : undefined}
                      title={disc
                        ? "Kotak Neo session isn't connected — click to reconnect and enable real-time quotes."
                        : "Price / 1D% source for the visible page — filters and other columns stay on EOD."}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 6,
                        padding: "3px 8px", border: "1px solid var(--edge)",
                        background: "transparent",
                        fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase",
                        color: disc ? "var(--danger, #ff6a6a)" : "var(--text-muted)",
                        borderRadius: 2, cursor: disc ? "pointer" : "default",
                      }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: tone }} />
                      {label}
                    </Cmp>
                  );
                })()}
                {healthSummary && (
                  <button type="button" onClick={() => setHealthOpen(true)}
                    title={`Pipeline: Fund ${healthSummary.fundPct}% · Sector ${healthSummary.sectorPct}% · Tech ${healthSummary.techPct}% — click for details`}
                    aria-label="Data health details"
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6,
                      padding: "3px 8px", border: "1px solid var(--edge)", background: "transparent",
                      color: "var(--text-muted)", cursor: "pointer",
                      fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase",
                      borderRadius: 2,
                    }}>
                    <span style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: healthSummary.tone === "ok" ? "var(--ok, #4ade80)"
                        : healthSummary.tone === "warn" ? "var(--warn, #d29a2b)"
                        : "var(--danger, #ff6a6a)",
                    }} />
                    EOD {healthSummary.eod ?? "—"} · same-session values
                  </button>
                )}
                <button type="button" onClick={() => setHideIlliquid((v) => !v)}
                  title={hideIlliquid
                    ? `Hiding ${illiquidCount} penny/illiquid name${illiquidCount === 1 ? "" : "s"} (price/mcap/turnover below the liquidity floor) — click to show them`
                    : "Showing all stocks, including penny/illiquid names — click to hide them again"}
                  aria-label="Toggle penny/illiquid stocks"
                  aria-pressed={hideIlliquid}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    padding: "3px 8px", border: "1px solid var(--edge)",
                    background: hideIlliquid ? "transparent" : "var(--accent-dim, rgba(255,184,77,0.12))",
                    color: hideIlliquid ? "var(--text-muted)" : "var(--accent)",
                    cursor: "pointer",
                    fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase",
                    borderRadius: 2,
                  }}>
                  {hideIlliquid ? <Check size={11} /> : <X size={11} />}
                  {hideIlliquid ? "Liquid only" : "All (incl. penny)"}
                </button>
                <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}
                  style={{ ...inputStyle, padding: "4px 6px", fontSize: 11 }}
                  title="Rows per page">
                  {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}/page</option>)}
                </select>
                {/* Columns · CSV grouped together as one cluster */}
                <div style={{ display: "inline-flex", gap: 4, padding: 2, border: "1px solid var(--edge)", borderRadius: 2 }}>
                  <ColumnPicker value={visibleCols} onChange={setVisibleCols} />
                  <Btn size="sm" onClick={exportCsv} disabled={filtered.length === 0} title="Export as CSV" aria-label="Export CSV">
                    <Download size={11} />
                  </Btn>
                </div>
              </div>
            }
          >
            {error ? (
              <EmptyState hint={String((error as Error).message)}>failed to load</EmptyState>
            ) : (
              <>
                <DataTable
                  columns={columnsWithActions}
                  data={paged}
                  sorting={sorting}
                  onSortingChange={setSorting}
                  onRowClick={(r) => nav(`/market/analysis/${r.symbol}`)}
                  numbered
                  startIndex={pageStart}
                  maxHeight="100%"
                  emptyLabel={rows.length === 0 && !isFetching ? "market pipeline is warming up" : "no matches"}
                  emptyHint={rows.length === 0 && !isFetching ? "automatic sync is enabled; refresh shortly" : "loosen the filters or change the universe"}
                />

                {active.length > 0 && filtered.length === 0 && rows.length > 0 && (
                  <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", padding: "8px 10px", border: "1px dashed var(--edge)" }}>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>No matches for the current filters.</span>
                    <Btn size="sm" variant="ghost" onClick={() => setActive([])}>Clear values</Btn>
                  </div>
                )}
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
    <HudPanel flow title="Filters"
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

      <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingRight: 4 }}>
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
                  const cov = coverageOf(rows as any[], f.id, latestTradeDateOf(rows));
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

// Number-range editor with 120ms debounce + swap-on-blur when min > max.
// Local state means every keystroke doesn't recompute `filtered` (which is
// O(rows × filters) on ~3k stocks).
function NumberRange({ def, af, inpS, onChange }: {
  def: FilterDef; af: ActiveFilter | undefined;
  inpS: React.CSSProperties; onChange: (patch: Partial<ActiveFilter>) => void;
}) {
  const initMin = af?.min == null || af.min === "" ? "" : String(af.min);
  const initMax = af?.max == null || af.max === "" ? "" : String(af.max);
  const [minStr, setMinStr] = useState<string>(initMin);
  const [maxStr, setMaxStr] = useState<string>(initMax);
  // Re-sync from parent (e.g. saved screen loaded) without breaking local typing.
  useEffect(() => { setMinStr(af?.min == null || af.min === "" ? "" : String(af.min)); }, [af?.min]);
  useEffect(() => { setMaxStr(af?.max == null || af.max === "" ? "" : String(af.max)); }, [af?.max]);
  const firstMin = useRef(true);
  const firstMax = useRef(true);
  useEffect(() => {
    if (firstMin.current) { firstMin.current = false; return; }
    const t = setTimeout(() => onChange({ min: minStr === "" ? "" : Number(minStr) }), 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minStr]);
  useEffect(() => {
    if (firstMax.current) { firstMax.current = false; return; }
    const t = setTimeout(() => onChange({ max: maxStr === "" ? "" : Number(maxStr) }), 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxStr]);
  const swapIfInverted = () => {
    if (minStr === "" || maxStr === "") return;
    const lo = Number(minStr), hi = Number(maxStr);
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo > hi) {
      setMinStr(String(hi));
      setMaxStr(String(lo));
    }
  };
  const inverted = minStr !== "" && maxStr !== "" && Number(minStr) > Number(maxStr);
  const warnBorder = inverted ? "var(--warn, #d29a2b)" : undefined;
  return (
    <div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input type="number" value={minStr} step={def.step}
          placeholder={def.min !== undefined ? String(def.min) : "min"}
          onChange={(e) => setMinStr(e.target.value)} onBlur={swapIfInverted}
          style={{ ...inpS, ...(warnBorder ? { borderColor: warnBorder } : null) }} />
        <span style={{ fontSize: 9, color: "var(--text-muted)" }}>–</span>
        <input type="number" value={maxStr} step={def.step}
          placeholder={def.max !== undefined ? String(def.max) : "max"}
          onChange={(e) => setMaxStr(e.target.value)} onBlur={swapIfInverted}
          style={{ ...inpS, ...(warnBorder ? { borderColor: warnBorder } : null) }} />
        {def.unit && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{def.unit}</span>}
      </div>
      {inverted && (
        <div style={{ fontSize: 10, color: "var(--warn, #d29a2b)", marginTop: 3 }}>
          min &gt; max — values will be swapped on blur.
        </div>
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
  const cov = coverageOf(rows as any[], def.id, latestTradeDateOf(rows));
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
        <NumberRange def={def} af={af} inpS={inpS} onChange={onChange} />
      )}
    </div>
  );
}

// ============================================================================
// Saved picker
// ============================================================================
function SavedPicker({ saved, activeId, onLoad, onDelete }: {
  saved: SavedScreener[]; activeId: string | null; onLoad: (s: SavedScreener) => void; onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPos(triggerRef, open, "left", 360);
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
  const activeName = activeId ? saved.find((s) => s.id === activeId)?.name ?? null : null;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button ref={triggerRef} className="hud-btn" data-variant={activeName ? "solid" : "ghost"} data-size="sm"
        onClick={() => setOpen((o) => !o)} disabled={saved.length === 0}
        title={activeName ? `Loaded: ${activeName}` : "My Screens"}>
        {activeName ? `★ ${activeName}` : `My Screens · ${saved.length}`}
      </button>
      {open && saved.length > 0 && pos && createPortal(
        <div ref={popRef} style={{ ...popoverStyle, ...pos, width: 240, maxHeight: 360, overflowY: "auto" }}>
          {saved.map((s) => {
            const isActive = s.id === activeId;
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 6px", borderBottom: "1px solid var(--edge)",
                                       background: isActive ? "rgba(53,214,237,0.12)" : "transparent" }}>
                <button onClick={() => { onLoad(s); setOpen(false); }}
                  style={{ flex: 1, minWidth: 0, background: "none", border: "none", textAlign: "left", cursor: "pointer",
                           color: "var(--text)", fontFamily: "var(--font-hud)", fontSize: 11, letterSpacing: "0.1em",
                           display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
                  {isActive && <Check size={10} style={{ color: "var(--accent)", flexShrink: 0 }} />}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                </button>
                <button onClick={() => onDelete(s.id)} title="Delete"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}>
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

function EnumMultiSelect({ options, values, onChange }: { options: string[]; values: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPos(triggerRef, open, "left", 360);
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
  const term = q.trim().toLowerCase();
  const shown = term ? options.filter((o) => o.toLowerCase().includes(term)) : options;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button ref={triggerRef} className="hud-btn" data-variant="ghost" data-size="sm" onClick={() => setOpen((o) => !o)}>
        {values.length ? `${values.length} selected` : "select…"}
      </button>
      {open && pos && createPortal(
        <div ref={popRef} style={{ ...popoverStyle, ...pos, width: 260, maxHeight: 380, padding: 0 }}>
          <div style={{ position: "relative", padding: 6, borderBottom: "1px solid var(--edge)" }}>
            <Search size={11} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search…" autoFocus
              style={{ ...inputStyle, padding: "6px 8px 6px 24px", fontSize: 12, width: "100%" }} />
          </div>
          <div style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, padding: 6 }}>
            {shown.length === 0
              ? <span style={{ fontSize: 11, color: "var(--text-muted)", padding: 6 }}>{options.length === 0 ? "no options yet" : "no matches"}</span>
              : shown.map((o) => (
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
  minWidth: 220,
  background: "var(--bg-app, #050a12)",
  backgroundColor: "var(--bg-app, #050a12)",
  backdropFilter: "none",
  border: "1px solid var(--edge-strong)",
  padding: 6, display: "flex", flexDirection: "column", gap: 2,
  boxShadow: "0 12px 32px rgba(0,0,0,0.75)",
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
    const el = triggerRef.current;
    const compute = () => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < estHeight && r.top > spaceBelow;
      const top = openUp ? Math.max(8, r.top - estHeight - 4) : r.bottom + 4;
      if (align === "left") setPos({ top, left: Math.max(8, Math.min(r.left, window.innerWidth - 260)) });
      else setPos({ top, right: Math.max(8, Math.min(window.innerWidth - r.right, window.innerWidth - 260)) });
    };
    compute();
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    // Trigger size changes too (e.g. attached saved-name grows on load) — track them.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(compute) : null;
    if (ro && el) ro.observe(el);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
      ro?.disconnect();
    };
  }, [open, triggerRef, align, estHeight]);
  return pos;
}

// ============================================================================
// Data Health strip — passive status. Sync happens on server crons + a silent
// background hook (`useMarketAutoSync`). Users only see a "last synced X ago"
// line; a discreet overflow menu keeps force-resync available for power users.
// ============================================================================
function DataHealthStrip({ rows, filteredCount, loading }: { rows: ScreenerRow[]; universe: UniverseId; filteredCount: number; loading: boolean }) {
  const push = useUi((s) => s.push);
  const [gapsOpen, setGapsOpen] = useState(false);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<null | "fund" | "eod" | "agg" | "parity">(null);
  const [syncStep, setSyncStep] = useState<string | null>(null);

  // Last daily-sync orchestrator summary — surfaced under the chips so the
  // 09:00 IST run's health is visible without cracking open the DB.
  const { data: dailySync } = useQuery({
    queryKey: ["market", "daily-sync-summary"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("market_ingestion_runs")
        .select("status,finished_at,metadata,duration_ms")
        .eq("source", "daily_sync_orchestrator")
        .eq("stage", "summary")
        .order("finished_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as {
        status: string; finished_at: string | null;
        duration_ms: number | null;
        metadata: { steps?: Array<{ fn: string; status: string; error?: string | null }>; failed_count?: number } | null;
      } | null;
    },
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
  const latestTradeDate = useMemo(() => latestTradeDateOf(rows), [rows]);

  // Live pipeline status from the DB view — reflects reality regardless of
  // whether the current user has ever triggered a sync from this browser.
  const { data: pipeline } = useQuery({
    queryKey: ["market", "pipeline-status"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("market_pipeline_status").select("*").maybeSingle();
      if (error) throw error;
      return data as {
        active_stocks: number;
        equities_total: number;
        equities_covered: number;
        equities_with_sector: number;
        mcap_nse_covered: number | null;
        mcap_any_covered: number | null;
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

  const eodLagDays = (tradeDate: string | null | undefined): number | null => {
    if (tradeDate == null || latestTradeDate == null) return null;
    const latestMs = Date.parse(`${latestTradeDate}T00:00:00Z`);
    const rowMs = Date.parse(`${tradeDate}T00:00:00Z`);
    if (!Number.isFinite(latestMs) || !Number.isFinite(rowMs)) return null;
    return Math.round((latestMs - rowMs) / 86_400_000);
  };

  // Coverage stats: prefer authoritative DB view; fall back to loaded rows.
  const stats = useMemo(() => {
    const equities = rows.filter((r) => (r.instrument_type ?? "EQ") === "EQ");
    // Match filter semantics: rows within the 3-day EOD tolerance count as
    // fresh enough; older rows are real gaps for technical filters.
    const withScore = rows.filter((r) => {
      if (r.trade_date == null) return false;
      const lag = eodLagDays(r.trade_date);
      return lag == null || (lag >= 0 && lag <= TECH_FRESHNESS_LAG_DAYS);
    });
    const lagOk = equities.filter((r) => {
      const lag = eodLagDays(r.trade_date);
      return lag != null && lag > 0 && lag <= TECH_FRESHNESS_LAG_DAYS;
    }).length;
    const withSector = equities.filter((r) => r.sector != null).length;
    const withTech = withScore.filter((r) => r.rsi != null || r.adx != null).length;
    // Market-cap source breakdown (shares × close vs. FMP repriced vs. reported).
    // Sourced from the view's data_provenance blob so drift is visible per row.
    let mcapNse = 0, mcapRepriced = 0, mcapReported = 0, mcapNone = 0;
    for (const r of equities) {
      const prov = (r as any).data_provenance as Record<string, any> | null | undefined;
      const src = prov?.market_cap_source ?? prov?.mcap_source ?? prov?.mcap;
      if (src === "shares_x_nse_close" || src === "shares_x_scores_close" || src === "nse_shares") mcapNse++;
      else if (src === "fmp_repriced") mcapRepriced++;
      else if (src === "fmp_reported" || src === "reported") mcapReported++;
      else if (r.market_cap == null) mcapNone++;
      else mcapReported++;
    }
    // Denominators: prefer the authoritative pipeline_status view (which
    // already excludes ETFs / index funds from the equity total) so the chips
    // stop counting passive funds as sector/fundamentals gaps.
    const eqTotal = pipeline?.equities_total ?? equities.length;
    const mcapWithAny = pipeline?.mcap_any_covered ?? equities.filter((r) => r.market_cap != null).length;
    const mcapNseAuth = pipeline?.mcap_nse_covered ?? mcapNse;
    return {
      total: eqTotal,
      fundOk: pipeline?.equities_covered ?? pipeline?.fundamentals_covered ?? equities.filter((r) => r.pe != null || r.roe != null || r.market_cap != null).length,
      fundFailed: pipeline?.fundamentals_failed ?? 0,
      sectorOk: pipeline?.equities_with_sector ?? withSector,
      techOk: withTech,
      techTotal: withScore.length,
      lagOk,
      nonEquity: rows.length - equities.length,
      mcapNse: mcapNseAuth, mcapRepriced, mcapReported, mcapNone,
      mcapWithAny,
      mcapDenom: eqTotal,
    };
  }, [rows, pipeline, latestTradeDate]);

  // Rows the pipeline should have priced but didn't — computed client-side
  // from the already-loaded universe (no new view/migration needed). Named
  // gaps beat a vague "N excluded" count when chasing parity mismatches.
  // Includes rows stuck on a stale trade_date, not just fully-missing ones —
  // those are the ones that silently pass tech-scoped filters with numbers
  // that aren't for today.
  const gaps = useMemo(() => {
    return rows
      .filter((r) => (r.instrument_type ?? "EQ") === "EQ")
      .map((r) => {
        const lag = eodLagDays(r.trade_date);
        const isStale = lag != null && (lag < 0 || lag > TECH_FRESHNESS_LAG_DAYS);
        const missing = [
          r.trade_date == null && "no EOD row",
          isStale && `stale EOD (${r.trade_date})`,
          r.ltp == null && "no price",
          r.change_pct == null && "no change%",
          r.volume == null && "no volume",
        ].filter((x): x is string => !!x);
        return missing.length > 0 ? { symbol: r.symbol, exchange: r.exchange, missing } : null;
      })
      .filter((x): x is { symbol: string; exchange: string; missing: string[] } => x != null);
  }, [rows, latestTradeDate]);

  const trigger = async (
    fn: "market-fundamentals-global-sync" | "market-pipeline-eod" | "market-pipeline-aggregates" | "market-shares-outstanding-sync" | "market-parity-refresh",
    label: string,
    key: "fund" | "eod" | "agg" | "parity",
  ) => {
    if (busy) return;
    setBusy(key);
    const isChunked = fn === "market-fundamentals-global-sync" || fn === "market-pipeline-eod" || fn === "market-shares-outstanding-sync";
    try {
      if (!isChunked) {
        const { error } = await supabase.functions.invoke(fn, { body: {} });
        if (error) throw error;
      } else {
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
      throw e;
    } finally { setBusy(null); }
  };

  const SYNC_CHAIN: Array<{
    fn: "market-fundamentals-global-sync" | "market-pipeline-eod" | "market-pipeline-aggregates" | "market-shares-outstanding-sync" | "market-parity-refresh";
    label: string;
    key: "fund" | "eod" | "agg" | "parity";
  }> = [
    { fn: "market-fundamentals-global-sync", label: "Fundamentals", key: "fund" },
    { fn: "market-shares-outstanding-sync", label: "Market caps", key: "fund" },
    { fn: "market-pipeline-eod", label: "EOD technicals", key: "eod" },
    { fn: "market-pipeline-aggregates", label: "Breadth", key: "agg" },
    { fn: "market-parity-refresh", label: "Tickertape parity", key: "parity" },
  ];

  const syncAll = async () => {
    if (syncStep) return;
    try {
      for (const step of SYNC_CHAIN) {
        setSyncStep(step.label);
        await trigger(step.fn, step.label, step.key);
      }
      push("All syncs complete", "ok");
    } catch { /* per-step toast already fired inside trigger() */ }
    finally { setSyncStep(null); }
  };

  const pctOf = (n: number, d: number) => d ? Math.round((n / d) * 100) : 0;
  const fundPct = pctOf(stats.fundOk, stats.total);
  const sectorPct = pctOf(stats.sectorOk, stats.total);
  const techPct = pctOf(stats.techOk, stats.techTotal);

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

  return (
    <div style={{
      display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
      padding: "4px 0",
    }}>
      <span style={{ fontFamily: "var(--font-hud)", fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
        {loading ? "loading…" : `${filteredCount} / ${stats.total}`}
      </span>
      <div style={{ flexBasis: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4, gap: 12, flexWrap: "wrap" }}>
        {dailySync?.finished_at ? (() => {
          const finished = new Date(dailySync.finished_at);
          const ist = new Date(finished.getTime() + 5.5 * 3600_000);
          const hhmm = ist.toISOString().slice(11, 16);
          const day = ist.toISOString().slice(0, 10);
          const failed = dailySync.metadata?.failed_count ?? 0;
          const status = dailySync.status;
          const color = status === "ok" ? "var(--text-muted)"
            : status === "partial" ? "var(--warn, #d4a017)"
            : "var(--err, #d4634e)";
          const failedFns = (dailySync.metadata?.steps ?? [])
            .filter((s) => s.status !== "ok").map((s) => s.fn).join(", ");
          const title = failedFns
            ? `Failed steps: ${failedFns}`
            : `Daily 09:00 IST orchestrator · ${dailySync.duration_ms ? Math.round(dailySync.duration_ms / 1000) + "s" : ""}`;
          return (
            <span
              title={title}
              style={{ fontFamily: "var(--font-hud)", fontSize: 10, color, letterSpacing: "0.12em", textTransform: "uppercase" }}
            >
              Daily sync · {status}{failed > 0 ? ` · ${failed} failed` : ""} · {day} {hhmm} IST
            </span>
          );
        })() : <span />}
        <button
          className="hud-btn"
          data-variant="ghost"
          data-size="sm"
          onClick={syncAll}
          disabled={syncStep !== null}
          title="Run all pipeline syncs in order"
        >
          <Database size={11} style={{ marginRight: 6 }} />
          {syncStep ? `Syncing ${syncStep}…` : "Sync all"}
        </button>
      </div>
    </div>
  );
}


// A bad row in filterMatches or a malformed saved screener used to white-screen
// the whole page. Wrap in ErrorBoundary so the module renders a "reboot" tile
// instead — the rest of the app (nav, other market routes) stays usable.
export default function Screener() {
  return (
    <ErrorBoundary>
      <ScreenerInner />
    </ErrorBoundary>
  );
}
