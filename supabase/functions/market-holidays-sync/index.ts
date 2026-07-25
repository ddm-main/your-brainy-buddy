// Kotak Neo has no coverage for this data (fundamentals / news / reference / option-chain) — vendor-specific by design; do not re-route to getActiveProvider.
// market-holidays-sync — pulls NSE's trading-holiday list. Low-churn data
// (known months ahead, changes yearly), so this runs on a light annual cron
// plus manual trigger rather than a live pipeline.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { nseHolidays } from "../_shared/market/nseClient.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.headers.get("x-cron-secret") != null) {
    const guard = await requireCronSecret(req);
    if (guard) return guard;
  } else {
    const auth = await requireUserId(req);
    if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  }
  try {
    const svc = svcClient();
    const holidays = await nseHolidays();
    if (holidays.length === 0) return jsonResponse(req, { ok: true, upserted: 0, note: "no holidays returned — NSE endpoint may have changed shape" });
    const rows = holidays.map((h) => ({ holiday_date: h.date, description: h.description, exchange: "NSE" }));
    const { error } = await svc.from("market_holidays").upsert(rows, { onConflict: "holiday_date,exchange" });
    if (error) return errorResponse(req, error.message, 502);
    return jsonResponse(req, { ok: true, upserted: rows.length });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
