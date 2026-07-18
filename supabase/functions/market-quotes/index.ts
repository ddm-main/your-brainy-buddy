// market-quotes — batch quotes through the active provider (Kotak with
// instrument tokens when connected, Yahoo otherwise/as fallback). Symbols
// that neither provider can quote fall back to the last cached daily close
// so the UI never renders "—" LTP for a symbol we actually know a price for.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const auth = await requireUserId(req);
    if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
    const body = await req.json().catch(() => ({}));
    const symbols: string[] = Array.isArray(body?.symbols) ? body.symbols : [];
    if (symbols.length === 0) return jsonResponse(req, { quotes: [], source: "none" });

    const svc = svcClient();
    const { provider } = await getActiveProvider(svc, auth.userId);
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
      const latest = new Map<string, { close: number; trade_date: string }>();
      for (const r of (cache ?? []) as any[]) {
        const key = `${r.exchange}:${r.symbol}`;
        if (!latest.has(key)) latest.set(key, { close: Number(r.close), trade_date: r.trade_date });
      }
      for (const p of parsed) {
        const hit = latest.get(p.key);
        if (hit && hit.close) {
          byKey.set(p.key, {
            key: p.key,
            price: hit.close,
            change_abs: null,
            change_pct: null,
            volume: null,
            source: "cache" as any,
          });
        }
      }
    }

    const out = symbols.flatMap((key) => {
      const q = byKey.get(key);
      if (!q || !q.price) return [];
      const [ex, sym] = key.includes(":") ? key.split(":") : ["NSE", key];
      return [{
        symbol: sym,
        exchange: ex,
        ltp: q.price,
        change_pct: q.change_pct ?? null,
        day_change: q.change_abs ?? null,
        source: q.source,
      }];
    });
    return jsonResponse(req, { quotes: out, source: provider.name });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
