// market-indices — user's chosen indices + latest market breadth.
// Reads from public.market_index_watch; falls back to a default 6 when empty.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient, yahooQuote } from "../_shared/market/common.ts";

const DEFAULTS = [
  { symbol: "^NSEI",               name: "Nifty 50",   region: "IN", nse_symbol: "NIFTY",     fno_enabled: true,  constituents_slug: "nifty50" },
  { symbol: "^BSESN",              name: "Sensex",     region: "IN", nse_symbol: null,        fno_enabled: false, constituents_slug: null },
  { symbol: "^NSEBANK",            name: "Bank Nifty", region: "IN", nse_symbol: "BANKNIFTY", fno_enabled: true,  constituents_slug: "niftybank" },
  { symbol: "NIFTY_MIDCAP_100.NS", name: "Midcap 100", region: "IN", nse_symbol: null,        fno_enabled: false, constituents_slug: "niftymidcap100" },
  { symbol: "^CNXSC",              name: "Smallcap",   region: "IN", nse_symbol: null,        fno_enabled: false, constituents_slug: null },
  { symbol: "^INDIAVIX",           name: "India VIX",  region: "IN", nse_symbol: null,        fno_enabled: false, constituents_slug: null },
];

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const auth = await requireUserId(req);
    if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });

    const svc = svcClient();
    const [watchRes, breadthRes] = await Promise.all([
      svc.from("market_index_watch").select("*").eq("user_id", auth.userId).order("sort_order"),
      svc.from("market_breadth_daily").select("*").order("trade_date", { ascending: false }).limit(1).maybeSingle(),
    ]);

    let rows = (watchRes.data ?? []) as Array<typeof DEFAULTS[number] & { user_id: string }>;
    if (rows.length === 0) {
      // Backup seed if trigger didn't run (edge case)
      try {
        await svc.from("market_index_watch").insert(
          DEFAULTS.map((d, i) => ({ ...d, user_id: auth.userId, sort_order: i + 1 })),
        );
        const r2 = await svc.from("market_index_watch").select("*").eq("user_id", auth.userId).order("sort_order");
        rows = (r2.data ?? []) as any;
      } catch { /* fall through */ }
    }
    const source = rows.length > 0 ? rows : DEFAULTS;

    const quotes = await yahooQuote(source.map((r) => r.symbol));
    const byS = new Map(quotes.map((q) => [q.symbol, q]));
    const out = source.map((r) => {
      const q = byS.get(r.symbol);
      return {
        symbol: r.symbol,
        name: r.name,
        region: r.region,
        nse_symbol: r.nse_symbol,
        fno_enabled: r.fno_enabled,
        constituents_slug: (r as any).constituents_slug ?? null,
        price: q?.price ?? 0,
        change_pct: q?.change_pct ?? null,
        change_abs: q?.change_abs ?? null,
      };
    });
    return jsonResponse(req, { quotes: out, breadth: breadthRes.data ?? null, source: "yahoo" });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
