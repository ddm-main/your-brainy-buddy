// market-quotes — batch quotes through the active provider (Kotak with
// instrument tokens when connected, Yahoo otherwise/as fallback). Symbols
// that neither provider can quote fall back to the last cached daily close
// so the UI never renders "—" LTP for a symbol we actually know a price for.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { getReadProvider } from "../_shared/market/provider.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";

// This is the hot ~1s-poll path (provider.ts comment) across several panels
// at once, so the ceiling is generous — it exists to catch a buggy client
// or leaked token polling unbounded (Kotak/Yahoo lockout risk), not normal
// multi-panel usage.
const limiter = createMarketLimiter(300, 60_000);

const istDateKey = (d: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

function expectedTradingDate(): string {
  const d = new Date();
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
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

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const auth = await requireUserId(req);
    if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
    const rl = limiter.guard(req, auth.userId); if (rl) return rl;
    const body = await req.json().catch(() => ({}));
    const symbols: string[] = Array.isArray(body?.symbols) ? body.symbols : [];
    if (symbols.length === 0) return jsonResponse(req, { quotes: [], source: "none" });

    const svc = svcClient();
    const { provider } = await getReadProvider(svc, auth.userId);
    let rows = await provider.getQuotes(symbols);
    const byKey = new Map(rows.map((r) => [r.key, r]));

    // Retry once for symbols the provider couldn't quote — mitigates Yahoo 429s.
    const missing = symbols.filter((k) => {
      const q = byKey.get(k);
      return !q || !q.price;
    });
    if (missing.length > 0) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const retry = await provider.getQuotes(missing);
        for (const r of retry) if (r.price) byKey.set(r.key, r);
      } catch { /* keep first-pass results */ }
    }

    // Cache-fallback: latest daily close for anything still missing.
    const stillMissing = symbols.filter((k) => {
      const q = byKey.get(k);
      return !q || !q.price;
    });
    if (stillMissing.length > 0) {
      const parsed = stillMissing.map((k) => {
        const [ex, sym] = k.includes(":") ? k.split(":") : ["NSE", k];
        return { key: k, exchange: ex, symbol: sym };
      });
      const uniqSymbols = [...new Set(parsed.map((p) => p.symbol))];
      const { data: cache } = await svc
        .from("market_daily_prices")
        .select("symbol,exchange,close,trade_date")
        .in("symbol", uniqSymbols)
        .order("trade_date", { ascending: false })
        .limit(2000);
      const byKeyRows = new Map<string, Array<{ close: number; trade_date: string }>>();
      for (const r of (cache ?? []) as any[]) {
        const key = `${r.exchange}:${r.symbol}`;
        const list = byKeyRows.get(key) ?? [];
        list.push({ close: Number(r.close), trade_date: r.trade_date });
        byKeyRows.set(key, list);
      }
      const expected = expectedTradingDate();
      for (const p of parsed) {
        const rows = byKeyRows.get(p.key) ?? [];
        const hit = rows[0];
        const previous = rows.find((r) => r.trade_date < hit?.trade_date);
        if (hit && hit.close) {
          const isStale = hit.trade_date < expected;
          byKey.set(p.key, {
            key: p.key,
            price: hit.close,
            previous_close: !isStale && previous?.close ? previous.close : null,
            change_abs: !isStale && previous?.close ? hit.close - previous.close : null,
            change_pct: !isStale && previous?.close ? ((hit.close - previous.close) / previous.close) * 100 : null,
            volume: null,
            source: "cache" as any,
            as_of: hit.trade_date,
            previous_close_as_of: previous?.trade_date ?? null,
          });
        }
      }
    }

    // Anchor previous_close to our EOD cache. Providers (Yahoo especially)
    // occasionally return a prev_close from N-2 when their daily series lags
    // by a day — corrupting today's change% for every downstream P&L number.
    // Our market_daily_prices is the canonical prior-session record; if it
    // has a close strictly before today (IST) that disagrees with the
    // provider, cache wins. Only for symbols we have a live provider price
    // for; the cache-fallback branch above already handled the rest.
    const today = currentIstDate();
    const expected = expectedTradingDate();
    // Cheap, local, no-external-call sanity check on the hot live-quote
    // path — parity.ts's Tickertape-based audit only ever runs offline
    // (market-parity-refresh/market-value-audit), so a wrong-decimal or
    // stuck-price tick could reach the client with nothing checking it.
    // A >5x (or <1/5) move against yesterday's real close is never a
    // legitimate single-session equity move outside a split/bonus, which
    // the corp-action guard below already accounts for.
    const suspiciousKeys = new Set<string>();
    const resolvedKeys = symbols.filter((k) => {
      const q = byKey.get(k);
      return q && q.price && (q as any).source !== "cache";
    });
    if (resolvedKeys.length > 0) {
      const parsed = resolvedKeys.map((k) => {
        const [ex, sym] = k.includes(":") ? k.split(":") : ["NSE", k];
        return { key: k, exchange: ex, symbol: sym };
      });
      const uniqSymbols = [...new Set(parsed.map((p) => p.symbol))];
      const { data: cache } = await svc
        .from("market_daily_prices")
        .select("symbol,exchange,close,trade_date")
        .in("symbol", uniqSymbols)
        .lt("trade_date", today)
        .order("trade_date", { ascending: false })
        .limit(2000);
      const priorByKey = new Map<string, { close: number; trade_date: string }>();
      for (const r of (cache ?? []) as any[]) {
        const key = `${r.exchange}:${r.symbol}`;
        if (!priorByKey.has(key)) priorByKey.set(key, { close: Number(r.close), trade_date: r.trade_date });
      }
      // Corp-action guard: a real split/bonus/dividend ex-dated between the
      // cached close and today explains a large delta on its own — without
      // this, the "cache wins on >0.5% disagreement" heuristic below would
      // "correct" a genuine adjustment back to the stale unadjusted value.
      const { data: recentActions } = await svc
        .from("corporate_actions")
        .select("symbol,exchange,ex_date")
        .in("symbol", uniqSymbols)
        .lte("ex_date", today)
        .order("ex_date", { ascending: false })
        .limit(2000);
      const actionExDatesByKey = new Map<string, string[]>();
      for (const a of (recentActions ?? []) as any[]) {
        const key = `${a.exchange}:${a.symbol}`;
        const list = actionExDatesByKey.get(key) ?? [];
        list.push(a.ex_date);
        actionExDatesByKey.set(key, list);
      }
      for (const p of parsed) {
        const cached = priorByKey.get(p.key);
        if (!cached || !cached.close) continue;
        // Freshness guard: only trust the cache as the reference T-1 close
        // if the row itself isn't stale (missed sync day) — overriding with
        // an even-older cached close would corrupt day_change for every
        // downstream consumer, including AutoTrade/alerts, instead of
        // protecting it.
        if (cached.trade_date < expected) continue;
        const hasRecentCorpAction = (actionExDatesByKey.get(p.key) ?? []).some((d) => d > cached.trade_date);
        const q = byKey.get(p.key)!;
        if (!hasRecentCorpAction && q.price > 0) {
          const ratio = q.price / cached.close;
          if (ratio > 5 || ratio < 0.2) {
            suspiciousKeys.add(p.key);
            try {
              await svc.from("market_value_audit").insert({
                symbol: p.symbol, exchange: p.exchange, field: "price",
                our_value: q.price, ref_value: cached.close, ref_source: "market_daily_prices_t1",
                delta_pct: (ratio - 1) * 100, checked_at: new Date().toISOString(),
                source_provider: q.source ?? provider.name, source_method: "market-quotes live sanity",
                status: "mismatch", threshold_pct: 400,
                remediation: "live quote is >5x (or <1/5) yesterday's close with no corporate action on file — check for a decimal-place or stuck-price error",
              });
            } catch { /* best-effort — never let audit logging fail the quote response */ }
          }
        }
        if (hasRecentCorpAction) continue;
        // Prefer cache when the provider's prev_close is missing, or when
        // the cache's row is newer than the provider's prev_close_as_of, or
        // when they disagree by more than 0.5% (a real different-day mismatch,
        // not a rounding difference).
        const providerPrev = (q as any).previous_close as number | null | undefined;
        const providerAsOf = (q as any).previous_close_as_of as string | null | undefined;
        const disagrees =
          providerPrev == null ||
          (providerAsOf && providerAsOf < cached.trade_date) ||
          Math.abs((providerPrev - cached.close) / cached.close) > 0.005;
        if (!disagrees) continue;
        const changeAbs = q.price - cached.close;
        (q as any).previous_close = cached.close;
        (q as any).previous_close_as_of = cached.trade_date;
        (q as any).change_abs = changeAbs;
        (q as any).change_pct = (changeAbs / cached.close) * 100;
        byKey.set(p.key, q);
      }
    }

    const allowDayMove = isCurrentIstTradingDay();

    const out = symbols.flatMap((key) => {
      const q = byKey.get(key);
      if (!q || !q.price) return [];
      const [ex, sym] = key.includes(":") ? key.split(":") : ["NSE", key];
      const stale = q.as_of != null && q.as_of < expected;
      const dayUnavailable = !allowDayMove || !q.as_of || q.as_of !== today;
      return [{
        symbol: sym,
        exchange: ex,
        ltp: q.price,
        previous_close: stale || dayUnavailable ? null : q.previous_close ?? null,
        change_pct: stale || dayUnavailable ? null : q.change_pct ?? null,
        day_change: stale || dayUnavailable ? null : q.change_abs ?? null,
        // Today's cumulative traded volume from the provider — used by the
        // chart's live-bar volume overlay and the Analysis right-rail
        // "Volume" readout. Kotak surfaces `vol_traded_today`; Yahoo
        // surfaces `regularMarketVolume`. Null when neither has coverage.
        volume: (q as any).volume ?? null,
        source: q.source,
        provider: (q.source === "cache" ? "cache" : String(q.source ?? provider.name)) as string,
        as_of: q.as_of ?? null,
        previous_close_as_of: q.previous_close_as_of ?? null,
        stale,
        suspicious: suspiciousKeys.has(key),
      }];
    });

    // Top-level provider summary — tells the UI whether the batch was fully
    // Kotak (real-time), fully Yahoo (~15m delayed), mixed, or just cache.
    // Used to render an honest "live · kotak" / "delayed · yahoo" chip rather
    // than the previous "any-stale-row → delayed" heuristic that lied when
    // Kotak fulfilled most symbols and Yahoo backfilled a few.
    const provSet = new Set(out.map((r) => r.provider).filter(Boolean));
    let providerSummary: "kotak" | "yahoo" | "cache" | "mixed" | "none" = "none";
    if (provSet.size === 1) {
      const only = [...provSet][0];
      providerSummary = only === "kotak" || only === "yahoo" || only === "cache" ? only : "mixed";
    } else if (provSet.size > 1) {
      providerSummary = "mixed";
    }

    return jsonResponse(req, { quotes: out, source: provider.name, provider: providerSummary });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
