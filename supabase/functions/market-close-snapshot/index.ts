// market-close-snapshot — full-universe close capture right after the NSE
// close (15:30 IST), hours before the bhavcopy lands.
//
// Why this exists: every other daily writer is chunked and cursor-driven, so
// mid-day the universe ends up split across two trade dates (e.g. 1,567
// symbols on today's forming bar, 1,233 still on yesterday's close). The
// screener then has no session that covers the market, silently excludes half
// the universe, and disagrees with every public screener. This function walks
// the WHOLE active NSE universe in keyset batches, writes today's real close
// into market_daily_prices, and re-scores from prices once drained — so the
// session becomes uniform within minutes of the close. The 18:45 IST bhavcopy
// pass then reconciles the same date authoritatively.
//
// Guard rails:
//  - never runs before the session is over (IST >= 15:40, weekday, non-holiday)
//  - never writes a bar dated other than today's IST trade date
//  - drops symbols whose provider bar is not today's (no back-stamping)
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { istTradeDate, requireCronSecret, isTradingHoliday } from "../_shared/market/cron.ts";
import { toYahooSymbol, yahooChartRetry } from "../_shared/market/yahooClient.ts";
import { isDailyGrain } from "../_shared/market/candleGuard.ts";

const CHUNK = 250;        // symbols per invocation
const CONCURRENCY = 8;    // parallel Yahoo chart calls
/** Minutes past IST midnight after which the cash session is finished. */
const CLOSE_MIN = 15 * 60 + 40; // 15:40 IST

// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;

function istNowMinutes(now = new Date()): number {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function istDow(now = new Date()): number {
  return new Date(now.getTime() + 5.5 * 3600_000).getUTCDay();
}

function istDateKey(epochSeconds: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(epochSeconds * 1000));
}

interface Body { cursor?: string | null; limit?: number; chain?: boolean; force?: boolean }

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;

  const isCron = req.headers.get("x-cron-secret") != null;
  if (isCron) {
    const guard = await requireCronSecret(req);
    if (guard) return guard;
  } else {
    const auth = await requireUserId(req);
    if ("error" in auth) return auth.error;
  }

  try {
    const svc = svcClient();
    const body: Body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const limit = Math.max(25, Math.min(Number(body.limit) || CHUNK, 500));
    const cursor = typeof body.cursor === "string" && body.cursor ? body.cursor : null;
    const chain = body.chain !== false;
    const force = body.force === true;

    const today = istTradeDate();
    const dow = istDow();
    if (!force) {
      if (dow === 0 || dow === 6) {
        return jsonResponse(req, { ok: true, skipped: "weekend", trade_date: today });
      }
      if (istNowMinutes() < CLOSE_MIN) {
        return jsonResponse(req, { ok: true, skipped: "session_not_finished", trade_date: today });
      }
      if (await isTradingHoliday(svc, today)) {
        return jsonResponse(req, { ok: true, skipped: "holiday", trade_date: today });
      }
    }

    // Keyset batch over the tradable NSE universe. `market_universe` is the
    // one definition of that universe (active AND non-penny) — penny names are
    // purged from every price table by trigger, so snapshotting them here only
    // burns quota on rows that can never be stored.
    let q = svc.from("market_universe")
      .select("symbol,exchange,yahoo_symbol")
      .eq("exchange", "NSE")
      .order("symbol", { ascending: true })
      .limit(limit);
    if (cursor) q = q.gt("symbol", cursor);
    const { data: stocks, error } = await q;
    if (error) return errorResponse(req, error.message, 500);

    const list = stocks ?? [];
    let written = 0, missing = 0, failed = 0;
    const rows: Array<Record<string, unknown>> = [];

    for (let i = 0; i < list.length; i += CONCURRENCY) {
      const slice = list.slice(i, i + CONCURRENCY);
      await Promise.all(slice.map(async (s) => {
        const ysym = (s.yahoo_symbol as string | null) || toYahooSymbol(s.symbol as string, "NSE");
        try {
          const candles = await yahooChartRetry(ysym, "5d", "1d", 2);
          if (!candles.length || !isDailyGrain(candles)) { failed++; return; }
          const last = candles[candles.length - 1];
          // Only today's bar counts — never back-stamp an older close onto
          // today's session, that is exactly the mixed-vintage bug.
          if (istDateKey(last.time) !== today) { missing++; return; }
          rows.push({
            symbol: s.symbol, exchange: "NSE", trade_date: today,
            open: last.open, high: last.high, low: last.low, close: last.close,
            volume: last.volume ?? 0,
          });
        } catch {
          failed++;
        }
      }));
    }

    for (let i = 0; i < rows.length; i += 200) {
      const { error: upErr } = await svc.from("market_daily_prices")
        .upsert(rows.slice(i, i + 200), { onConflict: "symbol,exchange,trade_date" });
      if (!upErr) written += Math.min(200, rows.length - i);
    }

    const lastSymbol = list.length ? String(list[list.length - 1].symbol) : cursor;
    const drained = list.length < limit;

    // Once the whole universe has today's close, rebuild scores from prices so
    // the screener's session is uniform (that is what parity depends on).
    let rescored = 0;
    if (drained) {
      let c: string | null = null;
      for (let b = 0; b < 12; b++) {
        const { data, error: rpcErr } = await svc.rpc("market_rescore_prices_batch", {
          _trade_date: today, _limit: 400, _after_symbol: c,
        });
        if (rpcErr) break;
        const row = Array.isArray(data) ? data[0] : data;
        const processed = Number(row?.processed ?? 0);
        rescored += processed;
        c = (row?.last_symbol as string | null) ?? null;
        if (processed === 0 || !c) break;
      }
      // The screener reads a precomputed snapshot table, not the live view —
      // rebuilding it here is what makes the fresh closes visible instead of
      // leaving the board on null trade_dates until some later job happens to
      // refresh it.
      let snapshotRows: number | null = null;
      let snapshotError: string | null = null;
      {
        const { data: snap, error: snapErr } = await svc.rpc("refresh_market_screener_snapshot");
        snapshotRows = typeof snap === "number" ? snap : null;
        snapshotError = snapErr?.message ?? null;
      }
      await svc.from("market_ingestion_runs").insert({
        source: "close_snapshot", stage: "drained", status: snapshotError ? "error" : "ok",
        trade_date: today, rows_ingested: rescored,
        metadata: { rescored, trade_date: today, snapshot_rows: snapshotRows, snapshot_error: snapshotError },
      });

    } else if (chain && isCron) {
      // Self-chain the next batch so one cron tick drains the universe.
      const secret = req.headers.get("x-cron-secret") ?? "";
      const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/market-close-snapshot`;
      const next = fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cron-secret": secret },
        body: JSON.stringify({ cursor: lastSymbol, limit, chain: true, force }),
      }).catch(() => undefined);
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(next);
    }

    return jsonResponse(req, {
      ok: true, trade_date: today, scanned: list.length, written, missing, failed,
      drained, cursor: lastSymbol, rescored,
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
