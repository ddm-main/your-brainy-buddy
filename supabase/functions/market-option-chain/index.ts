// Kotak Neo has no coverage for this data (fundamentals / news / reference / option-chain) — vendor-specific by design; do not re-route to getActiveProvider.
// market-option-chain — NSE public option chain (indices + equities).
// NSE requires session cookies; we prime them with a homepage fetch.
// P1.13: adds Black-Scholes Greeks (δ, γ, θ, ν) computed from NSE's IV,
// underlying, strike, expiry, and a fixed risk-free rate. Zero-dividend
// approximation (Indian equities' dividend yields are small; for index
// options this is standard practice on Kite/Streak too).
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";

// Scrapes nseindia.com per request (session-cookie priming + fetch) — a
// tighter ceiling than the batch-quote endpoints since runaway polling here
// risks NSE IP-blocking, not just wasted Kotak/Yahoo quota.
const limiter = createMarketLimiter(30, 60_000);

const HEADERS: HeadersInit = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.nseindia.com/option-chain",
};

const INDEX_SYMBOLS = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"]);
// RBI policy rate proxy for risk-free — updated infrequently; a 25bp drift
// changes deep-ITM Greeks by <1%, well within IV noise.
const RISK_FREE = 0.065;

type Greeks = { delta: number; gamma: number; theta: number; vega: number };
type Row = {
  strike: number;
  call: LegSummary | null;
  put: LegSummary | null;
};
type LegSummary = {
  oi: number; oi_change: number; volume: number;
  iv: number | null; ltp: number; change: number;
  bid: number; ask: number;
  greeks: Greeks | null;
};

