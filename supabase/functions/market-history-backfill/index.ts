// market-history-backfill — deepens market_daily_prices history.
//
// The nightly EOD pipeline fetches candles but only persists the last
// ~30 sessions, which is enough for the live screener yet far too shallow for
// the Screener's back-date mode (EMA50/100/200, 52-week levels, YTD returns
// all need hundreds of bars). This worker drains the set of NSE symbols with
// fewer than `min_bars` stored sessions and writes the full 2y series.
//
// Idempotent + resumable: each invocation claims a bounded chunk, upserts on
// (symbol, exchange, trade_date), and no-ops once the universe is deep enough.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { getServiceProvider } from "../_shared/market/provider.ts";
import { isDailyGrain, grainReason } from "../_shared/market/candleGuard.ts";
import { lowBandwidthMode } from "../_shared/market/cron.ts";


const DEFAULT_CHUNK = 60;
// PostgREST runs as `authenticator`, which carries statement_timeout=8s. Six
// workers pushing 500-row upserts into market_daily_prices blew straight
// through it — every symbol failed with 57014 and the run wrote nothing while
// still paying for the provider fetch. Narrow writes, fewer of them at once.
const CONCURRENCY = 2;
const UPSERT_CHUNK = 200;

// ~2y of sessions. Retention caps stored history at 3y for most symbols
// (~740 bars), so a higher threshold would keep re-fetching symbols that are
// already as deep as they are allowed to be.
const DEFAULT_MIN_BARS = 320;

// Circuit breaker: a run that fails for (nearly) every symbol means the
// provider or the database is unavailable, not that these symbols are bad.
// Repeating it hourly burns egress for nothing, so the next runs stand down.
const CIRCUIT_TAG = "CIRCUIT_OPEN";
const CIRCUIT_HOURS = 6;

const isTimeout = (msg: string) => msg.includes("57014") || msg.includes("statement timeout");

