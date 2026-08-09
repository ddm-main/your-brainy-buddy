// market-quotes — the live price path. Kotak Neo only, and deliberately thin.
//
// This route used to do a lot more than quote: per poll it read
// market_daily_prices twice (cache fallback + previous-close anchor), read
// corporate_actions, wrote market_value_audit rows on a price sanity check,
// and fell back to Yahoo and then to a stored daily close labelled
// `source: "cache"`. That made the hottest path in the app both slow (three
// chunked PostgREST round-trips before the response) and a steady source of
// database egress and writes — and it let a ~15-minute-old Yahoo number, or
// yesterday's close, render as if it were a live tick.
//
// Policy now:
//   - The broker is the only live source. No Yahoo substitution, no stored
//     close substitution. If Kotak can't answer, the response says so and the
//     client keeps showing the EOD value it already loaded.
//   - Zero DB reads on the live path. `previous_close` comes from the broker
//     tick; when the broker omits it the client anchors day-change against the
//     previous close on the row it already has.
//   - Zero DB writes on the live path, apart from the throttled feed
//     heartbeat (one upsert per minute per isolate at most). The price sanity
//     check moved off this path — market-data-validation already audits
//     prices against the prior close after the close.
//
// Yahoo remains the provider for EOD/history pipelines and explicit
// off-session views; it just never masquerades as a live quote here.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { getReadProvider } from "../_shared/market/provider.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";
import { getSharedQuotes } from "../_shared/market/quoteCache.ts";
import { recordFeedHeartbeat } from "../_shared/market/heartbeat.ts";
import { getFeedRoute } from "../_shared/market/feedRoute.ts";

// This is the hot poll path across several panels at once, so the ceiling is
// generous — it exists to catch a buggy client or leaked token polling
// unbounded (broker lockout risk), not normal multi-panel usage.
const limiter = createMarketLimiter(300, 60_000);

