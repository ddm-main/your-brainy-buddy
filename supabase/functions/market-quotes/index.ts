// market-quotes — batch quotes through the active provider (Kotak with
// instrument tokens when connected, Yahoo otherwise/as fallback).
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
    const rows = await provider.getQuotes(symbols);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const out = symbols.map((key) => {
      const [ex, sym] = key.includes(":") ? key.split(":") : ["NSE", key];
      const q = byKey.get(key);
      return {
        symbol: sym,
        exchange: ex,
        ltp: q?.price ?? 0,
        change_pct: q?.change_pct ?? null,
        day_change: q?.change_abs ?? null,
        source: q?.source ?? null,
      };
    });
    return jsonResponse(req, { quotes: out, source: provider.name });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
