// market-live-sweep — one price plane for the whole universe, every 5 minutes.
//
// Why this exists: every other daily writer is cursor-driven and stamps rows
// with whatever date the symbol happened to be processed on, so mid-session
// the universe splits across two trade dates (1,567 symbols on today, 1,233
// still on yesterday). The screener then has no session that covers the
// market, silently excludes half the universe, and disagrees with every
// public screener (Economic Times, Tickertape, ...).
//
// This function walks the ENTIRE active universe in keyset batches, quotes it
// through the system broker feed (Yahoo only as a bounded gap-filler) and
// upserts one row per symbol into market_live_prices — a flat, ~2,800-row
// plane with a single sweep_id/as_of. It never writes market_daily_prices, so
// a forming bar can never be mistaken for a settled session.
//
// 1D change is always anchored on the previous SETTLED close (the same anchor
// ET uses), never on an intraday reference.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { istTradeDate, requireCronSecret, isTradingHoliday } from "../_shared/market/cron.ts";
import { getServiceProvider } from "../_shared/market/provider.ts";
import { getSharedQuotes } from "../_shared/market/quoteCache.ts";
import { toYahooSymbol, yahooQuote } from "../_shared/market/yahooClient.ts";

const CHUNK = 400;          // symbols per invocation
const QUOTE_CHUNK = 100;    // symbols per upstream quote call
const YAHOO_CAP = 120;      // bounded gap-filler per invocation

// NSE cash-market circuit bands top out at 20%. A print beyond that is not a
// trade, it is an anchor problem — almost always a previous close that predates
// an unapplied split/bonus (TEMBO 574.15 -> 66.85, WINSOME 836.67 -> 50.20).
// Those leak into every "1D return >" screen as fake 300-2400% gainers, so the
// quote is marked rejected and the screener falls back to the settled close
// rather than silently ranking a phantom mover at the top of the page.
const MAX_SESSION_MOVE_PCT = 21;
// SME/Emerge board. Quoted for completeness, excluded from mainboard screens.
const SME_SERIES = new Set(["SM", "ST"]);

// Static reference data per symbol, cached for the trading day inside a warm
// isolate. Re-reading it on every sweep chunk was the single largest PostgREST
// route (12.4 MB in half a day).
type StaticMeta = { yahoo_symbol: string | null; series: string; total_shares_cr: number | null };
const staticMeta = new Map<string, StaticMeta>();
const STATIC_META_TTL_MS = 12 * 3_600_000;
let staticMetaExpiresAt = 0;

// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;


interface Body {
  cursor?: string | null;
  limit?: number;
  chain?: boolean;
  force?: boolean;
  sweep_id?: string | null;
  as_of?: string | null;
}

