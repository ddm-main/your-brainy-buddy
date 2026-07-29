// market-candles — candles for the Analysis chart.
// 1D: cached in market_daily_prices (Kotak-first backfill via provider, Yahoo fallback).
// 15m/1h: intraday provider fetch, cached in market_intraday_prices (15-min staleness).
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { yahooChartRetry, toYahooSymbol } from "../_shared/market/yahooClient.ts";
import { getReadProvider, yahooProvider, nseSessionOpen, type OhlcvMeta } from "../_shared/market/provider.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";
import { isDailyGrain, grainReason } from "../_shared/market/candleGuard.ts";
import { loadArchivedBars } from "../_shared/market/archive.ts";
import { KOTAK_CANDLES_ROUTE } from "../_shared/market/kotakClient.ts";
import { routeOpenForMs, hydrateRouteBreakers, setRouteBreakerPersistence } from "../_shared/market/routeBreaker.ts";
import { isTradingHoliday } from "../_shared/market/cron.ts";
import { recordFeedHeartbeat } from "../_shared/market/heartbeat.ts";

// Small in-isolate cache so we don't hit market_holidays on every request.
const holidayCache = new Map<string, { ts: number; isHoliday: boolean }>();
const HOLIDAY_TTL_MS = 60 * 60_000;
async function isHolidayCached(
  svc: ReturnType<typeof svcClient>, dateStr: string, exchange = "NSE",
): Promise<boolean> {
  const key = `${exchange}:${dateStr}`;
  const hit = holidayCache.get(key);
  if (hit && Date.now() - hit.ts < HOLIDAY_TTL_MS) return hit.isHoliday;
  try {
    const isHoliday = await isTradingHoliday(svc, dateStr, exchange);
    holidayCache.set(key, { ts: Date.now(), isHoliday });
    return isHoliday;
  } catch { return false; }
}

function istDateString(now = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}
async function computeMarketSession(
  svc: ReturnType<typeof svcClient>, exchange: string, now = new Date(),
): Promise<"open" | "closed" | "pre_open" | "post_close" | "holiday" | "weekend"> {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return "weekend";
  const today = istDateString(now);
  if (await isHolidayCached(svc, today, exchange)) return "holiday";
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (utcMin < 225) return "pre_open";              // before 09:15 IST
  if (utcMin >= 225 && utcMin <= 600) return "open"; // 09:15–15:30 IST
  if (utcMin > 600 && utcMin < 660) return "post_close";
  return "closed";
}

function candleTimeToIso(t: string | number): string {
  if (typeof t === "number") return new Date(t * 1000).toISOString();
  return `${t}T00:00:00.000Z`;
}
function withProvenance<T extends { candles: Array<{ time: string | number }> }>(
  payload: T & Record<string, unknown>,
  session: "open" | "closed" | "pre_open" | "post_close" | "holiday" | "weekend",
  historySource: "kotak_neo" | "yahoo" | "cache" | "mixed" | "none",
  lastBarSource: "kotak_neo" | "yahoo" | "cache" | "quote" | "quote_delayed" | "none",
): T & Record<string, unknown> {
  const now = new Date();
  const last = payload.candles[payload.candles.length - 1];
  const lastAt = last ? candleTimeToIso(last.time) : undefined;
  return {
    ...payload,
    as_of: now.toISOString(),
    last_bar_at: lastAt,
    freshness_ms: lastAt ? Math.max(0, now.getTime() - new Date(lastAt).getTime()) : undefined,
    market_session: session,
    history_source: historySource,
    last_bar_source: lastBarSource,
  };
}

const limiter = createMarketLimiter(120, 60_000);


// UI TF -> { provider interval, range }. Kotak-native intervals (1/5/15/30/60/D/W/M)
// pass through as-is; non-native TFs (2h, 4h, 3m) keep the UI grain so
// provider.ts can request the correct base and resample server-side.
const INTRADAY: Record<string, { interval: string; range: string }> = {
  "1m": { interval: "1m", range: "7d" },
  "3m": { interval: "3m", range: "7d" },
  "5m": { interval: "5m", range: "60d" },
  "15m": { interval: "15m", range: "max" },
  "30m": { interval: "30m", range: "max" },
  "1h": { interval: "1h", range: "max" },
  "2h": { interval: "2h", range: "max" },
  "4h": { interval: "4h", range: "max" },
  "1W": { interval: "1wk", range: "max" },
  "1M": { interval: "1mo", range: "max" },
};

