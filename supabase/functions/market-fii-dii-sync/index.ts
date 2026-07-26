// Kotak Neo has no coverage for this data (fundamentals / news / reference / option-chain) — vendor-specific by design; do not re-route to getActiveProvider.
// market-fii-dii-sync — daily 18:30 IST. Fetches provisional FII/DII cash
// activity and upserts into fii_dii_activity keyed by (activity_date, segment).
//
// NSE's own /api/fiidiiTradeReact is behind a Cloudflare bot wall that
// consistently blocks Supabase Edge egress even after priming session cookies,
// which is why the table sat empty for months. We now try NSE first (it's
// authoritative when it works), and fall back to Moneycontrol's public
// FII/DII JSON — no cookies, no bot wall — before giving up.
import { corsFor, preflight, jsonResponse, errorResponse, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { safeFetch } from "../_shared/http.ts";

const NSE_HOSTS = ["www.nseindia.com"];
const MC_HOSTS = ["api.moneycontrol.com", "www.moneycontrol.com"];

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.nseindia.com/reports/fii-dii",
};

async function primeNseCookies(): Promise<string> {
  const jar: string[] = [];
  for (const path of ["/", "/reports/fii-dii"]) {
    try {
      const r = await safeFetch(`https://www.nseindia.com${path}`, {
        timeoutMs: 6000, maxBytes: 1024 * 1024, allowHosts: NSE_HOSTS,
        headers: { ...BROWSER_HEADERS, Accept: "text/html,application/xhtml+xml" },
      });
      const setCookie = (r.headers as Headers | undefined)?.getSetCookie?.() ?? [];
      for (const c of setCookie) {
        const pair = c.split(";")[0]?.trim();
        if (pair) jar.push(pair);
      }
    } catch { /* NSE unreachable — cookie prime not fatal, we'll fall back */ }
  }
  const byName = new Map<string, string>();
  for (const pair of jar) byName.set(pair.split("=")[0], pair);
  return [...byName.values()].join("; ");
}

const toNum = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

interface NormalizedRow {
  activity_date: string;
  segment: "CASH";
  fii_gross_buy: number | null;
  fii_gross_sell: number | null;
  dii_gross_buy: number | null;
  dii_gross_sell: number | null;
  fii_net: number | null;
  dii_net: number | null;
  net_buy_inr_cr: number | null;
  source: string;
  updated_at: string;
}

function parseNseDate(s: string | undefined | null, fallbackToday: string): string {
  if (!s) return fallbackToday;
  const t = Date.parse(s.replace(/-/g, " "));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : fallbackToday;
}

async function tryNse(istToday: string): Promise<NormalizedRow | null> {
  try {
    const cookie = await primeNseCookies();
    const r = await safeFetch("https://www.nseindia.com/api/fiidiiTradeReact", {
      timeoutMs: 7000, maxBytes: 256 * 1024, allowHosts: NSE_HOSTS,
      headers: cookie ? { ...BROWSER_HEADERS, Cookie: cookie } : BROWSER_HEADERS,
    });
    if (!r.ok) { console.info("[fii-dii] nse non-2xx", r.status); return null; }
    const rows = JSON.parse(new TextDecoder().decode(r.bytes)) as Array<{
      category: string; buyValue: unknown; sellValue: unknown; netValue: unknown; date: string;
    }>;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const fii = rows.find((r) => /^FII/i.test(r.category ?? ""));
    const dii = rows.find((r) => /^DII/i.test(r.category ?? ""));
    if (!fii || !dii) return null;
    const fiiNet = toNum(fii.netValue);
    const diiNet = toNum(dii.netValue);
    return {
      activity_date: parseNseDate(fii.date, istToday),
      segment: "CASH",
      fii_gross_buy: toNum(fii.buyValue),
      fii_gross_sell: toNum(fii.sellValue),
      dii_gross_buy: toNum(dii.buyValue),
      dii_gross_sell: toNum(dii.sellValue),
      fii_net: fiiNet,
      dii_net: diiNet,
      net_buy_inr_cr: (fiiNet ?? 0) + (diiNet ?? 0),
      source: "nse",
      updated_at: new Date().toISOString(),
    };
  } catch (e) {
    console.info("[fii-dii] nse error", e instanceof Error ? e.message : String(e));
    return null;
  }
}

