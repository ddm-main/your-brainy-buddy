// market-indices — user's chosen indices + latest market breadth.
// Routes through the ACTIVE PROVIDER (Kotak Neo when connected, Yahoo
// otherwise). Kotak's provider auto-falls-back to Yahoo per-symbol for
// indices whose tokens aren't in market_stocks — so NIFTY/BANKNIFTY go
// real-time when Kotak has them, everything else stays via Yahoo.
// Reads from public.market_index_watch; falls back to a default 6 when empty.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";

const limiter = createMarketLimiter(300, 60_000);

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
    const rl = limiter.guard(req, auth.userId); if (rl) return rl;

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

    // Route through the active provider. Keys are "NSE:<symbol>" — Kotak
    // provider looks them up in the instrument-token map; anything not found
    // (all indices, most of the time) falls back to Yahoo transparently.
    const { provider } = await getActiveProvider(svc, auth.userId);
    const keys = source.map((r) => `NSE:${r.symbol}`);
    const quoteRows = await provider.getQuotes(keys);
    const byKey = new Map(quoteRows.map((q) => [q.key, q]));

    const providers = new Set<string>();
    const out = source.map((r) => {
      const q = byKey.get(`NSE:${r.symbol}`);
      if (q?.source) providers.add(q.source);
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
        source: q?.source ?? null,
      };
    });

    // Top-level provider summary — same convention as market-quotes so the
    // strip can render an honest live/delayed chip.
    let providerSummary: "kotak" | "yahoo" | "mixed" | "cache" | "none" = "none";
    if (providers.size === 1) {
      const only = [...providers][0];
      providerSummary = only === "kotak" || only === "yahoo" || only === "cache" ? only : "mixed";
    } else if (providers.size > 1) {
      providerSummary = "mixed";
    }

    return jsonResponse(req, { quotes: out, breadth: breadthRes.data ?? null, source: provider.name, provider: providerSummary });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