function istDow(now = new Date()): number {
  return new Date(now.getTime() + 5.5 * 3600_000).getUTCDay();
}

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
    const limit = Math.max(50, Math.min(Number(body.limit) || CHUNK, 600));
    const cursor = typeof body.cursor === "string" && body.cursor ? body.cursor : null;
    const chain = body.chain !== false;
    const force = body.force === true;
    const sweepId = body.sweep_id ?? crypto.randomUUID();
    const asOf = body.as_of ?? new Date().toISOString();

    const sessionDate = istTradeDate();
    if (!force) {
      const dow = istDow();
      if (dow === 0 || dow === 6) {
        return jsonResponse(req, { ok: true, skipped: "weekend", session_date: sessionDate });
      }
      if (await isTradingHoliday(svc, sessionDate)) {
        return jsonResponse(req, { ok: true, skipped: "holiday", session_date: sessionDate });
      }
    }

    // Only the first invocation opens the run. The database advisory lock
    // prevents two five-minute jobs from exposing interleaved sweeps.
    if (!cursor) {
      const { data: begun, error: beginError } = await svc.rpc("begin_market_live_sweep", {
        _sweep_id: sweepId,
        _session_date: sessionDate,
        _as_of: asOf,
      });
      if (beginError) return errorResponse(req, beginError.message, 500);
      if (begun?.started === false) {
        return jsonResponse(req, { ok: true, skipped: begun.reason ?? "overlap", active_sweep_id: begun.sweep_id });
      }
    }

    // Keyset batch over the active NSE universe — the exact same universe the
    // screener screens, so the plane can never be a subset of it.
    // EGRESS: the universe symbol list itself is now cached per isolate for an
    // hour, so a warm isolate pages through it in memory instead of re-reading
    // ~5 KB of symbols on every chunk of every sweep. Static reference columns
    // (yahoo_symbol/series/total_shares_cr) change on the weekly scrip sync at
    // most and are cached for the day. This route was 2,160 reads/day at 5.6 KB.
    if (universeExpiresAt <= Date.now() || universe.length === 0) {
      const all: string[] = [];
      let after: string | null = null;
      for (;;) {
        let uq = svc.from("market_stocks")
          .select("symbol")
          .eq("is_active", true)
          .eq("exchange", "NSE")
          .eq("instrument_type", "EQ")
          // Penny names are purged from every price table by a DB trigger;
          // fetching them here would only burn quota on ticks that can never
          // be stored.
          .not("penny_excluded", "is", true)
          .order("symbol", { ascending: true })
          .limit(1000);
        if (after) uq = uq.gt("symbol", after);
        const { data: chunk, error: uerr } = await uq;
        if (uerr) return errorResponse(req, uerr.message, 500);
        const syms = (chunk ?? []).map((r) => String(r.symbol));
        all.push(...syms);
        if (syms.length < 1000) break;
        after = syms[syms.length - 1];
      }
      universe = all;
      universeExpiresAt = Date.now() + UNIVERSE_TTL_MS;
    }

    const startIdx = cursor ? universe.findIndex((s) => s > cursor) : 0;
    const pageSymbols = startIdx < 0 ? [] : universe.slice(startIdx, startIdx + limit);

    if (staticMetaExpiresAt <= Date.now()) {
      staticMeta.clear();
      staticMetaExpiresAt = Date.now() + STATIC_META_TTL_MS;
    }
    const missingMeta = pageSymbols.filter((s) => !staticMeta.has(s));
    for (let i = 0; i < missingMeta.length; i += 200) {
      const { data: metaRows, error: metaErr } = await svc.from("market_stocks")
        .select("symbol,yahoo_symbol,series,total_shares_cr")
        .eq("exchange", "NSE")
        .in("symbol", missingMeta.slice(i, i + 200));
      if (metaErr) return errorResponse(req, metaErr.message, 500);
      for (const r of metaRows ?? []) {
        staticMeta.set(String(r.symbol), {
          yahoo_symbol: (r.yahoo_symbol as string | null) ?? null,
          series: String(r.series ?? "EQ"),
          total_shares_cr: r.total_shares_cr != null ? Number(r.total_shares_cr) : null,
        });
      }
    }


    const stocks = pageSymbols.map((symbol) => {
      const m = staticMeta.get(symbol);
      return {
        symbol,
        exchange: "NSE",
        yahoo_symbol: m?.yahoo_symbol ?? null,
        series: m?.series ?? "EQ",
        total_shares_cr: m?.total_shares_cr ?? null,
      };
    });


    const list = stocks ?? [];
    if (list.length === 0) {
      const { data: promotion, error: promotionError } = await svc.rpc("promote_market_live_sweep", {
        _sweep_id: sweepId,
        _min_coverage: 0.98,
      });
      if (promotionError) return errorResponse(req, promotionError.message, 500);
      return jsonResponse(req, { ok: true, session_date: sessionDate, scanned: 0, drained: true, sweep_id: sweepId, promotion });
    }

    const symbols = list.map((s) => String(s.symbol));

    // Previous SETTLED close per symbol, resolved from authoritative daily
    // history strictly before this live session. A stale/partial score row is
    // never accepted as a 1D anchor.
    const anchors = new Map<string, number>();
    {
      // EGRESS: the `_lean` variant returns only symbol + prev_close for the
      // symbols in THIS chunk. The full anchor set was 32 KB a call × 428
      // calls/day (13.7 MB) for two fields.
      const { data: settled } = await svc.rpc("market_live_settled_anchors_lean", {
        _symbols: symbols,
        _before: sessionDate,
      });
      for (const r of settled ?? []) {
        if (r.prev_close != null && Number(r.prev_close) > 0) anchors.set(String(r.symbol), Number(r.prev_close));
      }
    }

    const { provider } = await getServiceProvider(svc);
    const brokerAvailable = provider.name === "kotak_neo" || provider.name === "kotak";

    interface Priced { ltp: number; volume: number | null; prevFromFeed: number | null; provider: string }
    const priced = new Map<string, Priced>();

    if (brokerAvailable) {
      for (let i = 0; i < symbols.length; i += QUOTE_CHUNK) {
        const keys = symbols.slice(i, i + QUOTE_CHUNK).map((s) => `NSE:${s}`);
        try {
          const rows = await getSharedQuotes(provider, keys);
          for (const r of rows) {
            if (!r.price) continue;
            const sym = r.key.includes(":") ? r.key.split(":")[1] : r.key;
            priced.set(sym, {
              ltp: Number(r.price),
              volume: r.volume ?? null,
              prevFromFeed: r.previous_close ?? null,
              provider: "kotak",
            });
          }
        } catch { /* fall through to the Yahoo gap-filler */ }
      }
    }

    // Bounded gap-filler: symbols the broker does not cover (or the whole
    // batch when the broker session is down) get a delayed Yahoo print, but
    // only up to YAHOO_CAP per invocation so a broker outage cannot turn one
    // sweep into thousands of upstream calls.
    const missing = list.filter((s) => !priced.has(String(s.symbol))).slice(0, YAHOO_CAP);
    if (missing.length > 0) {
      const ymap = new Map<string, string>();
      for (const s of missing) {
        ymap.set((s.yahoo_symbol as string | null) || toYahooSymbol(String(s.symbol), "NSE"), String(s.symbol));
      }
      try {
        const rows = await yahooQuote([...ymap.keys()]);
        for (const r of rows) {
          const sym = ymap.get(r.symbol) ?? ymap.get(`${r.symbol}`.toUpperCase());
          if (!sym || r.price == null) continue;
          priced.set(sym, {
            ltp: Number(r.price),
            volume: r.volume ?? null,
            prevFromFeed: r.prev_close ?? null,
            provider: "yahoo",
          });
        }
      } catch { /* leave those symbols on their previous plane row */ }
    }

    const rows: Array<Record<string, unknown>> = [];
    // Share counts and series ride along from the universe batch so live market
    // cap is revalued on the same row the filters read — ET revalues cap
    // continuously, and a cap anchored to yesterday's close makes the
    // "MCap >" gate admit and reject the wrong stocks.
    const meta = new Map<string, { shares: number | null; series: string }>();
    for (const s of list) {
      meta.set(String(s.symbol), {
        shares: s.total_shares_cr != null ? Number(s.total_shares_cr) : null,
        series: String(s.series ?? "EQ"),
      });
    }
    for (const [symbol, p] of priced) {
      // Settled anchor wins; the feed's own previous close is the fallback.
      const prev = anchors.get(symbol) ?? (p.prevFromFeed && p.prevFromFeed > 0 ? p.prevFromFeed : null);
      const changeAbs = prev != null ? p.ltp - prev : null;
      const changePct = changeAbs != null && prev
        ? Number(((changeAbs / prev) * 100).toFixed(4))
        : null;

      const m = meta.get(symbol);
      // Sanity gate. SME series keep their own (much wider) price behaviour and
      // are screened out by scope rather than by band, so the band is only
      // enforced on the mainboard where it is a hard exchange rule.
      const onSme = m ? SME_SERIES.has(m.series) : false;
      let rejected = false;
      let rejectReason: string | null = null;
      if (prev == null) {
        rejected = true;
        rejectReason = "no_settled_anchor";
      } else if (!onSme && changePct != null && Math.abs(changePct) > MAX_SESSION_MOVE_PCT) {
        rejected = true;
        rejectReason = "circuit_band_exceeded";
      }

      // Live cap in crore = shares (crore) x price. Null shares stay null so the
      // screener can mark the row unjudgeable instead of filtering it on a
      // stale settled cap.
      const capLive = m?.shares != null && m.shares > 0 && !rejected
        ? Number((m.shares * p.ltp).toFixed(4))
        : null;

      rows.push({
        symbol,
        exchange: "NSE",
        session_date: sessionDate,
        ltp: p.ltp,
        prev_close: prev,
        change_abs: changeAbs != null ? Number(changeAbs.toFixed(2)) : null,
        change_pct: changePct,
        volume: p.volume != null ? Math.round(Number(p.volume)) : null,
        market_cap_live: capLive,
        quote_rejected: rejected,
        reject_reason: rejectReason,
        provider: p.provider,
        sweep_id: sweepId,
        as_of: asOf,
      });
    }

    let written = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const slice = rows.slice(i, i + 200);
      const { error: upErr } = await svc.from("market_live_price_stage")
        .upsert(slice, { onConflict: "sweep_id,symbol,exchange" });
      if (!upErr) written += slice.length;
    }

    const kotakCount = rows.filter((r) => r.provider === "kotak").length;
    const yahooCount = rows.filter((r) => r.provider === "yahoo").length;
    const { data: run } = await svc.from("market_live_price_runs")
      .select("scanned_count,priced_count,failed_count,kotak_count,yahoo_count")
      .eq("sweep_id", sweepId).maybeSingle();
    await svc.from("market_live_price_runs").update({
      scanned_count: Number(run?.scanned_count ?? 0) + list.length,
      priced_count: Number(run?.priced_count ?? 0) + written,
      failed_count: Number(run?.failed_count ?? 0) + Math.max(0, list.length - written),
      kotak_count: Number(run?.kotak_count ?? 0) + kotakCount,
      yahoo_count: Number(run?.yahoo_count ?? 0) + yahooCount,
      last_symbol: String(list[list.length - 1].symbol),
    }).eq("sweep_id", sweepId);

    const lastSymbol = String(list[list.length - 1].symbol);
    const drained = list.length < limit;

    if (drained) {
      const { data: promotion, error: promotionError } = await svc.rpc("promote_market_live_sweep", {
        _sweep_id: sweepId,
        _min_coverage: 0.98,
      });
      if (promotionError) return errorResponse(req, promotionError.message, 500);
      await svc.from("market_ingestion_runs").insert({
        source: "live_sweep", stage: "drained", status: promotion?.promoted ? "ok" : "error",
        trade_date: sessionDate, rows_ingested: written,
        metadata: { sweep_id: sweepId, as_of: asOf, broker: brokerAvailable ? "kotak" : "none", promotion },
      });
    } else if (chain && isCron) {
      const secret = req.headers.get("x-cron-secret") ?? "";
      const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/market-live-sweep`;
      const next = fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cron-secret": secret },
        body: JSON.stringify({ cursor: lastSymbol, limit, chain: true, force, sweep_id: sweepId, as_of: asOf }),
      }).catch(() => undefined);
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(next);
    }

    return jsonResponse(req, {
      ok: true,
      session_date: sessionDate,
      sweep_id: sweepId,
      scanned: list.length,
      priced: priced.size,
      written,
      broker: brokerAvailable ? "kotak" : "none",
      yahoo_filled: missing.length,
      as_of: asOf,
      drained,
      cursor: lastSymbol,
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