interface Body { limit?: number; min_bars?: number; force?: boolean }


Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    if (req.headers.get("x-cron-secret") != null) {
      const guard = await requireCronSecret(req);
      if (guard) return guard;
    } else {
      const auth = await requireUserId(req);
      if ("error" in auth) return auth.error;
    }

    const body: Body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const limit = Math.max(1, Math.min(Number(body.limit ?? DEFAULT_CHUNK) || DEFAULT_CHUNK, 100));
    const minBars = Math.max(60, Math.min(Number(body.min_bars ?? DEFAULT_MIN_BARS) || DEFAULT_MIN_BARS, 5000));

    const svc = svcClient();
    // Deep history is a nice-to-have; never spend the last of the egress
    // budget on it.
    if (await lowBandwidthMode(svc)) {
      return jsonResponse(req, { ok: true, processed: 0, skipped: "low_bandwidth" });
    }

    // Circuit breaker — stand down while a recent run reported a total wipeout.
    if (body.force !== true) {
      const since = new Date(Date.now() - CIRCUIT_HOURS * 3600_000).toISOString();
      const { data: open } = await svc.from("market_provider_health")
        .select("created_at,error")
        .eq("endpoint", "market-history-backfill")
        .like("error", `${CIRCUIT_TAG}%`)
        .gte("created_at", since)
        .limit(1);
      if (open && open.length > 0) {
        return jsonResponse(req, {
          ok: true, processed: 0, skipped: "circuit_open", since: open[0].created_at,
        });
      }
    }

    const { data: candidates, error } = await svc.rpc("market_history_backfill_candidates", {
      _limit: limit, _min_bars: minBars,
    });
    if (error) return errorResponse(req, error.message, 500);
    const work = (candidates ?? []) as {
      symbol: string; exchange: string; bars: number;
    }[];

    if (work.length === 0) return jsonResponse(req, { ok: true, processed: 0, drained: true });

    const { provider } = await getServiceProvider(svc);

    // Retention guard — the nightly janitor deletes history past these windows,
    // so writing deeper than them just burns disk and gets pruned tonight.
    const { data: cfgRows } = await svc.from("system_retention_config")
      .select("key,days").in("key", ["prices_hot_tracked", "prices_hot_other"]);
    const cfg = new Map<string, number>((cfgRows ?? []).map((r) => [r.key as string, r.days as number]));
    const keepTracked = cfg.get("prices_hot_tracked") ?? 500;
    const keepOther = cfg.get("prices_hot_other") ?? 260;
    const cutoff = (days: number) =>
      new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

    const chunkSymbols = work.map((w) => w.symbol);
    const trackedSets = await Promise.all([
      svc.from("market_index_members").select("symbol").in("symbol", chunkSymbols),
      svc.from("market_watchlist_items").select("symbol").in("symbol", chunkSymbols),
      svc.from("market_holdings").select("symbol").in("symbol", chunkSymbols),
      svc.from("market_positions").select("symbol").in("symbol", chunkSymbols),
    ]);
    const tracked = new Set<string>(
      trackedSets.flatMap((r) => ((r.data ?? []) as { symbol: string }[]).map((x) => x.symbol)),
    );

    let okCount = 0;
    let failCount = 0;
    let barsWritten = 0;
    const failures: string[] = [];

    // Current attempt counts for this chunk — the RPC doesn't return them and
    // PostgREST has no atomic increment, so read once and bump from here.
    const { data: attemptRows } = await svc.from("market_stocks")
      .select("symbol,history_backfill_attempts")
      .eq("exchange", "NSE")
      .in("symbol", work.map((w) => w.symbol));
    const attemptsBefore = new Map<string, number>(
      (attemptRows ?? []).map((r) => [r.symbol as string, (r.history_backfill_attempts as number) ?? 0]),
    );


    const queue = [...work];

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length > 0) {
        const stock = queue.shift();
        if (!stock) break;
        try {
          const candles = await provider.getOHLCV(stock.symbol, stock.exchange ?? "NSE", "max", "1d");
          if (candles.length === 0) throw new Error("no candles");
          // Yahoo silently downgrades deep daily requests to monthly bars;
          // writing those into the daily table is what corrupted history.
          if (!isDailyGrain(candles)) throw new Error(grainReason(candles));
          const minDate = cutoff(tracked.has(stock.symbol) ? keepTracked : keepOther);
          const rows = candles.map((c) => ({

            symbol: stock.symbol,
            exchange: stock.exchange ?? "NSE",
            trade_date: new Date(c.time * 1000).toISOString().slice(0, 10),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          })).filter((r) => r.trade_date >= minDate);
          if (rows.length === 0) throw new Error("no candles inside retention window");

          for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
            const slice = rows.slice(i, i + UPSERT_CHUNK);
            // One retry with backoff: statement timeouts here are contention,
            // not bad data, and a second try almost always lands.
            let lastErr: unknown = null;
            for (let attempt = 0; attempt < 2; attempt++) {
              const { error: upErr } = await svc.from("market_daily_prices")
                .upsert(slice, { onConflict: "symbol,exchange,trade_date" });
              if (!upErr) { lastErr = null; break; }
              lastErr = upErr;
              if (!isTimeout(upErr.message ?? "")) break;
              await new Promise((r) => setTimeout(r, 1500));
            }
            if (lastErr) throw lastErr;
          }
          barsWritten += rows.length;
          okCount++;
          // Clear the failure bookkeeping so the symbol simply falls out of the
          // candidate set once it is deep enough.
          await svc.from("market_stocks").update({
            history_backfill_attempts: 0,
            history_backfill_attempted_at: new Date().toISOString(),
            history_backfill_error: null,
          }).eq("symbol", stock.symbol).eq("exchange", stock.exchange ?? "NSE");
        } catch (err) {
          failCount++;
          // PostgREST errors are plain objects: String(err) yields "[object
          // Object]" and loses the reason, so unwrap message/details/hint.
          const e = err as { message?: string; details?: string; hint?: string; code?: string };
          const msg = err instanceof Error
            ? err.message
            : [e?.message, e?.details, e?.hint, e?.code].filter(Boolean).join(" | ") || JSON.stringify(err);

          if (failures.length < 10) failures.push(`${stock.symbol}: ${msg}`);
          // Record the attempt so a permanently-unfetchable symbol (delisted,
          // renamed, no Yahoo listing) stops re-occupying a slot every run.
          // Timeouts are the database being busy, not the symbol's fault, so
          // they must not count towards the give-up counter.
          await svc.from("market_stocks").update({
            history_backfill_attempts: isTimeout(msg)
              ? (attemptsBefore.get(stock.symbol) ?? 0)
              : (attemptsBefore.get(stock.symbol) ?? 0) + 1,
            history_backfill_attempted_at: new Date().toISOString(),
            history_backfill_error: msg.slice(0, 500),
          }).eq("symbol", stock.symbol).eq("exchange", stock.exchange ?? "NSE");
        }

      }
    });
    await Promise.all(workers);

    // One health row per run instead of one per failed symbol — 91 rows an
    // hour of diagnostics was itself a storage and write cost.
    const wipeout = work.length >= 5 && failCount / work.length >= 0.8;
    await svc.from("market_provider_health").insert({
      provider: (provider as { name?: string }).name ?? "unknown",
      endpoint: "market-history-backfill",
      ok: failCount === 0,
      error: failCount === 0
        ? null
        : `${wipeout ? `${CIRCUIT_TAG} ` : ""}${failCount}/${work.length} failed | ${failures[0] ?? ""}`.slice(0, 500),
    });

    return jsonResponse(req, {
      ok: true,
      processed: work.length,
      succeeded: okCount,
      failed: failCount,
      bars_written: barsWritten,
      circuit_opened: wipeout,
      drained: false,
      failures,
    });

  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
