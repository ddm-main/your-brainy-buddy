// Stock Analysis — TradingView-style chart workbench + indicator readouts.
// Chart fills the viewport height; indicators are computed client-side in
// CandleChart, so toggles work even before the EOD pipeline has run.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { pickNsePreferredListing } from "@/lib/market/exchangePreference";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState } from "@/components/hud/HudControls";
import { CandleChart, type ChartType } from "@/components/market/CandleChart";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { ScoreHistoryPanel } from "@/components/market/ScoreHistoryPanel";
import { ChartToolbar, CHART_RANGES, DEFAULT_SETTINGS, isIntraday, rangeToBars, type ChartRange, type ChartSettings } from "@/components/market/ChartToolbar";
import { safeStorage } from "@/lib/safeStorage";
import { IndicatorSettingsModal } from "@/components/market/IndicatorSettingsModal";
import { NewAlertModal, StockAlertsPanel } from "@/components/market/StockAlerts";
import { DEFAULT_STUDIES, makeStudy, normalizeStudy, type IndicatorType, type Study } from "@/lib/market/indicatorRegistry";
import { fmtNum, fmtInt, fmtPct, Return1DCell, deriveChangeAbs } from "@/components/hud/DataTable";
import type { CorporateActionRow } from "@/lib/market/hooks";
import { marketOpen } from "@/lib/market/hooks";
import { useBreadth, useCandles, useCorporateActions, useDepth, useFundamentals, useLatestPriceSession, useMarketNews, useQuotes, useRefreshStockInsight, useSectorStrength, useStockInsight, useStockScores, useSyncNewsAndActions } from "@/lib/market/hooks";
import { MarketDepthLadder } from "@/components/market/MarketDepthLadder";
import { useMarketOpen } from "@/lib/market/useMarketOpen";

import { useDepthPanelVisible } from "@/lib/market/depthPanelPrefs";
import { computeLiveScore } from "@/lib/market/liveSnapshot";
import { readPatterns } from "@/lib/market/patternLabels";
import { deriveBreakoutStage, STAGE_TONE } from "@/lib/market/breakoutStage";
import { subscribeSymbolsForTicks, usePreferLiveTick } from "@/lib/market/useRealtimeTicks";
import { getTrustedDayChange } from "@/lib/market/pnl";
import { FullscreenShell } from "@/components/market/FullscreenShell";
import { useNotifications } from "@/store/notificationStore";
import { RefreshCw } from "lucide-react";
import { currentUserId } from "@/lib/useSession";

const STATE_STORE = "jarvis.analysis.state.v5";
const RANGE_STORE = "jarvis.analysis.range.v1";
const LAYOUTS_STORE = "jarvis.analysis.layouts.v1";
// Per-symbol chart-type preference. Timeframe is intentionally not restored:
// every newly opened symbol must start at the requested 5-minute view.
const TF_STORE_PREFIX = "jarvis.analysis.tf.";
const tfKey = (exch: string, sym: string | undefined) =>
  `${TF_STORE_PREFIX}${(exch || "NSE").toUpperCase()}:${(sym || "").toUpperCase()}`;


type Persisted = {
  chartType: ChartType;
  studies: Study[];
  settings: ChartSettings;
};

const defaultState: Persisted = {
  chartType: "candles",
  studies: DEFAULT_STUDIES,
  settings: DEFAULT_SETTINGS,
};


// Bars belonging to the newest trading day — the default viewport for
// intraday charts (history stays loaded, just scrolled out of view).
function todayBarCount(candles: Array<{ time: number | string }> | undefined): number | null {
  if (!candles || candles.length === 0) return null;
  const istDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const dayOf = (t: number | string) => {
    const ms = typeof t === "number" ? t * 1000 : Date.parse(String(t));
    return istDay.format(new Date(ms));
  };
  const lastDay = dayOf(candles[candles.length - 1].time);
  let n = 0;
  for (let i = candles.length - 1; i >= 0 && dayOf(candles[i].time) === lastDay; i--) n++;
  return n > 0 ? n : null;
}

// Drop studies whose type no longer exists and backfill missing params/colours.
function loadStudies(saved: unknown): Study[] {
  if (!Array.isArray(saved)) return DEFAULT_STUDIES;
  // Wrap per-item so ONE bad entry can't nuke the whole state and reset TF
  // to 1D on refresh.
  const out: Study[] = [];
  for (const s of saved) {
    try {
      const n = normalizeStudy(s as Study);
      if (n) out.push(n);
    } catch { /* skip malformed study */ }
  }
  // Self-heal: ensure a volume study is always present so it renders on
  // every chart even for old saved states created before volume was default.
  if (!out.some((x) => x.type === "volume")) out.unshift(makeStudy("volume"));
  return out;
}

function loadState(): Persisted {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_STORE) ?? "{}") as Partial<Persisted>;
    return {
      ...defaultState,
      ...raw,
      studies: loadStudies(raw.studies),
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    };
  } catch { return defaultState; }
}