interface DailyRow { trade_date: string; open: number; high: number; low: number; close: number; volume: number }
interface OutCandle { time: string; open: number; high: number; low: number; close: number; volume: number }
type IntradayProviderName = "kotak_neo" | "yahoo" | "cache" | "quote" | "quote_delayed" | "none";

// Weekly/monthly bars derived from the stored daily series. Kotak's W/M
// archive is shallow; the daily cache (backfilled to full listed history)
// is the deeper source, so resample from it whenever it wins on depth.
function resampleDaily(rows: OutCandle[], grain: "W" | "M"): OutCandle[] {
  const bucketKey = (iso: string): string => {
    if (grain === "M") return iso.slice(0, 7);
    // ISO week bucket: shift to that week's Monday.
    const d = new Date(iso + "T00:00:00Z");
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  };
  const out: OutCandle[] = [];
  let key = "";
  for (const r of rows) {
    const k = bucketKey(r.time);
    const last = out[out.length - 1];
    if (k !== key || !last) {
      out.push({ ...r });
      key = k;
    } else {
      last.high = Math.max(last.high, r.high);
      last.low = Math.min(last.low, r.low);
      last.close = r.close;
      last.volume += r.volume;
    }
  }
  return out;
}

// Symbols whose full-history fetch already ran in this warm isolate. Without
// this, a genuinely young listing (few stored bars, nothing deeper to get)
// would trigger an expensive "max" provider fetch on every single request.
const deepTried = new Map<string, number>();
const DEEP_TTL_MS = 6 * 3600_000;
// ~3y of sessions. Below this the stored series is treated as truncated by
// the old 2y cap and re-fetched at full depth once.
const SHALLOW_BARS = 750;
// Density floor: real daily NSE history has ~21 sessions/month. A stored
// series thinner than this is sparse or wrong-grain (the old `range=max`
// bug wrote monthly bars here) and must be re-fetched even when the raw
// row count clears SHALLOW_BARS.
const MIN_BARS_PER_MONTH = 12;
const READ_LIMIT = 20_000;

