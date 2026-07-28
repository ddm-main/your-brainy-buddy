// Kotak Neo has no coverage for this data (fundamentals / news / reference / option-chain) — vendor-specific by design; do not re-route to getActiveProvider.
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
    // Previously a split/bonus/dividend whose ratio/amount regex didn't
    // match the NSE subject phrasing silently got a row with null
    // ratio_from/ratio_to/amount — market-corp-actions-apply's eventFactor()
    // then skips it forever (only counted in an internal `skipped`
    // counter), permanently under-adjusting that symbol's price history
    // with zero operator visibility. Surface these instead of swallowing them.
    const unparsed: Array<{ symbol: string; action_type: string; subject: string }> = [];
    for (const { symbol, exchange } of symbols) {
      const actions = await nseCorporateActions(symbol);
      if (actions.length === 0) continue;
      const rows = actions
        .filter((a) => a.exDate)
        .map((a) => {
          // NSE subject like "FACE VALUE SPLIT FROM RS.10/- TO RS.5/-" or
          // "BONUS 1:1" or "DIVIDEND - RS.5". Parse conservatively.
          const subj = String(a.subject ?? "").toUpperCase();
          const type = a.actionType?.toLowerCase() ?? "";
          const action_type =
            type.includes("split") || subj.includes("SPLIT") ? "split"
            : type.includes("bonus") || subj.includes("BONUS") ? "bonus"
            : type.includes("dividend") || subj.includes("DIVIDEND") ? "dividend"
            : type.includes("rights") ? "rights"
            : null;
          if (!action_type) return null;
          let ratio_from: number | null = null, ratio_to: number | null = null, amount: number | null = null;
          // NSE writes rupees as RS / RS. / RE (singular "Re 1/-"), so every
          // money pattern below accepts both spellings — the old RS-only
          // regexes dropped every "Re 1/- Per Share" dividend and every
          // "From Rs 2/- ... To Re 1/-" face-value split.
          const RUPEE = String.raw`\bR(?:S|E)?\.?\s*`;
          if (action_type === "split") {
            const m = subj.match(new RegExp(`${RUPEE}(\\d+(?:\\.\\d+)?)\\s*(?:/-)?[^0-9]*?TO\\s*${RUPEE}(\\d+(?:\\.\\d+)?)`));
            if (m) { ratio_from = Number(m[1]); ratio_to = Number(m[2]); }
          } else if (action_type === "bonus") {
            const m = subj.match(/BONUS[^0-9]*(\d+)\s*[:\-\/]\s*(\d+)/);
            if (m) { ratio_to = Number(m[1]); ratio_from = Number(m[2]); }
          } else if (action_type === "dividend") {
            const m = subj.match(new RegExp(`${RUPEE}(\\d+(?:\\.\\d+)?)`))
              ?? subj.match(/(\d+(?:\.\d+)?)\s*\/?-?\s*PER\s+SHARE/);
            if (m) amount = Number(m[1]);
          }

          const needsRatio = action_type === "split" || action_type === "bonus";
          const parsedOk = needsRatio ? (ratio_from != null && ratio_to != null) : action_type === "dividend" ? amount != null : true;
          if (!parsedOk) {
            unparsed.push({ symbol, action_type, subject: a.subject ?? "" });
            console.warn(`[market-corporate-actions-sync] could not parse ${action_type} ratio/amount for ${symbol}: "${a.subject}" — row will be inserted with null values and skipped forever by market-corp-actions-apply until manually corrected`);
          }
          return {
            symbol, exchange, action_type,
            ex_date: a.exDate,
            ratio_from, ratio_to, amount,
            purpose: a.subject, source: "nse",
          };
        })
        .filter((r): r is NonNullable<typeof r> => r != null);
      if (rows.length === 0) continue;
      // ON CONFLICT uses the uq_corp_actions_natural unique index we set up.
      for (const row of rows) {
        const { error } = await svc.from("corporate_actions").insert(row);
        // 23505 = unique violation → benign duplicate, skip.
        if (!error) upserted++;
      }
    }
    return jsonResponse(req, { ok: true, symbols: symbols.length, upserted, unparsed });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