export default function Analysis() {
  const nav = useNavigate();
  const { symbol } = useParams();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  // Exchange is resolved automatically: NSE when the symbol is listed there,
  // BSE only when it isn't. An explicit ?exchange= param (deep links from other
  // screens) still wins. No manual toggle — one listing, one chart.
  const paramExchange = searchParams.get("exchange")?.toUpperCase();
  const forcedExchange: "NSE" | "BSE" | null =
    paramExchange === "BSE" ? "BSE" : paramExchange === "NSE" ? "NSE" : null;
  const { data: listedExchange } = useQuery({
    queryKey: ["market", "listing-exchange", symbol?.toUpperCase()],
    enabled: !!symbol && !forcedExchange,
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    // Remembered across reloads so the chart starts on the right exchange
    // immediately instead of fetching NSE candles and refetching as BSE.
    initialData: () => {
      try {
        const v = localStorage.getItem(`jarvis.listing.${symbol?.toUpperCase()}`);
        return v === "BSE" || v === "NSE" ? (v as "NSE" | "BSE") : undefined;
      } catch { return undefined; }
    },
    queryFn: async () => {
      const { data } = await supabase
        .from("market_stocks")
        .select("exchange")
        .eq("symbol", symbol!.toUpperCase())
        .eq("is_active", true);
      const rows = (data ?? []) as { exchange: string }[];
      const ex = pickNsePreferredListing(rows)?.exchange?.toUpperCase() === "BSE" ? "BSE" : "NSE";
      try { localStorage.setItem(`jarvis.listing.${symbol!.toUpperCase()}`, ex); } catch { /* quota */ }
      return ex as "NSE" | "BSE";
    },
  });
  const exchange: "NSE" | "BSE" = forcedExchange ?? listedExchange ?? "NSE";

  const initial = useMemo(loadState, []);
  // Keep chart style per symbol, but never restore its old timeframe.
  const perSymbolInitial = useMemo(() => {
    try {
      const raw = localStorage.getItem(tfKey(exchange, symbol));
      if (!raw) return null;
      return JSON.parse(raw) as { chartType?: ChartType };
    } catch { return null; }
    // symbol/exchange change → recompute; safe: state below re-inits from this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, exchange]);
  const [timeframeState, setTimeframeState] = useState({ symbol, value: "5m" });
  // Derive synchronously so a reused route can never render/fetch the prior
  // symbol's interval while waiting for an effect to reset it.
  const tf = timeframeState.symbol === symbol ? timeframeState.value : "5m";
  const setTf = useCallback((value: string) => {
    setTimeframeState({ symbol, value });
  }, [symbol]);
  // Chart type is fixed to candles — the style dropdown was removed, and any
  // persisted heikin_ashi/line/area state is coerced back on load.
  const chartType: ChartType = "candles";
  const setChartType = (_v: ChartType) => { /* fixed to candles */ };
  const [fs, setFs] = useState(false);
  const [range, setRange] = useState<ChartRange>(() => {
    const v = safeStorage.get(RANGE_STORE);
    return (CHART_RANGES.some((r) => r.key === v) ? v : "1Y") as ChartRange;
  });
  useEffect(() => { safeStorage.set(RANGE_STORE, range); }, [range]);
  // Bumping this clears user-dragged sub-pane heights inside the chart.
  const [paneResetToken, setPaneResetToken] = useState(0);
  const [studies, setStudies] = useState<Study[]>(initial.studies);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ChartSettings>(initial.settings);
  const [alertModalOpen, setAlertModalOpen] = useState(false);
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const notify = useNotifications((s) => s.add);

  const addStudy = useCallback((type: IndicatorType) => setStudies((s) => [...s, makeStudy(type)]), []);
  const toggleStudy = useCallback((id: string) => setStudies((s) => s.map((x) => (x.id === id ? { ...x, visible: !x.visible } : x))), []);
  const removeStudy = useCallback((id: string) => setStudies((s) => s.filter((x) => x.id !== id)), []);
  const updateStudy = useCallback((u: Study) => setStudies((s) => s.map((x) => (x.id === u.id ? u : x))), []);
  const resetStudies = useCallback(() => {
    if (!window.confirm("Reset all indicators to defaults? This removes any studies you've added.")) return;
    setStudies(DEFAULT_STUDIES);
  }, []);
  const editing = studies.find((s) => s.id === editingId) ?? null;
  const visibleStudyCount = useMemo(() => studies.filter((s) => s.visible).length, [studies]);

  const [savedLayouts, setSavedLayouts] = useState<string[]>(() => {
    try { return Object.keys(JSON.parse(localStorage.getItem(LAYOUTS_STORE) ?? "{}")); } catch { return []; }
  });
  const saveLayout = useCallback((name: string) => {
    try {
      const all = JSON.parse(localStorage.getItem(LAYOUTS_STORE) ?? "{}");
      all[name] = { tf, chartType, studies, settings };
      localStorage.setItem(LAYOUTS_STORE, JSON.stringify(all));
      setSavedLayouts(Object.keys(all));
      notify(`Layout "${name}" saved`);
    } catch { notify("Could not save layout"); }
  }, [tf, chartType, studies, settings, notify]);
  const loadLayout = useCallback((name: string) => {
    try {
      const all = JSON.parse(localStorage.getItem(LAYOUTS_STORE) ?? "{}");
      const l = all[name];
      if (!l) return;
      if (l.tf) setTf(l.tf);
      if (l.chartType) setChartType(l.chartType);
      if (Array.isArray(l.studies)) setStudies(loadStudies(l.studies));
      if (l.settings) setSettings({ ...DEFAULT_SETTINGS, ...l.settings });
      notify(`Layout "${name}" loaded`);
    } catch { notify("Could not load layout"); }
  }, [notify, setTf]);
  const deleteLayout = useCallback((name: string) => {
    try {
      const all = JSON.parse(localStorage.getItem(LAYOUTS_STORE) ?? "{}");
      delete all[name];
      localStorage.setItem(LAYOUTS_STORE, JSON.stringify(all));
      setSavedLayouts(Object.keys(all));
    } catch { /* noop */ }
  }, []);

  useEffect(() => {
    const payload: Persisted = { chartType, studies, settings };
    localStorage.setItem(STATE_STORE, JSON.stringify(payload));
  }, [chartType, studies, settings]);

  // Persist chart style only. A manually selected timeframe lasts for this
  // open chart, but must not become the default for a later chart opening.
  useEffect(() => {
    if (!symbol) return;
    const key = tfKey(exchange, symbol);
    const payload = { chartType };
    try { localStorage.setItem(key, JSON.stringify(payload)); } catch { /* quota */ }
    const onBeforeUnload = () => {
      try {
        localStorage.setItem(key, JSON.stringify(payload));
        localStorage.setItem(STATE_STORE, JSON.stringify({ chartType, studies, settings }));
      } catch { /* noop */ }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [symbol, exchange, chartType, studies, settings]);

  // Keyboard shortcuts (TradingView-style):
  //   F        toggle fullscreen
  //   1..7     select timeframe (1m,5m,15m,1h,1D,1W,1M)
  //   ,  .     cycle timeframe left / right
  useEffect(() => {
    const TF_KEYS = ["1m","5m","15m","1h","1D","1W","1M"];
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "f" || e.key === "F") { if (!fs) setFs(true); return; }
      if (/^[1-7]$/.test(e.key)) { setTf(TF_KEYS[Number(e.key) - 1]); return; }
      if (e.key === "," || e.key === ".") {
        const i = TF_KEYS.indexOf(tf);
        if (i < 0) return;
        const next = e.key === "," ? Math.max(0, i - 1) : Math.min(TF_KEYS.length - 1, i + 1);
        setTf(TF_KEYS[next]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fs, tf, setTf]);

  const sym = symbol?.toUpperCase();

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
      try { ctx.drawImage(c, x, y, r.width * devicePixelRatio, r.height * devicePixelRatio); } catch {}
    });
    // Composite the DOM overlay (symbol/TF caption) — the OHLC/legend divs
    // aren't part of the canvas, so exports would otherwise lose them.
    const stamp = `${sym ?? "chart"} · ${tf} · ${new Date().toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    ctx.font = `${12 * devicePixelRatio}px system-ui, sans-serif`;
    ctx.textBaseline = "top";
    const pad = 8 * devicePixelRatio;
    const textW = ctx.measureText(stamp).width;
    ctx.fillStyle = "rgba(4,16,22,0.75)";
    ctx.fillRect(pad - 4, pad - 4, textW + 12, 20 * devicePixelRatio);
    ctx.fillStyle = "#7fe9ff";
    ctx.fillText(stamp, pad, pad);
    out.toBlob((blob) => {
      if (!blob) { notify("Screenshot failed"); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${sym ?? "chart"}-${tf}-${new Date().toISOString().slice(0, 10)}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      notify("Chart screenshot saved");
    }, "image/png");
  }, [tf, sym, notify]);

  // Opt-in fallback to ~15m delayed Yahoo data during broker outages.
  // Persisted per-user in market_user_prefs so the preference follows the
  // account across devices; localStorage is a same-tab fallback for the
  // first render before the prefs row arrives.
  const [allowDelayed, setAllowDelayed] = useState<boolean>(() => {
    try { return localStorage.getItem("mkt.allowDelayedIntraday") === "1"; } catch { return false; }
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const uid = await currentUserId();
      if (!uid || cancelled) return;
      const { data } = await supabase
        .from("market_user_prefs")
        .select("allow_delayed_intraday")
        .eq("user_id", uid).maybeSingle();
      const v = (data as { allow_delayed_intraday?: boolean } | null)?.allow_delayed_intraday;
      if (typeof v === "boolean" && !cancelled) setAllowDelayed(v);
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    try { localStorage.setItem("mkt.allowDelayedIntraday", allowDelayed ? "1" : "0"); } catch { /* quota */ }
    (async () => {
      const uid = await currentUserId();
      if (!uid) return;
      await supabase.from("market_user_prefs").upsert(
        { user_id: uid, allow_delayed_intraday: allowDelayed },
        { onConflict: "user_id" },
      );
    })();
  }, [allowDelayed]);
  const { data: candleData, isLoading, error, refetch, isFetching } = useCandles(sym, tf, exchange, { allowDelayed });

  const { data: scores = [] } = useStockScores({ symbol: sym, limit: 1 });
  const score = scores[0];
  const { data: quotesData, dataUpdatedAt: quotesUpdatedAt } = useQuotes(sym ? [`${exchange}:${sym}`] : []);
  useEffect(() => {
    if (!sym) return;
    subscribeSymbolsForTicks([`${exchange}:${sym}`]);
  }, [exchange, sym]);
  const restQuote = quotesData?.quotes?.[0];
  const preferred = usePreferLiveTick(
    sym ? `${exchange}:${sym}` : null,
    restQuote
      ? {
        ltp: restQuote.ltp,
        change_pct: restQuote.change_pct,
        volume: restQuote.volume,
        day_open: restQuote.day_open,
        day_high: restQuote.day_high,
        day_low: restQuote.day_low,
      }
      : null,
    quotesUpdatedAt || undefined,
  );
  // `quote` keeps its REST shape (source/stale/day_change) for the rest of the
  // page; only ltp/change_pct are overridden when a fresher push tick exists.
  const quote = restQuote && preferred
    ? {
      ...restQuote,
      ltp: preferred.ltp,
      change_pct: preferred.change_pct,
      volume: preferred.volume ?? restQuote.volume,
      day_open: preferred.day_open ?? restQuote.day_open,
      day_high: preferred.day_high ?? restQuote.day_high,
      day_low: preferred.day_low ?? restQuote.day_low,
    }
    : restQuote;
  const { data: breadth } = useBreadth();
  // Daily candles independent of the chart's selected timeframe (`tf` may be
  // intraday) — this is what the live technical recompute always uses.
  const { data: dailyCandleData } = useCandles(sym, "1D", exchange);
  const { data: sectors = [] } = useSectorStrength();
  const depthVisible = useDepthPanelVisible();
  const marketOpenNow = useMarketOpen();
  const { data: depth } = useDepth(sym, exchange, depthVisible && marketOpenNow);

  const { data: fundData } = useFundamentals(sym, exchange);
  const fund = fundData?.fundamentals as any | undefined;
  // market_cap is stored in rupees; the liquidity gate works in ₹ Cr.
  const marketCapCr = fund?.market_cap != null ? Number(fund.market_cap) / 1e7 : null;
  const liveScore = useMemo(
    () => computeLiveScore(dailyCandleData?.candles, quote, score, breadth, marketCapCr),
    [dailyCandleData, quote, score, breadth, marketCapCr],
  );
  const { data: insightData, isLoading: insightLoading, error: insightError } = useStockInsight(sym);
  const refreshInsight = useRefreshStockInsight();
  const { data: news = [], error: newsError } = useMarketNews(sym, exchange);
  const { data: corpActions = [] } = useCorporateActions(sym, exchange);
  const syncNews = useSyncNewsAndActions();
  const insight = insightData?.payload;
  const sessionOpen = marketOpen();
  const fundAsOf = (() => {

    const raw = fund?.data_as_of ?? fundData?.fetched_at;
    if (!raw) return null;
    return `as of ${new Date(raw).toLocaleDateString([], { day: "2-digit", month: "short" })}`;
  })();

  // Which headline metrics the provider simply doesn't carry for this symbol.
  // Listed once as a footnote so an absent ROE reads as "not covered" rather
  // than being mistaken for a zero.
  const missingFundFields = useMemo(() => {
    if (!fund) return [] as string[];
    const checks: Array<[string, unknown]> = [
      ["ROE", fund.roe], ["ROCE", fund.roce], ["D/E", fund.debt_to_equity],
      ["current ratio", fund.current_ratio], ["beta", fund.beta],
      ["rev growth", fund.revenue_growth], ["profit growth", fund.earnings_growth],
      ["promoter holding", fund.promoter_holding],
    ];
    return checks.filter(([, v]) => v == null).map(([k]) => k);
  }, [fund]);



  // Day open/high/low + previous close. The quotes feed is the primary source
  // (it carries the current session's OHL and an anchored previous close);
  // the last daily bar is only a fallback, because that series is a session
  // behind during market hours and has historically carried duplicate bars.
  const dayBar = (() => {
    const bars = dailyCandleData?.candles;
    const last = bars?.length ? bars[bars.length - 1] : null;
    const prev = bars && bars.length > 1 ? bars[bars.length - 2] : null;
    const open = quote?.day_open ?? last?.open ?? null;
    const high = quote?.day_high ?? last?.high ?? null;
    const low = quote?.day_low ?? last?.low ?? null;
    const prevClose = quote?.previous_close ?? prev?.close ?? null;
    if (open == null && high == null && low == null && prevClose == null) return null;
    return { open, high, low, prevClose, live: quote?.day_open != null && sessionOpen };
  })();


  // A live recompute only means "live" while the session is actually open —
  // the panels used to show a green `live` chip at 23:00 IST. When closed,
  // state the EOD session the numbers belong to instead.
  const liveIntraday = !!liveScore && sessionOpen;
  // Staleness is measured against the last session that actually has prices,
  // not the wall clock: on a Sunday, Friday's score is current, while a score
  // dated before the newest stored bar means the scoring pass fell behind.
  const { data: latestPriceSession } = useLatestPriceSession();
  const scoreDate = score?.trade_date ? String(score.trade_date).slice(0, 10) : null;
  const scoreBehindPipeline = !!scoreDate && !!latestPriceSession && scoreDate < latestPriceSession;
  const sessionsBehind = scoreBehindPipeline && scoreDate
    ? Math.max(1, Math.round(
        (Date.parse(`${latestPriceSession}T00:00:00Z`) - Date.parse(`${scoreDate}T00:00:00Z`)) / 86_400_000,
      ))
    : null;
  const vintageChip = liveIntraday
    ? <Chip tone="ok">live</Chip>
    : scoreDate
      ? (
        <span title={scoreBehindPipeline
          ? `Scoring pipeline is behind: latest stored session is ${latestPriceSession}, this score is from ${scoreDate}.`
          : `Latest completed EOD session (${scoreDate}).`}>
          <Chip tone={scoreBehindPipeline ? "warn" : "neutral"}>
            EOD {new Date(scoreDate).toLocaleDateString([], { day: "2-digit", month: "short" })}
            {sessionsBehind != null ? ` · ${sessionsBehind}d behind` : ""}
          </Chip>
        </span>
      )
      : undefined;
  // When the session is closed, don't blend the last live snapshot with EOD
  // rows — read everything from the EOD score so one panel can't disagree
  // with another about which bar it is describing.
  const liveView = liveIntraday ? liveScore : null;



  const sectorRow = useMemo(
    () => sectors.find((s) => s.sector === score?.sector),
    [sectors, score],
  );

  // Count of active alerts on this symbol, sourced from the same query key
  // StockAlertsPanel writes to so the toolbar badge stays in sync without
  // an extra network round-trip.
  const { data: alertsForBadge = [] } = useQuery({
    queryKey: ["market", "alerts", sym, exchange],
    queryFn: async () => {
      const { data, error } = await supabase.from("market_alerts")
        .select("id,is_active")
        .eq("symbol", sym!).eq("exchange", exchange);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!sym,
  });
  const alertCount = (alertsForBadge as Array<{ is_active: boolean }>).filter((a) => a.is_active).length;

  // Auto-sync news on first open for a symbol that has none cached. Guarded
  // by a ref keyed on symbol|exchange so revisits or React StrictMode
  // double-mount don't spam Yahoo.
  const autoSyncedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sym) return;
    const key = `${sym}:${exchange}`;
    if (autoSyncedRef.current === key) return;
    if (news.length > 0 || syncNews.isPending) return;
    autoSyncedRef.current = key;
    syncNews.mutate({ symbol: sym, exchange });
  }, [sym, exchange, news.length, syncNews]);

  // "Last synced" for the news panel: the newest row we hold, or the
  // timestamp the most recent manual sync reported.
  const newsSyncedAt = (syncNews.data as { synced_at?: string } | undefined)?.synced_at
    ?? news.map((n) => n.published_at).filter(Boolean).sort().pop()
    ?? null;

  // Per-symbol failures the sync reports while still returning HTTP 200 — the
  // panel used to render an indefinite "no news synced yet" for these.
  const syncNewsErrors = ((syncNews.data as { errors?: string[] } | undefined)?.errors ?? []);



  const priceLines = useMemo(() => {
    const lines: Array<{ price: number; label: string; color: string }> = [];
    const r = liveView?.snapshot.resistance ?? score?.resistance_level ?? null;
    const s = liveView?.snapshot.support ?? score?.support_level ?? null;
    const rFallback = liveView?.snapshot.resistanceFallback ?? false;
    const sFallback = liveView?.snapshot.supportFallback ?? false;
    if (r) lines.push({ price: r, label: rFallback ? "R*" : "R", color: "#ffb84d" });
    if (s) lines.push({ price: s, label: sFallback ? "S*" : "S", color: "#6bffb0" });
    return lines;
  }, [liveView, score]);

  // No standalone "Analysis" destination — this view is always reached by
  // clicking a symbol elsewhere. A missing/invalid param sends the user back
  // to Screener rather than showing a manual symbol-search landing page.
  if (!sym) {
    return <Navigate to="/market/screener" replace />;
  }

  // Prefer EOD close when the live quote is stale (Yahoo timeout / Kotak
  // disconnect) — a stale quote was silently overriding the fresh EOD close
  // and turning the header green with a phantom 0% change.
  const staleLive = !!quote?.stale;
  const ltp = (!staleLive && quote?.ltp) || score?.close || null;
  const chgPct = (!staleLive ? quote?.change_pct : null) ?? score?.change_pct ?? null;
  const dayChange = getTrustedDayChange(quote);
  const liveChartPrice = !staleLive ? (quote?.ltp ?? null) : null;
  const liveChartVolume = !staleLive ? ((quote as any)?.volume ?? null) : null;
  const chartSource = candleData?.last_bar_source === "quote" || candleData?.last_bar_source === "quote_delayed"
    ? candleData.last_bar_source
    : candleData?.provider ?? null;

  return (
    <div className="mk-anl-grid">
      {/* Chart column — fills the viewport height */}
      <div className="mk-anl-chart" style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
        <HudPanel
          title={sym}
          index="MK.ANL"
          live={isLoading ? "warn" : "ok"}
          style={{ flex: 1, minHeight: 0 }}
          actions={
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              {/* Degraded-source provenance removed. */}
              <Chip tone="neutral">{exchange}</Chip>
            </div>

          }
        >
          <FullscreenShell fullscreen={fs} onExit={() => setFs(false)} title={`${sym} · ${tf}`}>
            <ChartToolbar
              symbol={sym}
              exchange={exchange}
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
              fullscreen={fs}
              onFullscreen={() => setFs((v) => !v)}
              onAlert={() => setAlertModalOpen(true)}
              alertCount={alertCount}
              onScreenshot={handleScreenshot}
              onSaveLayout={saveLayout}
              onLoadLayout={loadLayout}
              onDeleteLayout={deleteLayout}
              savedLayouts={savedLayouts}
              intraday={isIntraday(tf)}
              range={range}
              onRange={setRange}
              onResetPanes={() => setPaneResetToken((v) => v + 1)}
            />
            <div ref={chartWrapRef} style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
              {/* Chart surface — own stacking context so overlays inside it
                  (OHLC line, study legend) start below the ribbon. */}
              <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
              {error ? (

                <EmptyState hint={String((error as Error).message ?? "")}>chart unavailable</EmptyState>
              ) : isLoading || !candleData ? (
                <div className="hud-label" style={{ padding: 24, textAlign: "center" }}>loading candles…</div>
              ) : candleData.candles.length === 0 ? (
                candleData.provider === "none" ? (
                  <EmptyState hint={candleData.reason ?? "the broker is not responding right now"}>
                    <div>kotak neo unavailable</div>
                    <div style={{
                      marginTop: 12, display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap",
                    }}>
                      <button type="button" onClick={() => refetch()} disabled={isFetching}
                        style={{
                          padding: "6px 12px", background: "transparent",
                          border: "1px solid var(--accent)", color: "var(--accent)",
                          fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em",
                          textTransform: "uppercase", cursor: isFetching ? "wait" : "pointer",
                        }}>{isFetching ? "retrying…" : "retry"}</button>
                      {!allowDelayed && isIntraday(tf) && (
                        <button type="button"
                          onClick={() => { setAllowDelayed(true); setTimeout(() => refetch(), 0); }}
                          style={{
                            padding: "6px 12px", background: "transparent",
                            border: "1px solid var(--edge)", color: "var(--text-dim)",
                            fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em",
                            textTransform: "uppercase", cursor: "pointer",
                          }}>show ~15m delayed data</button>
                      )}
                    </div>
                  </EmptyState>
                ) : (
                  <EmptyState hint="unknown symbol, or data pipeline hasn't covered it yet">no candle data</EmptyState>
                )
              ) : (
                <CandleChart
                  candles={candleData.candles}
                  priceLines={priceLines}
                  fill
                  chartType={chartType}
                  studies={studies}
                  intraday={isIntraday(tf)}
                  livePrice={liveChartPrice}
                  liveVolume={liveChartVolume}
                  settings={settings}
                  onToggleStudy={toggleStudy}
                  onEditStudy={setEditingId}
                  onRemoveStudy={removeStudy}
                  source={chartSource}
                  visibleBars={isIntraday(tf) ? todayBarCount(candleData.candles) : rangeToBars(range, tf)}
                  paneResetToken={paneResetToken}
                  viewportKey={`${exchange}:${sym}:${tf}`}
                />


              )}
              </div>
            </div>


          </FullscreenShell>
          <IndicatorSettingsModal study={editing} onChange={updateStudy} onRemove={removeStudy} onClose={() => setEditingId(null)} />
        </HudPanel>
      </div>

      {/* Right rail — scrolls independently */}
      <div className="mk-anl-rail">
        <HudPanel flow title="Quote" index="A1">
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 22, lineHeight: 1.1, color: "var(--accent)" }}>
              {ltp != null ? `₹${fmtNum(ltp)}` : "—"}
            </div>
            <div style={{ fontSize: 12 }}>
              <Return1DCell abs={dayChange ?? deriveChangeAbs(ltp, chgPct)} pct={chgPct} />
            </div>
            <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", marginLeft: "auto" }}>
              {score?.sector && <Chip tone="accent">{score.sector}</Chip>}
              {/* Only claim "live" while the session is actually open — outside
                  hours the same recompute runs off the settled EOD close, and
                  labelling that as live made a two-day-old print look fresh. */}
              {quote?.ltp && liveScore && sessionOpen ? (
                <Chip tone="ok">live</Chip>
              ) : score?.trade_date ? (
                <span style={{ fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.1em" }}>
                  EOD · {new Date(score.trade_date).toLocaleDateString([], { day: "2-digit", month: "short" })}
                </span>
              ) : null}
              {quote?.stale && <Chip tone="warn">stale</Chip>}
            </div>
          </div>

          {dayBar && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 12, marginTop: 6 }}>
              <CompactStat label={dayBar.live ? "Open" : "Open"} value={fmtNum(dayBar.open)} />
              <CompactStat label={dayBar.live ? "Day High" : "High"} value={fmtNum(dayBar.high)} />
              <CompactStat label={dayBar.live ? "Day Low" : "Low"} value={fmtNum(dayBar.low)} />
              <CompactStat label="Prev Close" value={fmtNum(dayBar.prevClose)} />
            </div>
          )}
        </HudPanel>

        <StockAlertsPanel symbol={sym} exchange={exchange} />

        <MarketDepthLadder depth={depth} symbol={sym} exchange={exchange} />

        {!score ? (
          <HudPanel flow title="Coverage" index="A3">
            <div className="hud-label" style={{ fontSize: 11, lineHeight: 1.6, color: "var(--text-dim)" }}>
              No screener data for <b style={{ color: "var(--accent)" }}>{sym}</b>. It isn't in the
              tracked universe yet — run the pipeline from <span style={{ color: "var(--accent)" }}>Settings → Sync universe</span>,
              or pick a covered symbol. The chart above still works.
            </div>
          </HudPanel>
        ) : (
        <>
        <HudPanel flow title="Breakout Intelligence" index="A3" actions={vintageChip}>
          {(() => {
            // Score-only panel: the number, why it can (or cannot) be trusted,
            // and the score-history feedback loop that shows what actually
            // happened after past scores. Setups / patterns / S&R chips live in
            // A4 and A5 — this panel explains the score, nothing else.
            const snap = liveView?.snapshot;
            const breakoutScore = liveView?.breakout.score ?? score?.breakout_score_v4 ?? score?.breakout_score ?? null;
            const components = liveView?.breakout.components ?? score?.score_components?.breakout ?? null;
            const stage = deriveBreakoutStage(snap ?? null);
            const stageTone = STAGE_TONE[stage.stage];
            const chipTone = stageTone === "neutral" ? undefined : stageTone;
            const band = score?.breakout_band ?? null;
            const reason = score?.score_unavailable_reason ?? null;
            // A score with no coverage and a genuinely weak setup must never
            // look the same — say why instead of printing a low number.
            if (breakoutScore == null) {
              return (
                <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
                  Not scoreable — {reason ?? "the pipeline hasn't written a v4 score for this symbol yet"}.
                  {score?.bars_available != null && (
                    <span style={{ color: "var(--text-muted)" }}> ({score.bars_available} sessions of history)</span>
                  )}
                </div>
              );
            }
            return (
              <>
                <Row label={liveScore && quote?.ltp && sessionOpen ? "Breakout Score (live)" : "Breakout Score (EOD)"}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <ScoreBadge
                      score={breakoutScore}
                      components={components}
                      label="breakout components"
                      onClick={() => nav(`/market/score/${encodeURIComponent(sym)}/explain?exchange=${encodeURIComponent(exchange)}`)}
                    />
                    {band && <Chip tone={band === "STRONG" ? "ok" : band === "WEAK" ? "warn" : "accent"}>{band}</Chip>}
                    {chipTone && <Chip tone={chipTone}>{stage.stage}</Chip>}
                  </span>
                </Row>
                {/* "no snapshot" is a not-loaded-yet placeholder, not a verdict —
                    never render it as if it were analysis. */}
                {stage.detail && stage.detail !== "no snapshot" && (
                  <div style={{ fontSize: 10, color: "var(--text-muted)", padding: "2px 0 4px", textAlign: "right" }}>
                    {stage.detail}
                  </div>
                )}
                <ScoreHistoryPanel symbol={sym} exchange={exchange} />
              </>
            );
          })()}
        </HudPanel>


        <HudPanel flow title="Indicators (Daily)" index="A4" actions={vintageChip}>
          <Row label="Setups">
            <span style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {(liveView?.snapshot.bbSqueeze ?? score?.bb_squeeze) && <Chip tone="accent">BB squeeze</Chip>}
              {liveView?.snapshot.atrContracting && <Chip tone="accent">ATR contracting</Chip>}
              {(liveView?.snapshot.higherLows ?? score?.higher_lows) && <Chip tone="ok">higher lows</Chip>}
              {liveView?.snapshot.volDryUpRatio != null && liveView.snapshot.volDryUpRatio < 0.8 && <Chip tone="accent">vol dry-up</Chip>}
              {(liveView?.snapshot.nearResistance ?? score?.near_resistance) && <Chip tone="warn">near R</Chip>}
              {(liveView?.snapshot.aboveEma200 ?? score?.above_ema200) && <Chip tone="ok">&gt;200 EMA</Chip>}
              {!liveView?.snapshot.bbSqueeze && !score?.bb_squeeze && !liveView?.snapshot.higherLows && !score?.higher_lows && !liveView?.snapshot.nearResistance && !score?.near_resistance && (
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>none</span>
              )}
            </span>
          </Row>
          <Row label="Chart Patterns">
            <span style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: "70%" }}>
              {(() => {
                const patterns = readPatterns((liveView?.patterns ?? score?.pattern_flags) as Record<string, boolean> | undefined);
                return patterns.length === 0 ? (
                  <span style={{ color: "var(--text-muted)", fontSize: 11 }}>none detected</span>
                ) : patterns.map((p) => (
                  <span key={p.key} title={p.blurb} style={{ display: "inline-flex" }}>
                    <Chip tone={p.tone}>{p.label}</Chip>
                  </span>
                ));
              })()}
            </span>
          </Row>
          <StatGrid>
            <CompactStat label="RSI (14)" value={fmtNum(liveView?.snapshot.rsi14 ?? score?.rsi14, 1)} />
            <CompactStat label="MACD" value={`${fmtNum(liveView?.snapshot.macd ?? score?.macd, 2)} / ${fmtNum(liveView?.snapshot.macdSignal ?? score?.macd_signal, 2)}`} />
            <CompactStat label="ADX (14)" value={fmtNum(liveView?.snapshot.adx14 ?? score?.adx14, 1)} />
            <CompactStat label="ATR %" value={fmtNum(liveView?.snapshot.atrPct ?? score?.atr_pct, 2)} />
            <CompactStat label="BB Width" value={fmtNum(liveView?.snapshot.bbWidth ?? score?.bb_width, 3)} />
            {/* Volume/RelVol from a live snapshot is the *running* intraday bar,
                not a completed daily figure — labelling it plain "Volume" made
                it look like it contradicted the EOD row. */}
            <CompactStat label={liveIntraday ? "Rel Volume (partial)" : "Rel Volume"} value={fmtNum(liveView?.snapshot.relVolume ?? score?.rel_volume, 2)} />
            <CompactStat label={liveIntraday ? "Volume (today)" : "Volume"} value={fmtInt(liveView?.snapshot.volume ?? score?.volume)} />
          </StatGrid>
        </HudPanel>

        <HudPanel flow title="Range & Strength" index="A5" actions={vintageChip}>
          <StatGrid>
            <CompactStat label="Resistance" value={
              <>
                {fmtNum(liveView?.snapshot.resistance ?? score?.resistance_level ?? null)}
                {liveView?.snapshot.resistanceTouches ? (
                  <span style={{ color: "var(--text-muted)", fontSize: 10, marginLeft: 4 }}>
                    {liveView.snapshot.resistanceTouches}×{liveView.snapshot.resistanceFallback ? " • hi" : ""}
                  </span>
                ) : null}
              </>
            } />
            <CompactStat label="Support" value={
              <>
                {fmtNum(liveView?.snapshot.support ?? score?.support_level ?? null)}
                {liveView?.snapshot.supportTouches ? (
                  <span style={{ color: "var(--text-muted)", fontSize: 10, marginLeft: 4 }}>
                    {liveView.snapshot.supportTouches}×{liveView.snapshot.supportFallback ? " • lo" : ""}
                  </span>
                ) : null}
              </>
            } />
            <CompactStat label="52w High" value={fmtNum(liveView?.snapshot.high52w ?? score?.high_52w)} />
            <CompactStat label="52w Low" value={fmtNum(liveView?.snapshot.low52w ?? score?.low_52w)} />
            <CompactStat label="From 52w High" value={
              <span style={{ color: (liveView?.snapshot.pctFrom52wHigh ?? score?.pct_from_52w_high ?? 0) > -5 ? "var(--ok)" : "var(--text)" }}>
                {fmtPct(liveView?.snapshot.pctFrom52wHigh ?? score?.pct_from_52w_high, 2, false)}
              </span>
            } />
            <CompactStat label="RS vs NIFTY" value={fmtNum(score?.rel_strength_nifty, 1)} />
            <CompactStat label="Sector Rank" value={sectorRow?.strength_rank != null ? `#${sectorRow.strength_rank} of ${sectors.length}` : "—"} />
            <CompactStat label="EMA 20/50/200" value={
              <span style={{ fontSize: 10 }}>
                {fmtNum(liveView?.snapshot.ema20 ?? score?.ema20, 0)} / {fmtNum(liveView?.snapshot.ema50 ?? score?.ema50, 0)} / {fmtNum(liveView?.snapshot.ema200 ?? score?.ema200, 0)}
              </span>
            } />
          </StatGrid>
        </HudPanel>

        </>
        )}

        {/* AI Verdict — cached 6h per symbol. refreshInsight is one shared
            mutation instance; scope its pending state to the symbol
            actually in flight so navigating to a different symbol mid-refresh
            doesn't show a stale "analyzing…" for the wrong one. */}
        {(() => { const refreshingThis = refreshInsight.isPending && refreshInsight.variables?.symbol === sym; return (
        <HudPanel flow title="AI Verdict" index="A6"
          actions={
            <Btn size="sm" variant="ghost" disabled={!sym || refreshingThis}
              onClick={() => sym && refreshInsight.mutate({ symbol: sym })}
              aria-label="refresh AI verdict">
              <RefreshCw size={11} />
            </Btn>
          }>
          {insightLoading || refreshingThis ? (
            <div className="hud-label" style={{ fontSize: 11, color: "var(--text-muted)" }}>analyzing…</div>
          ) : insightError ? (
            <div className="hud-label" style={{ fontSize: 11, color: "var(--danger)" }}>
              {(insightError as Error).message.includes("no coverage")
                ? "no coverage — run pipeline"
                : "AI unavailable — try refresh"}
            </div>
          ) : insight ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                <Chip tone={insight.verdict === "buy" ? "ok" : insight.verdict === "avoid" ? "err" : insight.verdict === "wait" ? "warn" : "accent"}>
                  {insight.verdict.toUpperCase()}
                </Chip>
                {/* Confidence is capped server-side at 95% — an equity call is
                    never certain, and the model routinely emitted 1.0. */}
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  conf {Math.round(insight.confidence * 100)}%
                </span>
                {insightData?.computed_at && (
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    · {new Date(insightData.computed_at).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
              </div>
              {insight.plausibility_flags && insight.plausibility_flags.length > 0 && (
                <div style={{ fontSize: 10, color: "var(--warn, #ffb84d)", marginBottom: 6 }}>
                  adjusted: {insight.plausibility_flags.join(", ")}
                </div>
              )}

              {(insight.entry || insight.stop_loss || insight.targets.length > 0) && (
                <div style={{ display: "flex", flexDirection: "column", fontSize: 11, marginBottom: 6 }}>
                  {insight.entry != null && <Row label="Entry" mono>₹{fmtNum(insight.entry, 2)}</Row>}
                  {insight.stop_loss != null && <Row label="Stop" mono>₹{fmtNum(insight.stop_loss, 2)}</Row>}
                  {insight.targets.map((t, i) => (
                    <Row key={i} label={`T${i + 1}`} mono>₹{fmtNum(t, 2)}</Row>
                  ))}
                  {insight.holding_period_days != null && (
                    <Row label="Hold" mono>{insight.holding_period_days}d</Row>
                  )}
                </div>
              )}
              <div style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text)", marginBottom: 4 }}>
                {insight.rationale}
              </div>
              {insight.risks.length > 0 && (
                <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
                  <div className="hud-label" style={{ marginBottom: 2 }}>Risks</div>
                  <ul style={{ margin: 0, paddingLeft: 14 }}>
                    {insight.risks.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <div className="hud-label" style={{ fontSize: 11, color: "var(--text-muted)" }}>press refresh</div>
          )}
        </HudPanel>
        ); })()}

        {/* Fundamentals — payload units are fixed by market-fundamentals:
            ratios are decimal fractions, ownership is percent. Do not add a
            second rescaling here; that is what produced "ROE 1502%". */}
        {fund && (
          <HudPanel flow title="Fundamentals" index="A7"
            actions={fundAsOf ? <span style={{ fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.08em" }}>{fundAsOf}</span> : undefined}>
            {/* Rows the source has no value for are omitted rather than
                printed as a column of em-dashes — for most NSE mid-caps the
                provider covers barely half of these fields. */}
            {fund.market_cap != null && <Row label="Market Cap" mono>{`₹${fmtNum(fund.market_cap / 1e7, 0)} Cr`}</Row>}
            {fund.pe_ttm != null && <Row label="P/E (TTM)" mono>{fmtNum(fund.pe_ttm, 2)}</Row>}
            {fund.price_to_book != null && <Row label="P/B" mono>{fmtNum(fund.price_to_book, 2)}</Row>}
            {fund.eps_ttm != null && <Row label="EPS (TTM)" mono>{fmtNum(fund.eps_ttm, 2)}</Row>}
            {fund.book_value != null && <Row label="Book Value" mono>{fmtNum(fund.book_value, 2)}</Row>}
            {fund.roe != null && <Row label="ROE" mono>{pctOf(fund.roe)}</Row>}
            {fund.roce != null && <Row label="ROCE" mono>{pctOf(fund.roce)}</Row>}
            {fund.debt_to_equity != null && <Row label="Debt/Equity" mono>{fmtNum(fund.debt_to_equity, 2)}</Row>}
            {fund.current_ratio != null && <Row label="Current Ratio" mono>{fmtNum(fund.current_ratio, 2)}</Row>}
            {fund.quick_ratio != null && <Row label="Quick Ratio" mono>{fmtNum(fund.quick_ratio, 2)}</Row>}
            {fund.peg != null && <Row label="PEG" mono>{fmtNum(fund.peg, 2)}</Row>}
            {fund.dividend_yield != null && <Row label="Div Yield" mono>{pctOf(fund.dividend_yield)}</Row>}
            {fund.revenue_growth != null && <Row label="Rev Growth (YoY)" mono>{pctOf(fund.revenue_growth)}</Row>}
            {fund.earnings_growth != null && <Row label="Profit Growth (YoY)" mono>{pctOf(fund.earnings_growth)}</Row>}
            {fund.promoter_holding != null && <Row label="Promoter Holding" mono>{fmtPct(fund.promoter_holding, 2, false)}</Row>}
            {fund.promoter_pledge != null && <Row label="Promoter Pledge" mono>{fmtPct(fund.promoter_pledge, 2, false)}</Row>}
            {fund.fii_holding != null && <Row label="FII Holding" mono>{fmtPct(fund.fii_holding, 2, false)}</Row>}
            {fund.dii_holding != null && <Row label="DII Holding" mono>{fmtPct(fund.dii_holding, 2, false)}</Row>}
            {fund.beta != null && <Row label="Beta" mono>{fmtNum(fund.beta, 2)}</Row>}
            {fund.sector && <Row label="Sector">{fund.sector}</Row>}
            {fund.industry && <Row label="Industry">{fund.industry}</Row>}
            {missingFundFields.length > 0 && (
              <div className="hud-label" style={{ marginTop: 6, fontSize: 9, color: "var(--text-muted)", lineHeight: 1.5 }}>
                not covered by source: {missingFundFields.join(", ")}
              </div>
            )}

          </HudPanel>
        )}

        {/* News & Corporate Actions — synced on demand, not on a universe-wide cron */}
        <HudPanel flow title="News & Corporate Actions" index="A8"
          actions={
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {newsSyncedAt && (
                <span style={{ fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.08em" }}>
                  synced {new Date(newsSyncedAt).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
              <Btn size="sm" variant="ghost" disabled={!sym || syncNews.isPending}
                onClick={() => sym && syncNews.mutate({ symbol: sym, exchange })}
                aria-label="sync news and corporate actions">
                <RefreshCw size={11} />
              </Btn>
            </div>
          }>
          {corpActions.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div className="hud-label" style={{ marginBottom: 4 }}>Corporate Actions</div>
              {corpActions.map((a) => (
                <Row key={a.id} label={a.action_type} mono>
                  {a.ex_date ? new Date(a.ex_date).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" }) : "—"}
                  {corpActionDetail(a) && (
                    <span style={{ color: "var(--text-dim)", marginLeft: 6, fontSize: 10 }}>{corpActionDetail(a)}</span>
                  )}
                </Row>
              ))}
            </div>
          )}
          {news.length === 0 ? (
            <div className="hud-label" style={{ fontSize: 11, color: newsError || syncNews.isError ? "var(--danger)" : "var(--text-muted)" }}>
              {syncNews.isPending ? "syncing…"
                : newsError ? `news unavailable — ${(newsError as Error).message}`
                : syncNews.isError ? `sync failed — ${(syncNews.error as Error).message}`
                : syncNewsErrors.length > 0 ? `feed returned no items — ${syncNewsErrors[0]}`
                : syncNews.isSuccess ? "no headlines found for this symbol"
                : "no news synced yet — press refresh"}
            </div>
          ) : (

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {news.map((n) => (
                <a key={n.id} href={n.url ?? undefined} target="_blank" rel="noreferrer"
                  style={{ fontSize: 11, color: "var(--text)", textDecoration: "none", display: "block" }}>
                  <div>{n.headline}</div>
                  <div style={{ color: "var(--text-dim)", fontSize: 10, marginTop: 2 }}>
                    {n.source ?? "Yahoo Finance"}{n.published_at ? ` · ${new Date(n.published_at).toLocaleDateString([], { day: "2-digit", month: "short" })}` : ""}
                  </div>
                </a>
              ))}
            </div>
          )}
        </HudPanel>

      </div>

      {alertModalOpen && (
        <NewAlertModal symbol={sym} exchange={exchange} onClose={() => setAlertModalOpen(false)}
          onCreated={() => { qc.invalidateQueries({ queryKey: ["market", "alerts", sym, exchange] }); setAlertModalOpen(false); }} />
      )}
    </div>
  );
}

// Fundamentals payload stores ratio-style metrics as decimal fractions
// (0.1503 = 15.03%) — scale exactly once, here.
function pctOf(v: number | null | undefined) {
  return v != null ? fmtPct(v * 100, 2, false) : "—";
}

// "1:2", "₹1.00/share", or the raw NSE purpose line when neither parsed.
function corpActionDetail(a: CorporateActionRow): string | null {
  if (a.amount != null) return `₹${a.amount.toFixed(2)}/share`;
  if (a.ratio_from != null && a.ratio_to != null) return `${a.ratio_to}:${a.ratio_from}`;
  return a.purpose ?? null;
}


function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid var(--edge)", fontSize: 12 }}>
      <span className="hud-label" style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={mono ? { fontVariantNumeric: "tabular-nums", color: "var(--text)" } : undefined}>{children}</span>
    </div>
  );
}

function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 12 }}>{children}</div>
  );
}

function CompactStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6, padding: "3px 0", borderBottom: "1px solid var(--edge)", fontSize: 11 }}>
      <span className="hud-label" style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text)", textAlign: "right" }}>{value}</span>
    </div>
  );
}