// The daily cache carries scars from earlier ingestion bugs: bars stamped on
// a Saturday/Sunday (no NSE session exists for those dates) and consecutive
// pairs sharing byte-identical open/high/low — weekly bars that leaked in and
// got written twice. Both distort every indicator, ATR and S/R level computed
// downstream, so strip them at read time instead of trusting the table.
function sanitizeDaily(rows: OutCandle[]): OutCandle[] {
  const out: OutCandle[] = [];
  for (const c of rows) {
    const dow = new Date(c.time + "T00:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const prev = out[out.length - 1];
    // Identical O, H and L to the immediately preceding session is a
    // duplicate-write artefact, not a real market day (a genuine repeat of
    // all three to the paisa is vanishingly rare).
    if (prev && prev.open === c.open && prev.high === c.high && prev.low === c.low) continue;
    out.push(c);
  }
  return out;
}

const IST_OFFSET_MS = 5.5 * 3600_000;
const SESSION_OPEN_MS = (9 * 60 + 15) * 60_000;

function timeframeMinutes(timeframe: string): number {
  const m = timeframe.match(/^(\d+)(m|h)$/i);
  if (!m) return 1;
  const n = Math.max(1, Number(m[1]) || 1);
  return m[2].toLowerCase() === "h" ? n * 60 : n;
}

function currentSessionBucket(timeframe: string, now = new Date()): number {
  const intervalMs = timeframeMinutes(timeframe) * 60_000;
  const nowMs = now.getTime();
  const istDayStartMs = Math.floor((nowMs + IST_OFFSET_MS) / 86_400_000) * 86_400_000;
  const sessionStartUtcMs = istDayStartMs - IST_OFFSET_MS + SESSION_OPEN_MS;
  const elapsedMs = Math.max(0, nowMs - sessionStartUtcMs);
  return Math.floor((sessionStartUtcMs + Math.floor(elapsedMs / intervalMs) * intervalMs) / 1000);
}

async function quoteSeedCandle(
  provider: Awaited<ReturnType<typeof getReadProvider>>["provider"],
  symbol: string,
  exchange: string,
  timeframe: string,
): Promise<{ candle: { time: number; open: number; high: number; low: number; close: number; volume: number }; source: string } | null> {
  const key = `${exchange}:${symbol}`;
  let rows: Awaited<ReturnType<typeof provider.getQuotes>> = [];
  try { rows = await provider.getQuotes([key]); } catch { rows = []; }
  const q = rows.find((r) => r.key === key && Number.isFinite(r.price) && r.price > 0);
  // When the broker's candle route is down, its quote route is often
  // degrading too (same session), so quotes may come back tagged "yahoo" or
  // "cache". A near-real-time price is still infinitely better than a blank
  // chart — accept any positive quote; the caller decides whether to stamp
  // the response as "quote" (Kotak-fresh) or "quote_delayed" (Yahoo/cache).
  if (!q) return null;
  const close = Number(q.price);
  const open = Number(q.day_open ?? close);
  const high = Math.max(close, open, Number(q.day_high ?? close));
  const low = Math.min(close, open, Number(q.day_low ?? close));
  return {
    source: q.source ?? "unknown",
    candle: {
      time: currentSessionBucket(timeframe),
      open,
      high,
      low,
      close,
      volume: Number(q.volume ?? 0) || 0,
    },
  };
}



type SourceName = "kotak_neo" | "yahoo" | "cache";

async function loadDaily(
  svc: ReturnType<typeof svcClient>,
  userId: string,
  symbol: string,
  exchange: string,
): Promise<{ rows: OutCandle[]; provider: SourceName; reason?: string }> {
  // Newest-first read then reverse: ordering ascending with a LIMIT returned
  // the OLDEST N rows, which silently dropped the most recent bars once a
  // symbol had more history than the cap.
  const { data } = await svc.from("market_daily_prices")
    .select("trade_date,open,high,low,close,volume")
    .eq("symbol", symbol).eq("exchange", exchange)
    .order("trade_date", { ascending: false })
    .limit(READ_LIMIT);
  const byDate = new Map<string, DailyRow>();
  for (const r of (data ?? []) as DailyRow[]) {
    byDate.set(String(r.trade_date).slice(0, 10), r);
  }

  // Cold bars offloaded to file storage. Merged in before the depth checks
  // below so an archived symbol is not mistaken for a shallow one (which
  // would re-download the whole series back into Postgres).
  const archived = await loadArchivedBars(svc, symbol, exchange);
  let archiveCutoff = "";
  for (const b of archived) {
    if (b.time > archiveCutoff) archiveCutoff = b.time;
    if (!byDate.has(b.time)) {
      byDate.set(b.time, {
        trade_date: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
      });
    }
  }


  // Most recent expected trading day (IST, Mon–Fri; use 16:00 IST cutoff).
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  const expected = new Date(ist);
  if (ist.getUTCHours() < 16) expected.setUTCDate(expected.getUTCDate() - 1);
  while (expected.getUTCDay() === 0 || expected.getUTCDay() === 6) {
    expected.setUTCDate(expected.getUTCDate() - 1);
  }
  const expectedStr = expected.toISOString().slice(0, 10);
  const sortedDates = [...byDate.keys()].sort();
  const latestCached = sortedDates[sortedDates.length - 1] ?? "";
  const stale = latestCached < expectedStr;

  const deepKey = `${exchange}:${symbol}`;
  const deepAt = deepTried.get(deepKey) ?? 0;
  // Density, not just count: months covered vs bars stored.
  const oldestCached = sortedDates[0] ?? "";
  const monthsCovered = oldestCached && latestCached
    ? Math.max(1, (Date.parse(latestCached) - Date.parse(oldestCached)) / 86_400_000 / 30.4375)
    : 1;
  const sparse = byDate.size > 0 && byDate.size / monthsCovered < MIN_BARS_PER_MONTH;
  const wantDeep = (byDate.size < SHALLOW_BARS || sparse) && Date.now() - deepAt > DEEP_TTL_MS;

  // Nothing fetched this call means the cached series is being served as-is.
  let providerName: SourceName = "cache";
  let reason: string | undefined;
  if (wantDeep || stale) {
    const range = wantDeep ? "max" : "30d";
    if (wantDeep) deepTried.set(deepKey, Date.now());
    try {
      const { provider } = await getReadProvider(svc, userId);
      const meta: OhlcvMeta = {};
      let candles;
      try {
        candles = await provider.getOHLCV(symbol, exchange, range, "1d", meta);
        // The source that ACTUALLY served the bars, not the configured
        // provider — Kotak legitimately delegates coverage gaps to Yahoo.
        providerName = meta.source === "kotak_neo" ? "kotak_neo" : "yahoo";
        reason = meta.reason;
      } catch (err) {
        // Kotak-only during the session: no delayed Yahoo substitution.
        if (nseSessionOpen()) throw err;
        candles = await yahooChartRetry(toYahooSymbol(symbol, exchange), range, "1d");
        providerName = "yahoo";
        reason = meta.reason ?? "provider_failed";
      }
      // Never persist weekly/monthly bars into the daily table.
      if (!isDailyGrain(candles)) {
        await svc.from("market_provider_health").insert({
          provider: providerName, endpoint: "market-candles",
          ok: false, error: `${symbol}: ${grainReason(candles)}`,
        });
        throw new Error("wrong candle grain");
      }
      const upserts = candles.map((c) => ({
        symbol, exchange,
        trade_date: new Date(c.time * 1000).toISOString().slice(0, 10),
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0,
      }));
      // Never write back bars that already live in cold storage — that would
      // silently re-inflate market_daily_prices past the free-plan budget.
      const persistable = archiveCutoff ? upserts.filter((u) => u.trade_date > archiveCutoff) : upserts;
      for (let i = 0; i < persistable.length; i += 500) {
        await svc.from("market_daily_prices")
          .upsert(persistable.slice(i, i + 500), { onConflict: "symbol,exchange,trade_date" });
      }

      for (const u of upserts) byDate.set(u.trade_date, u as unknown as DailyRow);
    } catch (e) {
      // No cached history at all and the broker is down — the caller decides
      // how to surface that (empty + reason, never delayed substitution).
      if (byDate.size === 0) throw e;
      // Cached bars are real but not a fresh broker read; flag it so the UI
      // can say "cached — not live" rather than implying live data.
      providerName = "cache";
      reason = reason ?? (e instanceof Error ? e.message : String(e));
    }
  }

  const rows: OutCandle[] = sanitizeDaily(
    [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, r]) => ({
        time: date,
        open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
        volume: Number(r.volume ?? 0),
      }))
      .filter((c) => Number.isFinite(c.close)),
  );
  return { rows, provider: providerName, reason };

}


Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const rl = limiter.guard(req, auth.userId); if (rl) return rl;
  try {
    const b = await req.json().catch(() => ({}));
    const symbol = String(b?.symbol ?? "").toUpperCase();
    const exchange = String(b?.exchange ?? "NSE").toUpperCase();
    const timeframe = String(b?.timeframe ?? "1D");
    if (!symbol) return errorResponse(req, "symbol required");
    const svc = svcClient();
    setRouteBreakerPersistence(svc);
    await hydrateRouteBreakers(svc);

    if (timeframe === "1D" || timeframe === "1W" || timeframe === "1M") {
      const session = await computeMarketSession(svc, exchange);
      let daily: { rows: OutCandle[]; provider: SourceName; reason?: string };
      try {
        daily = await loadDaily(svc, auth.userId, symbol, exchange);
      } catch (e) {
        // Broker down and no cached history: report it honestly with a 200 so
        // the chart can render an "unavailable" state instead of a hard 502.
        return jsonResponse(req, withProvenance({
          candles: [], emas: {}, timeframe, provider: "none", degraded: true,
          reason: e instanceof Error ? e.message : String(e),
        }, session, "none", "none"));
      }
      let candles: OutCandle[] = daily.rows;
      if (timeframe === "1W") candles = resampleDaily(candles, "W");
      if (timeframe === "1M") candles = resampleDaily(candles, "M");

      // Weekly/monthly: only fall back to the provider's own W/M series when
      // the stored daily history can't produce anything meaningful.
      let providerName: SourceName = daily.provider;
      let reason = daily.reason;
      if (timeframe !== "1D" && candles.length < 12) {
        const cfg = INTRADAY[timeframe];
        try {
          const { provider } = await getReadProvider(svc, auth.userId);
          const meta: OhlcvMeta = {};
          const raw = await provider.getOHLCV(symbol, exchange, cfg.range, cfg.interval, meta);
          if (raw.length > candles.length) {
            candles = raw.map((c) => ({
              time: new Date(c.time * 1000).toISOString().slice(0, 10),
              open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0,
            }));
            providerName = meta.source === "kotak_neo" ? "kotak_neo" : "yahoo";
            reason = meta.reason;
          }
        } catch { /* keep the resampled series */ }
      }

      // EMA overlays from cache (daily grain only)
      const emas: Record<string, Array<{ t: number; v: number | null }>> = {};
      if (timeframe === "1D") {
        const { data: overlays } = await svc.from("market_indicators_cache")
          .select("indicator,value")
          .eq("symbol", symbol).eq("exchange", exchange).eq("timeframe", "1D")
          .in("indicator", ["ema20", "ema50", "ema200"]);
        for (const o of overlays ?? []) emas[o.indicator] = o.value;
      }

      recordFeedHeartbeat(svc, {
        feedId: "candles_daily",
        provider: providerName,
        ok: candles.length > 0,
        symbols: candles.length,
        detail: reason ?? null,
      });
      return jsonResponse(req, withProvenance({
        candles, emas, timeframe, provider: providerName, reason,
        degraded: providerName !== "kotak_neo",
      }, session, providerName, providerName));
    }



    const cfg = INTRADAY[timeframe];
    if (!cfg) return errorResponse(req, `Unsupported timeframe: ${timeframe}`);

    // Intraday cache in market_intraday_prices (keyed by timeframe now, so
    // 5m/15m/1h bars for the same symbol don't collide).  Flow:
    //   1. Try Kotak (or off-session Yahoo). On success: return + persist.
    //   2. On Kotak failure during session: serve the last successful bars
    //      from the cache so charts don't blank out during broker outages.
    //   3. If the user opted into delayed data (`allow_delayed` in the body),
    //      also try Yahoo — clearly labelled `delayed_minutes: ~15`.
    // Per-user opt-in for ~15m delayed intraday during broker outages. The
    // body flag takes precedence (an in-session toggle), otherwise honour the
    // persisted preference in market_user_prefs.
    let allowDelayed = Boolean(b?.allow_delayed);
    if (!allowDelayed) {
      const { data: prefRow } = await svc
        .from("market_user_prefs")
        .select("allow_delayed_intraday")
        .eq("user_id", auth.userId)
        .maybeSingle();
      allowDelayed = Boolean((prefRow as { allow_delayed_intraday?: boolean } | null)?.allow_delayed_intraday);
    }
    // If Kotak's candles route has been demonstrably down for ≥ 60s, stop
    // punishing users for the broker outage and auto-serve Yahoo intraday
    // even without the opt-in toggle. They still see the "DELAYED" ribbon.
    const brokerDownForMs = routeOpenForMs(KOTAK_CANDLES_ROUTE);
    const autoDelayed = brokerDownForMs >= 60_000;

    const { provider } = await getReadProvider(svc, auth.userId);
    const meta: OhlcvMeta = {};
    let providerName: IntradayProviderName = "none";
    let degraded = false;
    let reason: string | undefined;
    let cachedAt: string | undefined;
    let delayedMinutes: number | undefined;
    let raw: Awaited<ReturnType<typeof provider.getOHLCV>> = [];
    try {
      raw = await provider.getOHLCV(symbol, exchange, cfg.range, cfg.interval, meta);
      providerName = meta.source === "kotak_neo" ? "kotak_neo" : "yahoo";
      reason = meta.reason;
      degraded = providerName !== "kotak_neo";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      degraded = true;
      reason = meta.reason ?? msg;
      if (!nseSessionOpen()) {
        // Off-session: Yahoo is fine (it's how we normally serve pre/post).
        try {
          raw = await yahooProvider(svc).getOHLCV(symbol, exchange, cfg.range, cfg.interval);
          providerName = "yahoo";
        } catch { providerName = "none"; }
      } else {
        // Session open + broker down. The route breaker (provider.ts) has
        // already coalesced the health-log entry for this outage; do NOT
        // re-log here — we were writing thousands of duplicate rows/day.
        const { data: cached } = await svc.from("market_intraday_prices")
          .select("ts,open,high,low,close,volume,fetched_at")
          .eq("symbol", symbol).eq("exchange", exchange).eq("timeframe", timeframe)
          .order("ts", { ascending: false }).limit(500);
        if (cached && cached.length > 0) {
          raw = cached.reverse().map((r: Record<string, unknown>) => ({
            time: Math.floor(new Date(String(r.ts)).getTime() / 1000),
            open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
            volume: Number(r.volume ?? 0),
          }));
          providerName = "cache";
          cachedAt = String((cached[cached.length - 1] as Record<string, unknown>).fetched_at ?? "");
          reason = reason ?? "broker_503_cache";
        }
        if (allowDelayed || autoDelayed) {
          try {
            const y = await yahooProvider(svc).getOHLCV(symbol, exchange, cfg.range, cfg.interval);
            if (y.length > raw.length) {
              raw = y;
              providerName = "yahoo";
              delayedMinutes = 15;
              reason = autoDelayed && !allowDelayed ? "broker_down_auto_delayed" : "broker_503_delayed";
            }
          } catch { /* keep cache/none */ }
        }
        if (raw.length === 0) {
          try {
            const seeded = await quoteSeedCandle(provider, symbol, exchange, timeframe);
            if (seeded) {
              raw = [seeded.candle];
              if (seeded.source === "kotak") {
                providerName = "quote";
                reason = "broker_503_quote_live";
              } else {
                providerName = "quote_delayed";
                delayedMinutes = seeded.source === "yahoo" ? 15 : undefined;
                reason = `broker_503_quote_${seeded.source}`;
              }
            }
          } catch { /* keep none */ }
        }
      }
    }


    // Persist successful Kotak reads into the intraday cache so we can serve
    // them back during the next broker outage.  Also persist quote-seeded and
    // delayed Yahoo bars (with a distinct source label) so a chart that opened
    // during an outage keeps showing something on the *next* cold-start too.
    if (raw.length > 0 && (providerName === "kotak_neo" || providerName === "yahoo" || providerName === "quote" || providerName === "quote_delayed")) {
      const tail = raw.slice(-200);
      const persistSource =
        providerName === "kotak_neo" ? "kotak_neo"
        : providerName === "yahoo" ? "yahoo_delayed"
        : providerName === "quote" ? "quote_live"
        : "quote_delayed";
      const rows = tail.map((c) => ({
        symbol, exchange, timeframe,
        ts: new Date(c.time * 1000).toISOString(),
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume ?? 0,
        source: persistSource, fetched_at: new Date().toISOString(),
      }));
      svc.from("market_intraday_prices")
        .upsert(rows, { onConflict: "symbol,exchange,timeframe,ts" })
        .then(() => {}, () => {});
    }

    const candles = raw.map((c) => ({
      time: c.time,
      open: c.open, high: c.high, low: c.low, close: c.close,
      volume: c.volume ?? 0,
    }));
    // history vs last-bar separation: when we hit the outage path and only got
    // a quote-seeded single bar, mark history as "cache" (or "none") and only
    // the last bar as "quote"/"quote_delayed" so the UI can say the truth.
    const session = await computeMarketSession(svc, exchange);
    const historySource: "kotak_neo" | "yahoo" | "cache" | "mixed" | "none" =
      providerName === "quote" || providerName === "quote_delayed"
        ? (candles.length > 1 ? "cache" : "none")
        : providerName;
    // Intraday candle liveness — recorded per actual serving provider so the
    // Feed Routing page can distinguish "Kotak served it" from "Kotak was
    // down and Yahoo covered", instead of guessing from a cache table.
    recordFeedHeartbeat(svc, {
      feedId: timeframe === "1d" ? "candles_daily" : "candles_intraday",
      provider: providerName,
      ok: candles.length > 0,
      symbols: candles.length,
      detail: reason ?? null,
    });
    return jsonResponse(req, withProvenance({
      candles, emas: {}, timeframe, provider: providerName, degraded, reason,
      cached_at: cachedAt, delayed_minutes: delayedMinutes,
    }, session, historySource, providerName));

  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});