// Moneycontrol serves the same NSE provisional cash figures via a public
// JSON endpoint used by their FII/DII activity page. No cookies, no bot wall.
// Shape (as of 2026): { data: [{ date:"DD MMM YYYY", fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net, ... }, ...] }
async function tryMoneycontrol(istToday: string): Promise<NormalizedRow | null> {
  const candidates = [
    "https://api.moneycontrol.com/mcapi/v1/fno/marketStats/get-fii-dii-activity?segment=cash",
    "https://www.moneycontrol.com/mccode/common/fii_dii/get_fii_dii_activity.php?segment=cash",
  ];
  for (const url of candidates) {
    try {
      const r = await safeFetch(url, {
        timeoutMs: 7000, maxBytes: 512 * 1024, allowHosts: MC_HOSTS,
        headers: {
          "User-Agent": BROWSER_HEADERS["User-Agent"],
          "Accept": "application/json,text/plain,*/*",
          "Referer": "https://www.moneycontrol.com/stocks/marketstats/fii_dii_activity/index.php",
        },
      });
      if (!r.ok) { console.info("[fii-dii] mc non-2xx", url, r.status); continue; }
      const body = JSON.parse(new TextDecoder().decode(r.bytes)) as any;
      const list: any[] = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
      if (list.length === 0) continue;
      const row = list[0]; // newest first
      const fiiBuy = toNum(row.fii_buy ?? row.fiiBuy ?? row.FIIBuy);
      const fiiSell = toNum(row.fii_sell ?? row.fiiSell ?? row.FIISell);
      const fiiNet = toNum(row.fii_net ?? row.fiiNet ?? row.FIINet) ??
                     ((fiiBuy != null && fiiSell != null) ? fiiBuy - fiiSell : null);
      const diiBuy = toNum(row.dii_buy ?? row.diiBuy ?? row.DIIBuy);
      const diiSell = toNum(row.dii_sell ?? row.diiSell ?? row.DIISell);
      const diiNet = toNum(row.dii_net ?? row.diiNet ?? row.DIINet) ??
                     ((diiBuy != null && diiSell != null) ? diiBuy - diiSell : null);
      if (fiiNet == null && diiNet == null) continue;
      const date = parseNseDate(row.date ?? row.tradeDate ?? row.trade_date, istToday);
      console.info("[fii-dii] mc ok", { url, date, fiiNet, diiNet });
      return {
        activity_date: date,
        segment: "CASH",
        fii_gross_buy: fiiBuy,
        fii_gross_sell: fiiSell,
        dii_gross_buy: diiBuy,
        dii_gross_sell: diiSell,
        fii_net: fiiNet,
        dii_net: diiNet,
        net_buy_inr_cr: (fiiNet ?? 0) + (diiNet ?? 0),
        source: "moneycontrol",
        updated_at: new Date().toISOString(),
      };
    } catch (e) {
      console.info("[fii-dii] mc error", url, e instanceof Error ? e.message : String(e));
    }
  }
  return null;
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const gate = await requireCronSecret(req); if (gate) return gate;
  try {
    const svc = svcClient();
    const istToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

    let row = await tryNse(istToday);
    if (!row) row = await tryMoneycontrol(istToday);

    if (!row) {
      console.info("[fii-dii] all sources failed");
      return errorResponse(req, "all_sources_failed", 502);
    }

    const { error } = await svc.from("fii_dii_activity").upsert(row, { onConflict: "activity_date,segment" });
    if (error) throw error;
    console.info("[fii-dii] upserted", { date: row.activity_date, source: row.source });
    return jsonResponse(req, { ok: true, synced: 1, date: row.activity_date, source: row.source });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
