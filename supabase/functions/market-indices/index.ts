// market-indices — index quotes (Yahoo) + latest computed market breadth.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient, yahooQuote } from "../_shared/market/common.ts";

const INDICES = [
  { symbol: "^NSEI", name: "Nifty 50" },
  { symbol: "^BSESN", name: "Sensex" },
  { symbol: "^NSEBANK", name: "Bank Nifty" },
  { symbol: "NIFTY_MIDCAP_100.NS", name: "Midcap 100" },
  { symbol: "^CNXSC", name: "Smallcap" },
  { symbol: "^INDIAVIX", name: "India VIX" },
];

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const auth = await requireUserId(req);
    if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });

    const svc = svcClient();
    const [quotes, breadthRes] = await Promise.all([
      yahooQuote(INDICES.map((i) => i.symbol)),
      svc.from("market_breadth_daily").select("*").order("trade_date", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const byS = new Map(quotes.map((q) => [q.symbol, q]));
    const out = INDICES.map((i) => {
      const q = byS.get(i.symbol);
      return { symbol: i.symbol, name: i.name, price: q?.price ?? 0, change_pct: q?.change_pct ?? null, change_abs: q?.change_abs ?? null };
    });
    return jsonResponse(req, { quotes: out, breadth: breadthRes.data ?? null, source: "yahoo" });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
