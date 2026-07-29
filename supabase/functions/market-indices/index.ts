// market-indices — user's chosen indices + latest market breadth.
// Routes through the ACTIVE PROVIDER (Kotak Neo when connected, Yahoo
// otherwise). Kotak's provider auto-falls-back to Yahoo per-symbol for
// indices whose tokens aren't in market_stocks — so NIFTY/BANKNIFTY go
// real-time when Kotak has them, everything else stays via Yahoo.
// Reads from public.market_index_watch; falls back to a default 6 when empty.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { getReadProvider } from "../_shared/market/provider.ts";
import { getSharedQuotes } from "../_shared/market/quoteCache.ts";
import { recordFeedHeartbeat } from "../_shared/market/heartbeat.ts";
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

// Symbols the market strip always renders. They are resolved even when the
// user's own index watchlist doesn't contain them — previously India VIX
// showed a permanent "—" for any user whose watchlist lacked the row.
const ALWAYS = [
  { symbol: "^NSEI",      name: "Nifty 50",   region: "IN", nse_symbol: "NIFTY",     fno_enabled: true,  constituents_slug: "nifty50" },
  { symbol: "^BSESN",     name: "Sensex",     region: "IN", nse_symbol: null,        fno_enabled: false, constituents_slug: null },
  { symbol: "^NSEBANK",   name: "Bank Nifty", region: "IN", nse_symbol: "BANKNIFTY", fno_enabled: true,  constituents_slug: "niftybank" },
  { symbol: "^INDIAVIX",  name: "India VIX",  region: "IN", nse_symbol: null,        fno_enabled: false, constituents_slug: null },
];

const istDate = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

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
    const base = rows.length > 0 ? rows : DEFAULTS;
    // Union of the user's watchlist and the always-on strip symbols, in
    // watchlist order with the missing strip entries appended.
    const seenSym = new Set(base.map((r) => r.symbol));
    const source = [...base, ...ALWAYS.filter((a) => !seenSym.has(a.symbol))] as typeof base;

    // Route through the active provider. Keys are "NSE:<symbol>" — Kotak
    // provider looks them up in the instrument-token map; anything not found
    // (all indices, most of the time) falls back to Yahoo transparently.
    const { provider } = await getReadProvider(svc, auth.userId);
    const keys = source.map((r) => `NSE:${r.symbol}`);
    const idxT0 = Date.now();
    const quoteRows = await getSharedQuotes(provider, keys);
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

    // Persist India VIX onto today's breadth row — nothing else writes that
    // column, so the Breadth panel's "India VIX" cell was always blank.
    const vix = out.find((q) => q.symbol === "^INDIAVIX");
    if (vix && typeof vix.price === "number" && vix.price > 0) {
      svc.from("market_breadth_daily")
        .update({ india_vix: vix.price })
        .eq("trade_date", istDate())
        .then(() => {}, () => {});
    }

    const priced = out.filter((q) => typeof q.price === "number" && q.price > 0).length;
    recordFeedHeartbeat(svc, {
      feedId: "indices",
      provider: providerSummary === "none" ? provider.name : providerSummary,
      ok: priced > 0,
      latencyMs: Date.now() - idxT0,
      symbols: priced,
      detail: priced === 0 ? "no index price returned" : null,
    });

    return jsonResponse(req, { quotes: out, breadth: breadthRes.data ?? null, source: provider.name, provider: providerSummary });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
