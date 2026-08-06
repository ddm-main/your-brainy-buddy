// market-penny-sweep — weekly penny-stock purge for the tradable universe.
//
// A stock is a penny stock when EITHER holds:
//   * market cap < ₹1,000 Cr  (market_stocks.market_cap is stored in ₹ crores)
//   * last settled close < ₹50
// Symbols with no market cap on record are judged on price only — an unknown
// cap is not treated as a failing cap.
//
// Penny names get penny_excluded=true and drop out of in_universe; the flag is
// what keeps them out, because market-scrips-sync / nse-master-sync /
// bse-bhavcopy-sync / index-constituents all force in_universe=true on their
// own schedules. A BEFORE trigger on market_stocks (enforce_penny_exclusion)
// re-asserts in_universe=false for any flagged row those jobs touch.
//
// The sweep is symmetric: a flagged stock that later clears BOTH thresholds is
// reinstated automatically, so a re-rating or a move above ₹50 brings it back
// without manual work.
import { preflight, jsonResponse, errorResponse, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { fetchAllRows, chunked } from "../_shared/market/paginate.ts";

const MIN_MARKET_CAP_CR = 1000;
const MIN_PRICE = 50;

// Everything keyed by symbol that must not hold penny data. A BEFORE trigger
// (block_penny_rows) rejects new writes on each of these; the sweep clears the
// history that predates the flag.
const PURGE_TABLES = [
  "market_daily_prices", "market_intraday_prices", "market_live_prices",
  "market_live_price_stage", "market_eod_nse", "market_quotes",
  "market_indicators_cache", "market_stock_scores", "market_score_history",
  "market_fundamentals", "market_fundamentals_global", "market_shares_outstanding",
  "market_news", "market_stock_ai", "market_breakout_tracker",
  "market_breakout_snapshots", "market_screener_snapshot", "market_nse_master",
] as const;

type StockRow = {
  symbol: string;
  exchange: string;
  market_cap: number | null;
  in_universe: boolean | null;
  penny_excluded: boolean | null;
};

function reasonFor(cap: number | null, close: number | null): string | null {
  const capFails = cap != null && Number(cap) < MIN_MARKET_CAP_CR;
  const priceFails = close != null && Number(close) < MIN_PRICE;
  if (capFails && priceFails) return `cap<${MIN_MARKET_CAP_CR}cr+ltp<${MIN_PRICE}`;
  if (capFails) return `cap<${MIN_MARKET_CAP_CR}cr`;
  if (priceFails) return `ltp<${MIN_PRICE}`;
  return null;
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const gate = await requireCronSecret(req); if (gate) return gate;

  const started = Date.now();
  try {
    const svc = svcClient();

    // Latest settled session that carries prices.
    const { data: latest } = await svc.from("market_daily_prices")
      .select("trade_date").order("trade_date", { ascending: false }).limit(1).maybeSingle();
    const tradeDate: string | null = (latest as any)?.trade_date ?? null;
    if (!tradeDate) return errorResponse(req, "no settled prices available", 503);

    // Active equities — penny status is only meaningful for names still listed.
    const stocks = await fetchAllRows<StockRow>((from, to) =>
      svc.from("market_stocks")
        .select("symbol, exchange, market_cap, in_universe, penny_excluded")
        .eq("is_active", true)
        .order("symbol", { ascending: true })
        .range(from, to)
    );

    // Closes for that session, keyed by symbol.
    const closes = new Map<string, number>();
    const priceRows = await fetchAllRows<{ symbol: string; close: number | null }>((from, to) =>
      svc.from("market_daily_prices")
        .select("symbol, close")
        .eq("trade_date", tradeDate)
        .order("symbol", { ascending: true })
        .range(from, to)
    );
    for (const r of priceRows) {
      if (r.close != null) closes.set(r.symbol, Number(r.close));
    }

    const toExclude: Array<{ symbol: string; reason: string }> = [];
    const toReinstate: string[] = [];
    let unchanged = 0;

    for (const s of stocks) {
      const close = closes.get(s.symbol) ?? null;
      const reason = reasonFor(s.market_cap, close);
      const flagged = s.penny_excluded === true;
      if (reason) {
        // Re-stamp when newly penny, or when the reason changed, or when some
        // other job managed to slip it back into the universe.
        if (!flagged || s.in_universe === true) toExclude.push({ symbol: s.symbol, reason });
        else unchanged++;
      } else if (flagged) {
        toReinstate.push(s.symbol);
      } else {
        unchanged++;
      }
    }

    const now = new Date().toISOString();
    let excluded = 0, reinstated = 0;

    // Group by reason so each update is a single statement per reason bucket.
    const byReason = new Map<string, string[]>();
    for (const e of toExclude) {
      const list = byReason.get(e.reason) ?? [];
      list.push(e.symbol);
      byReason.set(e.reason, list);
    }
    for (const [reason, symbols] of byReason) {
      for (const batch of chunked(symbols, 200)) {
        const { error } = await svc.from("market_stocks")
          .update({ penny_excluded: true, penny_reason: reason, penny_checked_at: now, in_universe: false })
          .in("symbol", batch);
        if (!error) excluded += batch.length;
      }
    }
    for (const batch of chunked(toReinstate, 200)) {
      const { error } = await svc.from("market_stocks")
        .update({ penny_excluded: false, penny_reason: null, penny_checked_at: now, in_universe: true })
        .in("symbol", batch);
      if (!error) reinstated += batch.length;
    }

    // Purge every derived row for the names we just excluded. A DB trigger
    // blocks future writes for flagged symbols, so this only has to clear what
    // was stored before the flag went up.
    let purged = 0;
    if (toExclude.length > 0) {
      const symbols = toExclude.map((e) => e.symbol);
      for (const table of PURGE_TABLES) {
        for (const batch of chunked(symbols, 200)) {
          const { count } = await svc.from(table)
            .delete({ count: "exact" })
            .in("symbol", batch);
          purged += count ?? 0;
        }
      }
    }

    // Make the narrowed universe visible immediately. A failed refresh means the
    // screener is still serving the pre-sweep universe, so the run is an error —
    // not a "partial" buried in metadata.
    let snapshotRows: number | null = null;
    let snapshotError: string | null = null;
    if (excluded > 0 || reinstated > 0) {
      const { data: n, error: rpcErr } = await svc.rpc("refresh_market_screener_snapshot");
      if (rpcErr) snapshotError = rpcErr.message;
      else snapshotRows = typeof n === "number" ? n : null;
    }

    await svc.from("market_ingestion_runs").insert({
      source: "penny_sweep", stage: "sweep",
      status: snapshotError ? "error" : "ok",
      error_message: snapshotError,
      rows_ingested: excluded + reinstated,
      duration_ms: Date.now() - started,
      metadata: {
        trade_date: tradeDate,
        evaluated: stocks.length,
        excluded, reinstated, unchanged, purged_rows: purged,
        min_market_cap_cr: MIN_MARKET_CAP_CR,
        min_price: MIN_PRICE,
        snapshot_rows: snapshotRows,
        snapshot_error: snapshotError,
      },
      finished_at: new Date().toISOString(),
    });


    return jsonResponse(req, {
      ok: true, trade_date: tradeDate, evaluated: stocks.length,
      excluded, reinstated, unchanged, purged_rows: purged, snapshot_rows: snapshotRows,
      thresholds: { min_market_cap_cr: MIN_MARKET_CAP_CR, min_price: MIN_PRICE },
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
