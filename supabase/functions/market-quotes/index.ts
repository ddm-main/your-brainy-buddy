// market-quotes — batch quote fetch. Uses Yahoo (works without Kotak session).
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, yahooQuote } from "../_shared/market/common.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const auth = await requireUserId(req);
    if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
    const body = await req.json().catch(() => ({}));
    const symbols: string[] = Array.isArray(body?.symbols) ? body.symbols : [];
    // "NSE:RELIANCE" -> "RELIANCE.NS"
    const yahoo = symbols.map((s) => {
      const [ex, sym] = s.includes(":") ? s.split(":") : ["NSE", s];
      return { key: s, ex, sym, y: ex === "BSE" ? `${sym}.BO` : `${sym}.NS` };
    });
    const quotes = await yahooQuote(yahoo.map((x) => x.y));
    const byY = new Map(quotes.map((q) => [q.symbol, q]));
    const out = yahoo.map((x) => {
      const q = byY.get(x.y);
      return {
        symbol: x.sym, exchange: x.ex,
        ltp: q?.price ?? 0,
        change_pct: q?.change_pct ?? null,
        day_change: q?.change_abs ?? null,
      };
    });
    return jsonResponse(req, { quotes: out, source: "yahoo" });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
