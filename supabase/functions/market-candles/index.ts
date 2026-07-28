// market-candles — candles for the Analysis chart.
// 1D: cached in market_daily_prices (Kotak-first backfill via provider, Yahoo fallback).
// 15m/1h: intraday provider fetch, cached in market_intraday_prices (15-min staleness).
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { yahooChartRetry, toYahooSymbol } from "../_shared/market/yahooClient.ts";
import { getReadProvider } from "../_shared/market/provider.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";
import { isDailyGrain, grainReason } from "../_shared/market/candleGuard.ts";
import { loadArchivedBars } from "../_shared/market/archive.ts";



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


async function loadDaily(
  svc: ReturnType<typeof svcClient>,
  userId: string,
  symbol: string,
  exchange: string,
): Promise<{ rows: OutCandle[]; provider: "kotak_neo" | "yahoo" }> {
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

  let providerName: "kotak_neo" | "yahoo" = "yahoo";
  if (wantDeep || stale) {
    const range = wantDeep ? "max" : "30d";
    if (wantDeep) deepTried.set(deepKey, Date.now());
    try {
      const { provider } = await getReadProvider(svc, userId);
      let candles;
      try {
        candles = await provider.getOHLCV(symbol, exchange, range, "1d");
        providerName = provider.name === "kotak_neo" ? "kotak_neo" : "yahoo";
      } catch {
        candles = await yahooChartRetry(toYahooSymbol(symbol, exchange), range, "1d");
        providerName = "yahoo";
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
      if (byDate.size === 0) throw e;

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
  return { rows, provider: providerName };

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

    if (timeframe === "1D" || timeframe === "1W" || timeframe === "1M") {
      const daily = await loadDaily(svc, auth.userId, symbol, exchange);
      let candles: OutCandle[] = daily.rows;
      if (timeframe === "1W") candles = resampleDaily(candles, "W");
      if (timeframe === "1M") candles = resampleDaily(candles, "M");

      // Weekly/monthly: only fall back to the provider's own W/M series when
      // the stored daily history can't produce anything meaningful.
      let providerName = daily.provider;
      if (timeframe !== "1D" && candles.length < 12) {
        const cfg = INTRADAY[timeframe];
        try {
          const { provider } = await getReadProvider(svc, auth.userId);
          const raw = await provider.getOHLCV(symbol, exchange, cfg.range, cfg.interval);
          if (raw.length > candles.length) {
            candles = raw.map((c) => ({
              time: new Date(c.time * 1000).toISOString().slice(0, 10),
              open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0,
            }));
            providerName = provider.name === "kotak_neo" ? "kotak_neo" : "yahoo";
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

      return jsonResponse(req, { candles, emas, timeframe, provider: providerName });
    }


    const cfg = INTRADAY[timeframe];
    if (!cfg) return errorResponse(req, `Unsupported timeframe: ${timeframe}`);

    // Intraday goes straight to the provider. The old market_intraday_prices
    // cache had no interval column, so 5m/15m/1h bars for the same symbol
    // collided in one (symbol,exchange,ts) keyspace and reads returned a mix.
    // The client already caches responses for 5 minutes (react-query staleTime).
    //
    // NOTE: the outer Yahoo fallback that used to wrap this call has been
    // removed. During market hours, `kotakProvider.getOHLCV` now throws for
    // intraday when Kotak fails instead of quietly serving delayed Yahoo
    // bars — we surface the failure to the UI (PriceSourceChip) instead of
    // masking it. Off-hours, the provider itself still uses Yahoo internally
    // where Kotak has no data.
    const { provider } = await getReadProvider(svc, auth.userId);
    const raw = await provider.getOHLCV(symbol, exchange, cfg.range, cfg.interval);
    const providerName: "kotak_neo" | "yahoo" = provider.name === "kotak_neo" ? "kotak_neo" : "yahoo";
    const candles = raw.map((c) => ({
      time: c.time,
      open: c.open, high: c.high, low: c.low, close: c.close,
      volume: c.volume ?? 0,
    }));
    return jsonResponse(req, { candles, emas: {}, timeframe, provider: providerName });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