const istDateKey = (d: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

function expectedTradingDate(): string {
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  const day = ist.getUTCDay();
  if (day === 0) ist.setUTCDate(ist.getUTCDate() - 2);
  if (day === 6) ist.setUTCDate(ist.getUTCDate() - 1);
  return istDateKey(new Date(ist.getTime() - 5.5 * 3600_000));
}

function currentIstDate(): string {
  return istDateKey(new Date());
}

function isCurrentIstTradingDay(): boolean {
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  const day = ist.getUTCDay();
  return day !== 0 && day !== 6;
}

/** True when the resolved provider is the broker (real-time), not Yahoo. */
function isBroker(name: string): boolean {
  return name === "kotak_neo" || name === "kotak";
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const auth = await requireUserId(req);
    if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
    const rl = limiter.guard(req, auth.userId); if (rl) return rl;
    const body = await req.json().catch(() => ({}));
    const symbols: string[] = Array.isArray(body?.symbols) ? body.symbols : [];
    if (symbols.length === 0) {
      return jsonResponse(req, { quotes: [], source: "none", provider: "none" });
    }

    const svc = svcClient();
    // Honour the operator's Feed Routing choice for the live-price feed.
    const route = await getFeedRoute(svc, "ltp");
    const { provider } = await getReadProvider(svc, auth.userId, "ltp");
    // A deliberately pinned public vendor is a valid answer for this route —
    // it is only "broker unavailable" when nobody asked for a vendor.
    const vendorPinned = route.primary === "yahoo" || route.primary === "nse";

    // Broker-only: a Yahoo-backed provider cannot serve this route. Tell the
    // client plainly so it can render "kotak session expired — reconnect"
    // instead of silently drawing a delayed price as live.
    if (!isBroker(provider.name) && !vendorPinned) {
      recordFeedHeartbeat(svc, {
        feedId: "quotes_ltp",
        provider: "kotak_neo",
        path: "live",
        ok: false,
        symbols: 0,
        detail: `broker session unavailable (resolved provider: ${provider.name})`,
      });
      return jsonResponse(req, {
        quotes: [],
        source: "none",
        provider: "none",
        broker: "kotak",
        broker_available: false,
        reason: "broker_unavailable",
      });
    }

    const quoteT0 = Date.now();
    // Shared cache + in-flight de-dup: all users read one system Kotak
    // session, so identical symbol requests must coalesce upstream.
    let rows: Awaited<ReturnType<typeof getSharedQuotes>> = [];
    let fetchError: string | null = null;
    try {
      rows = await getSharedQuotes(provider, symbols);
    } catch (e) {
      fetchError = e instanceof Error ? e.message : String(e);
    }
    const byKey = new Map(rows.map((r) => [r.key, r]));

    // One fast retry for symbols the broker didn't price on the first pass.
    // Short delay: this path is latency-critical, and a Kotak miss is usually
    // a token-map gap rather than a rate limit.
    const missing = symbols.filter((k) => {
      const q = byKey.get(k);
      return !q || !q.price;
    });
    if (missing.length > 0) {
      await new Promise((r) => setTimeout(r, 120));
      try {
        const retry = await getSharedQuotes(provider, missing);
        for (const r of retry) if (r.price) byKey.set(r.key, r);
      } catch { /* keep first-pass results */ }
    }

    const today = currentIstDate();
    const expected = expectedTradingDate();
    const allowDayMove = isCurrentIstTradingDay();

    const out = symbols.flatMap((key) => {
      const q = byKey.get(key);
      if (!q || !q.price) return [];
      const [ex, sym] = key.includes(":") ? key.split(":") : ["NSE", key];
      const stale = q.as_of != null && q.as_of < expected;
      const dayUnavailable = !allowDayMove || !q.as_of || q.as_of !== today;
      // Day-move fields come straight from the broker tick. When the broker
      // omits previous_close we send null rather than reading it back out of
      // market_daily_prices on every poll — the client already holds the EOD
      // previous close for the row and anchors the change there.
      return [{
        symbol: sym,
        exchange: ex,
        ltp: q.price,
        previous_close: stale || dayUnavailable ? null : q.previous_close ?? null,
        change_pct: stale || dayUnavailable ? null : q.change_pct ?? null,
        day_change: stale || dayUnavailable ? null : q.change_abs ?? null,
        // Today's cumulative traded volume from the broker — used by the
        // chart's live-bar volume overlay and the Analysis "Volume" readout.
        volume: (q as any).volume ?? null,
        // Current session's open/high/low straight from the broker.
        day_open: stale || dayUnavailable ? null : (q as any).day_open ?? null,
        day_high: stale || dayUnavailable ? null : (q as any).day_high ?? null,
        day_low: stale || dayUnavailable ? null : (q as any).day_low ?? null,
        source: q.source,
        provider: isBroker(provider.name) ? "kotak" : provider.name,
        as_of: q.as_of ?? null,
        previous_close_as_of: q.previous_close_as_of ?? null,
        stale,
      }];
    });

    const servingName = isBroker(provider.name) ? "kotak" : provider.name;
    const providerSummary = out.length > 0 ? servingName : "none";

    // Liveness stamp for the Feed Routing page: who answered, and how fast.
    // recordFeedHeartbeat throttles steady-state writes per isolate and only
    // writes a failure transition immediately.
    recordFeedHeartbeat(svc, {
      feedId: "quotes_ltp",
      provider: providerSummary === "none" ? servingName : providerSummary,
      path: "live",
      ok: out.length > 0,
      latencyMs: Date.now() - quoteT0,
      symbols: out.length,
      detail: out.length === 0
        ? (fetchError ?? "broker returned no price for the requested symbols")
        : null,
    });

    return jsonResponse(req, {
      quotes: out,
      source: provider.name,
      provider: providerSummary,
      broker: isBroker(provider.name) ? "kotak" : provider.name,
      broker_available: isBroker(provider.name),
      ...(vendorPinned && !isBroker(provider.name) ? { routed: "vendor_pinned" } : {}),
      ...(out.length === 0 ? { reason: fetchError ? "broker_error" : "no_prices" } : {}),
      ...(fetchError ? { error_detail: fetchError } : {}),
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
