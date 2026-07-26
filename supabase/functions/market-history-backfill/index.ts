// market-history-backfill — deepens market_daily_prices history.
//
// The nightly EOD pipeline fetches 2y of candles but only persists the last
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

const DEFAULT_CHUNK = 40;
const CONCURRENCY = 4;
const DEFAULT_MIN_BARS = 260;

interface Body { limit?: number; min_bars?: number }

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
    const minBars = Math.max(60, Math.min(Number(body.min_bars ?? DEFAULT_MIN_BARS) || DEFAULT_MIN_BARS, 600));

    const svc = svcClient();
    const { data: candidates, error } = await svc.rpc("market_history_backfill_candidates", {
      _limit: limit, _min_bars: minBars,
    });
    if (error) return errorResponse(req, error.message, 500);
    const work = (candidates ?? []) as { symbol: string; exchange: string; bars: number }[];
    if (work.length === 0) return jsonResponse(req, { ok: true, processed: 0, drained: true });

    const { provider } = await getServiceProvider(svc);

    let okCount = 0;
    let failCount = 0;
    let barsWritten = 0;
    const failures: string[] = [];

    const queue = [...work];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length > 0) {
        const stock = queue.shift();
        if (!stock) break;
        try {
          const candles = await provider.getOHLCV(stock.symbol, stock.exchange ?? "NSE", "2y", "1d");
          if (candles.length === 0) throw new Error("no candles");
          const rows = candles.map((c) => ({
            symbol: stock.symbol,
            exchange: stock.exchange ?? "NSE",
            trade_date: new Date(c.time * 1000).toISOString().slice(0, 10),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          }));
          for (let i = 0; i < rows.length; i += 500) {
            const { error: upErr } = await svc.from("market_daily_prices")
              .upsert(rows.slice(i, i + 500), { onConflict: "symbol,exchange,trade_date" });
            if (upErr) throw upErr;
          }
          barsWritten += rows.length;
          okCount++;
        } catch (err) {
          failCount++;
          if (failures.length < 10) {
            failures.push(`${stock.symbol}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    });
    await Promise.all(workers);

    return jsonResponse(req, {
      ok: true,
      processed: work.length,
      succeeded: okCount,
      failed: failCount,
      bars_written: barsWritten,
      drained: false,
      failures,
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
