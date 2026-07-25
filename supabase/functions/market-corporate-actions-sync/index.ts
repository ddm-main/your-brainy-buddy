// market-corporate-actions-sync — pulls NSE corporate actions (dividends,
// splits, bonuses, board meetings, results dates). Cron path (daily) covers
// every symbol across every user's watchlist+holdings; user-JWT path scopes
// to just the caller, or an explicit symbol list. Same scoping rationale as
// market-news-sync — this is a personal app, not a full-universe calendar
// product, so it never sweeps the whole market_stocks universe.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { nseCorporateActions } from "../_shared/market/nseClient.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const isCron = req.headers.get("x-cron-secret") != null;
  let userId: string | null = null;
  if (isCron) {
    const guard = await requireCronSecret(req);
    if (guard) return guard;
  } else {
    const auth = await requireUserId(req);
    if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
    userId = auth.userId;
  }
  try {
    const svc = svcClient();
    const b = await req.json().catch(() => ({}));
    let symbols: Array<{ symbol: string; exchange: string }> = Array.isArray(b?.symbols)
      ? b.symbols.map((s: any) => ({ symbol: String(s.symbol ?? s).toUpperCase(), exchange: String(s.exchange ?? "NSE").toUpperCase() }))
      : [];

    if (symbols.length === 0) {
      const watchQ = svc.from("market_watchlist_items").select("symbol,exchange");
      const holdQ = svc.from("market_holdings").select("symbol,exchange");
      const [watch, holdings] = await Promise.all([
        userId ? watchQ.eq("user_id", userId) : watchQ,
        userId ? holdQ.eq("user_id", userId) : holdQ,
      ]);
      const seen = new Set<string>();
      for (const row of [...(watch.data ?? []), ...(holdings.data ?? [])]) {
        const key = `${row.exchange}:${row.symbol}`;
        if (seen.has(key)) continue;
        seen.add(key);
        symbols.push({ symbol: row.symbol, exchange: row.exchange });
      }
    }
    symbols = symbols.filter((s) => s.exchange === "NSE").slice(0, isCron ? 200 : 40); // NSE-only source

    let upserted = 0;
    for (const { symbol, exchange } of symbols) {
      const actions = await nseCorporateActions(symbol);
      if (actions.length === 0) continue;
      const rows = actions
        .filter((a) => a.exDate)
        .map((a) => ({
          symbol, exchange,
          action_type: a.actionType,
          ex_date: a.exDate,
          record_date: a.recordDate,
          details: { subject: a.subject },
        }));
      if (rows.length === 0) continue;
      const { error } = await svc.from("market_corporate_actions")
        .upsert(rows, { onConflict: "symbol,exchange,action_type,ex_date" });
      if (!error) upserted += rows.length;
    }
    return jsonResponse(req, { ok: true, symbols: symbols.length, upserted });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