// Abramowitz & Stegun 7.1.26 normal CDF — good to 7.5e-8, no external dep.
function normCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}
function normPdf(x: number): number { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

function greeks(kind: "CE" | "PE", S: number, K: number, T: number, sigma: number, r = RISK_FREE): Greeks | null {
  if (!(S > 0 && K > 0 && T > 0 && sigma > 0)) return null;
  const vt = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / vt;
  const d2 = d1 - vt;
  const pdfD1 = normPdf(d1);
  const gamma = pdfD1 / (S * vt);
  const vega = S * pdfD1 * Math.sqrt(T) / 100; // per 1 vol-point (1%)
  if (kind === "CE") {
    const delta = normCdf(d1);
    const theta = (-(S * pdfD1 * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * normCdf(d2)) / 365;
    return { delta, gamma, theta, vega };
  } else {
    const delta = normCdf(d1) - 1;
    const theta = (-(S * pdfD1 * sigma) / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * normCdf(-d2)) / 365;
    return { delta, gamma, theta, vega };
  }
}

// Parse NSE expiry ("25-Jul-2026") to years-to-expiry from now.
function yearsToExpiry(expiryStr: string): number {
  const t = new Date(expiryStr + " 15:30:00 GMT+0530").getTime();
  const now = Date.now();
  return Math.max(1 / 365, (t - now) / (365 * 86_400_000));
}

function summarize(leg: any, kind: "CE" | "PE", underlying: number, strike: number, T: number): LegSummary | null {
  if (!leg) return null;
  const n = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const ivRaw = leg.impliedVolatility != null && leg.impliedVolatility !== 0 ? n(leg.impliedVolatility) : null;
  const sigma = ivRaw != null ? ivRaw / 100 : null;
  return {
    oi: n(leg.openInterest),
    oi_change: n(leg.changeinOpenInterest),
    volume: n(leg.totalTradedVolume),
    iv: ivRaw,
    ltp: n(leg.lastPrice),
    change: n(leg.change),
    bid: n(leg.bidprice),
    ask: n(leg.askPrice),
    greeks: sigma ? greeks(kind, underlying, strike, T, sigma) : null,
  };
}

async function nseJson(url: string): Promise<any | null> {
  const r = await nseFetch(url, {
    Accept: "application/json, text/plain, */*",
    Referer: "https://www.nseindia.com/option-chain",
  });
  if (!r || !r.ok) return null;
  return await r.json().catch(() => null);
}

// Returns { records, filtered } shaped payload regardless of endpoint used.
async function fetchNseOptionChain(symbol: string, expiry: string | null): Promise<any> {
  const isIndex = INDEX_SYMBOLS.has(symbol);
  const type = isIndex ? "Indices" : "Equity";
  const sym = encodeURIComponent(symbol);

  // 1) Legacy endpoint (returns every expiry in one payload) — still live for
  //    many symbols and gives us the full expiryDates list for free.
  const legacy = await nseJson(
    `https://www.nseindia.com/api/option-chain-${isIndex ? "indices" : "equities"}?symbol=${sym}`,
  );
  if (legacy?.records?.data?.length) return legacy;

  // 2) v3 requires an explicit expiry; discover the expiry list first.
  const info = await nseJson(`https://www.nseindia.com/api/option-chain-contract-info?symbol=${sym}`);
  const expiries: string[] = info?.expiryDates ?? info?.records?.expiryDates ?? [];
  const chosen = (expiry && expiries.includes(expiry) ? expiry : expiries[0]) ?? expiry;
  if (!chosen) throw new Error(`NSE option chain ${symbol}: no expiries available (NSE unreachable)`);

  const v3 = await nseJson(
    `https://www.nseindia.com/api/option-chain-v3?type=${type}&symbol=${sym}&expiry=${encodeURIComponent(chosen)}`,
  );
  const data = v3?.records?.data ?? v3?.data ?? null;
  if (!data?.length) throw new Error(`NSE option chain ${symbol}: unavailable`);

  return {
    records: {
      data,
      expiryDates: expiries.length ? expiries : [chosen],
      underlyingValue: v3?.records?.underlyingValue ?? v3?.underlyingValue ?? 0,
    },
  };
}



Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const rl = limiter.guard(req, auth.userId); if (rl) return rl;

  try {
    const b = await req.json().catch(() => ({}));
    const symbol = String(b?.symbol ?? "NIFTY").toUpperCase();
    const expiry = b?.expiry ? String(b.expiry) : null;

    const j = await fetchNseOptionChain(symbol);
    const records = j.records;
    const expiries: string[] = records.expiryDates ?? [];
    const chosenExpiry = expiry ?? expiries[0] ?? null;
    if (!chosenExpiry) return errorResponse(req, "no expiries available", 502);

    const underlying = Number(records.underlyingValue ?? 0);
    const T = yearsToExpiry(chosenExpiry);

    const strikes = new Map<number, Row>();
    for (const entry of records.data ?? []) {
      if (entry.expiryDate !== chosenExpiry) continue;
      const strike = Number(entry.strikePrice);
      if (!Number.isFinite(strike)) continue;
      const row = strikes.get(strike) ?? { strike, call: null, put: null };
      if (entry.CE) row.call = summarize(entry.CE, "CE", underlying, strike, T);
      if (entry.PE) row.put = summarize(entry.PE, "PE", underlying, strike, T);
      strikes.set(strike, row);
    }
    const rows: Row[] = [...strikes.values()].sort((a, b) => a.strike - b.strike);

    const totalCallOI = rows.reduce((s, r) => s + (r.call?.oi ?? 0), 0);
    const totalPutOI = rows.reduce((s, r) => s + (r.put?.oi ?? 0), 0);
    const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : null;

    try {
      const svc = svcClient();
      await svc.from("market_option_chain_snapshots").insert({
        user_id: auth.userId,
        symbol,
        // Explicit IST offset (same anchor as yearsToExpiry) — parsing
        // "25-Jul-2026" with implicit local-runtime-TZ (as this line
        // previously did) can shift the persisted date by one day
        // depending on the edge runtime's default timezone.
        expiry: new Date(chosenExpiry + " 15:30:00 GMT+0530").toISOString().slice(0, 10),
        underlying_price: underlying || null,
        payload: { rows, pcr, total_call_oi: totalCallOI, total_put_oi: totalPutOI },
      });
    } catch { /* ignore */ }

    return jsonResponse(req, {
      symbol,
      expiry: chosenExpiry,
      expiries,
      underlying,
      pcr,
      total_call_oi: totalCallOI,
      total_put_oi: totalPutOI,
      rows,
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
