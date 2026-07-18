// market-fii-dii-sync — daily 18:30 IST. Fetches NSE provisional FII/DII cash
// activity and upserts into fii_dii_activity keyed by (activity_date, segment).
import { corsFor, preflight, jsonResponse, errorResponse, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { safeFetch } from "../_shared/http.ts";

const NSE_HOSTS = ["www.nseindia.com"];

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const gate = requireCronSecret(req); if (gate) return gate;
  try {
    // NSE FII/DII cash-market provisional. Requires a browser-like UA.
    const url = "https://www.nseindia.com/api/fiidiiTradeReact";
    const r = await safeFetch(url, {
      timeoutMs: 8000, maxBytes: 256 * 1024, allowHosts: NSE_HOSTS,
      headers: {
        "User-Agent": "Mozilla/5.0 (Jarvis fii-dii-sync)",
        "Accept": "application/json",
        "Referer": "https://www.nseindia.com/",
      },
    });
    if (!r.ok) return errorResponse(req, "nse_unreachable", 502);
    let rows: Array<{ category: string; buyValue: number; sellValue: number; netValue: number; date: string }> = [];
    try { rows = JSON.parse(new TextDecoder().decode(r.bytes)); } catch { return errorResponse(req, "nse_parse_fail", 502); }
    if (!Array.isArray(rows) || rows.length === 0) return jsonResponse(req, { ok: true, synced: 0, note: "no rows" });

    const svc = svcClient();
    const dateStr = (() => {
      const d = new Date(); const ist = new Date(d.getTime() + 5.5 * 3600_000);
      return ist.toISOString().slice(0, 10);
    })();
    const fii = rows.find((r) => r.category?.startsWith("FII"));
    const dii = rows.find((r) => r.category?.startsWith("DII"));
    if (!fii || !dii) return errorResponse(req, "missing_fii_or_dii", 502);

    const row = {
      activity_date: dateStr,
      segment: "cash",
      fii_gross_buy: fii.buyValue,
      fii_gross_sell: fii.sellValue,
      dii_gross_buy: dii.buyValue,
      dii_gross_sell: dii.sellValue,
      fii_net: fii.netValue,
      dii_net: dii.netValue,
      net_buy_inr_cr: (fii.netValue ?? 0) + (dii.netValue ?? 0),
      source: "nse",
      updated_at: new Date().toISOString(),
    };
    const { error } = await svc.from("fii_dii_activity").upsert(row, { onConflict: "activity_date,segment" });
    if (error) throw error;
    return jsonResponse(req, { ok: true, synced: 1, date: dateStr });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
