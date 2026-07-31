// market-index-constituents — fetches Indian index member lists from
// niftyindices.com, persists them to market_index_members, and joins latest scores.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";

// Every call re-runs persistMembers' delete+upsert against market_index_members
// (and market_stocks/market_data) regardless of the 5-min CSV cache — worth
// gating against a runaway/abusive client even though upstream scraping is
// already capped by the in-memory cache.
const limiter = createMarketLimiter(30, 60_000);

// CSV parsing + mirror fallback live in the shared module so the self-test
// probe checks this exact path instead of NSE's blocked JSON API.
import { fetchCsvMembers, SLUG_TO_FILE, type IndexMember as Member } from "../_shared/market/indexConstituents.ts";

const SLUG_TO_KEY: Record<string, string> = {
  nifty50: "NIFTY50",
  niftynext50: "NIFTYNEXT50",
  nifty100: "NIFTY100",
  nifty200: "NIFTY200",
  nifty500: "NIFTY500",
  niftymidcap100: "NIFTYMIDCAP100",
  niftysmallcap100: "NIFTYSMALLCAP100",
  niftybank: "BANKNIFTY",
  niftyfinservice: "FINNIFTY",
  niftyit: "NIFTYIT",
  niftyauto: "NIFTYAUTO",
  niftypharma: "NIFTYPHARMA",
  niftyfmcg: "NIFTYFMCG",
  niftymetal: "NIFTYMETAL",
  niftyrealty: "NIFTYREALTY",
  niftyenergy: "NIFTYENERGY",
};

// 5-min in-memory cache
const CACHE = new Map<string, { at: number; members: Member[] }>();
const TTL = 5 * 60_000;

async function loadMembers(slug: string): Promise<{ members: Member[]; reason?: string }> {
  const file = SLUG_TO_FILE[slug];
  if (!file) return { members: [], reason: "unsupported slug" };
  const cached = CACHE.get(slug);
  if (cached && Date.now() - cached.at < TTL) return { members: cached.members };
  const { members } = await fetchCsvMembers(file);
  if (members.length > 0) CACHE.set(slug, { at: Date.now(), members });
  return members.length > 0 ? { members } : { members: [], reason: "empty upstream" };
}

async function persistMembers(svc: ReturnType<typeof svcClient>, slug: string, members: Member[]) {
  const indexKey = SLUG_TO_KEY[slug];
  if (!indexKey || members.length === 0) return 0;
  const rows = members.map((m, i) => ({
    index_key: indexKey,
    symbol: m.symbol,
    exchange: "NSE",
    rank: i + 1,
    updated_at: new Date().toISOString(),
  }));
  await svc.from("market_index_members").delete().eq("index_key", indexKey);
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await svc.from("market_index_members").upsert(rows.slice(i, i + 500), { onConflict: "index_key,symbol" });
    if (error) throw error;
  }
  for (let i = 0; i < members.length; i += 500) {
    const batch = members.slice(i, i + 500).map((m) => ({
      symbol: m.symbol,
      exchange: "NSE",
      company_name: m.company || m.symbol,
      industry: m.industry,
      yahoo_symbol: `${m.symbol}.NS`,
      is_active: true,
      in_universe: true,
      ...(indexKey === "NIFTY500" ? { is_nifty500: true } : {}),
    }));
    await svc.from("market_stocks").upsert(batch, { onConflict: "symbol,exchange" });
    // Dual-write the same membership/universe flags into market_data — the
    // table screener/alerts/autotrade actually read. Without this, a symbol
    // newly promoted into an index here showed correct membership in
    // market_stocks but stayed stale/absent in market_data until the next
    // full weekly market-scrips-sync reconciled it.
    await svc.from("market_data").upsert(batch, { onConflict: "symbol,exchange" });
  }
  return rows.length;
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const isCron = req.headers.get("x-cron-secret") != null;
    if (isCron) {
      const guard = await requireCronSecret(req);
      if (guard) return guard;
    } else {
      const auth = await requireUserId(req);
      if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
      const rl = limiter.guard(req, auth.userId); if (rl) return rl;
    }

    const { slug, all } = await req.json().catch(() => ({}));
    const svc = svcClient();

    if (all === true || slug === "all" || (isCron && !slug)) {
      const results: Record<string, number> = {};
      for (const key of ["nifty50", "niftynext50", "nifty100", "nifty200", "nifty500", "niftymidcap100", "niftysmallcap100", "niftybank", "niftyfinservice"]) {
        const { members } = await loadMembers(key);
        results[SLUG_TO_KEY[key]] = await persistMembers(svc, key, members);
      }
      return jsonResponse(req, { ok: true, persisted: results });
    }

    const key = String(slug ?? "").toLowerCase();
    if (!SLUG_TO_FILE[key]) return jsonResponse(req, { members: [], reason: "unsupported slug" });

    const { members, reason } = await loadMembers(key);
    if (members.length === 0) return jsonResponse(req, { members: [], reason });
    const persisted = await persistMembers(svc, key, members);

    const symbols = members.map((m) => m.symbol);
    // Latest score per symbol
    const { data: scores } = await svc
      .from("market_stock_scores")
      .select("symbol,exchange,trade_date,close,change_pct,breakout_score,prebreakout_score,sector,rel_volume,rsi14")
      .in("symbol", symbols)
      .order("trade_date", { ascending: false });
    const latest = new Map<string, any>();
    for (const s of scores ?? []) if (!latest.has(s.symbol)) latest.set(s.symbol, s);

    const out = members.map((m) => {
      const s = latest.get(m.symbol);
      return {
        symbol: m.symbol,
        company: m.company,
        sector: s?.sector ?? m.industry ?? null,
        close: s?.close ?? null,
        change_pct: s?.change_pct ?? null,
        breakout_score: s?.breakout_score ?? null,
        prebreakout_score: s?.prebreakout_score ?? null,
        rel_volume: s?.rel_volume ?? null,
        rsi14: s?.rsi14 ?? null,
      };
    });
    return jsonResponse(req, { members: out, count: out.length, persisted, slug: key, index_key: SLUG_TO_KEY[key] });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
