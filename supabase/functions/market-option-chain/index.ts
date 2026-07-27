// Kotak Neo has no coverage for this data (fundamentals / news / reference / option-chain) — vendor-specific by design; do not re-route to getActiveProvider.
// market-option-chain — NSE public option chain (indices + equities).
// NSE requires session cookies; we prime them with a homepage fetch.
// P1.13: adds Black-Scholes Greeks (δ, γ, θ, ν) computed from NSE's IV,
// underlying, strike, expiry, and a fixed risk-free rate. Zero-dividend
// approximation (Indian equities' dividend yields are small; for index
// options this is standard practice on Kite/Streak too).
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";
import { nseFetch } from "../_shared/market/nseClient.ts";


// Scrapes nseindia.com per request (session-cookie priming + fetch) — a
// tighter ceiling than the batch-quote endpoints since runaway polling here
// risks NSE IP-blocking, not just wasted Kotak/Yahoo quota.
const limiter = createMarketLimiter(30, 60_000);

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
type OptionChainPayload = {
  symbol: string;
  expiry: string | null;
  expiries: string[];
  underlying: number;
  pcr: number | null;
  total_call_oi: number;
  total_put_oi: number;
  rows: Row[];
  cached?: boolean;
  captured_at?: string;
  warning?: string;
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
  if (!r || !r.ok) {
    console.warn("NSE option-chain upstream miss", { url, status: r?.status ?? 0 });
    return null;
  }
  return await r.json().catch(() => null);
}

function rowsFromPayload(payload: any): any[] {
  const candidates = [payload?.records?.data, payload?.filtered?.data, payload?.data];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}

function expiriesFromPayload(payload: any): string[] {
  const direct = payload?.records?.expiryDates ?? payload?.expiryDates;
  if (Array.isArray(direct)) return direct.filter((x) => typeof x === "string" && x.trim());
  const fromRows = rowsFromPayload(payload)
    .map((row) => row?.expiryDate ?? row?.CE?.expiryDate ?? row?.PE?.expiryDate)
    .filter((x): x is string => typeof x === "string" && x.trim());
  return [...new Set(fromRows)];
}

function strikeFromEntry(entry: any): number {
  return Number(entry?.strikePrice ?? entry?.CE?.strikePrice ?? entry?.PE?.strikePrice);
}

function expiryFromEntry(entry: any): string | null {
  const value = entry?.expiryDate ?? entry?.CE?.expiryDate ?? entry?.PE?.expiryDate;
  return typeof value === "string" && value.trim() ? value : null;
}

function underlyingFrom(records: any, entries: any[]): number {
  const values = [
    records?.underlyingValue,
    records?.filtered?.underlyingValue,
    ...entries.flatMap((entry) => [entry?.underlyingValue, entry?.CE?.underlyingValue, entry?.PE?.underlyingValue]),
  ];
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function expiryToIso(expiry: string | null): string | null {
  if (!expiry) return null;
  const d = new Date(expiry + " 15:30:00 GMT+0530");
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function latestCached(userId: string, symbol: string, expiry: string | null): Promise<OptionChainPayload | null> {
  try {
    let q = svcClient()
      .from("market_option_chain_snapshots")
      .select("expiry, underlying_price, payload, captured_at")
      .eq("user_id", userId)
      .eq("symbol", symbol)
      .order("captured_at", { ascending: false })
      .limit(1);
    const isoExpiry = expiryToIso(expiry);
    if (isoExpiry) q = q.eq("expiry", isoExpiry);
    const { data, error } = await q;
    if (error || !data?.length) return null;
    const row = data[0] as any;
    const payload = row.payload ?? {};
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (rows.length === 0) return null;
    return {
      symbol,
      expiry: payload.expiry ?? expiry ?? row.expiry ?? null,
      expiries: Array.isArray(payload.expiries) ? payload.expiries : [payload.expiry ?? expiry ?? row.expiry].filter(Boolean),
      underlying: Number(row.underlying_price ?? payload.underlying ?? 0),
      pcr: payload.pcr ?? null,
      total_call_oi: Number(payload.total_call_oi ?? 0),
      total_put_oi: Number(payload.total_put_oi ?? 0),
      rows,
      cached: true,
      captured_at: row.captured_at,
      warning: "NSE live option chain was unavailable; showing the latest cached chain.",
    };
  } catch {
    return null;
  }
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
  if (rowsFromPayload(legacy).length) return legacy;

  // 2) v3 requires an explicit expiry; discover the expiry list first.
  const info = await nseJson(`https://www.nseindia.com/api/option-chain-contract-info?symbol=${sym}`);
  const expiries: string[] = expiriesFromPayload(info);
  const chosen = (expiry && expiries.includes(expiry) ? expiry : expiries[0]) ?? expiry;
  if (!chosen) throw new Error(`NSE option chain ${symbol}: no expiries available (NSE unreachable)`);

  const v3 = await nseJson(
    `https://www.nseindia.com/api/option-chain-v3?type=${type}&symbol=${sym}&expiry=${encodeURIComponent(chosen)}`,
  );
  const data = rowsFromPayload(v3);
  if (!data.length) throw new Error(`NSE option chain ${symbol}: unavailable`);

  return {
    records: {
      data,
      expiryDates: expiries.length ? expiries : [chosen],
      underlyingValue: underlyingFrom(v3?.records ?? v3, data),
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
    const symbol = String(b?.symbol ?? "NIFTY").toUpperCase().trim();
    if (!/^[A-Z0-9&.-]{1,32}$/.test(symbol)) return errorResponse(req, "invalid symbol", 400);
    const expiry = b?.expiry ? String(b.expiry) : null;

    let j: any;
    try {
      j = await fetchNseOptionChain(symbol, expiry);
    } catch (e) {
      const cached = await latestCached(auth.userId, symbol, expiry);
      if (cached) return jsonResponse(req, cached);
      return jsonResponse(req, {
        symbol,
        expiry,
        expiries: expiry ? [expiry] : [],
        underlying: 0,
        pcr: null,
        total_call_oi: 0,
        total_put_oi: 0,
        rows: [],
        warning: e instanceof Error ? e.message : String(e),
      } satisfies OptionChainPayload);
    }
    const records = j.records;
    const entries = rowsFromPayload(j);
    const expiries: string[] = expiriesFromPayload(j);
    const chosenExpiry = (expiry && expiries.includes(expiry) ? expiry : expiries[0]) ?? expiry ?? null;

    if (!chosenExpiry) {
      const cached = await latestCached(auth.userId, symbol, expiry);
      if (cached) return jsonResponse(req, cached);
      return jsonResponse(req, {
        symbol,
        expiry: null,
        expiries: [],
        underlying: 0,
        pcr: null,
        total_call_oi: 0,
        total_put_oi: 0,
        rows: [],
        warning: "no expiries available from NSE",
      } satisfies OptionChainPayload);
    }

    const underlying = underlyingFrom(records, entries);
    const T = yearsToExpiry(chosenExpiry);

    const strikes = new Map<number, Row>();
    for (const entry of entries) {
      const entryExpiry = expiryFromEntry(entry);
      if (entryExpiry && entryExpiry !== chosenExpiry) continue;
      const strike = strikeFromEntry(entry);
      if (!Number.isFinite(strike)) continue;
      const row = strikes.get(strike) ?? { strike, call: null, put: null };
      if (entry.CE) row.call = summarize(entry.CE, "CE", underlying, strike, T);
      if (entry.PE) row.put = summarize(entry.PE, "PE", underlying, strike, T);
      strikes.set(strike, row);
    }
    const rows: Row[] = [...strikes.values()].sort((a, b) => a.strike - b.strike);

    if (rows.length === 0) {
      const cached = await latestCached(auth.userId, symbol, chosenExpiry);
      if (cached) return jsonResponse(req, cached);
      return jsonResponse(req, {
        symbol,
        expiry: chosenExpiry,
        expiries,
        underlying,
        pcr: null,
        total_call_oi: 0,
        total_put_oi: 0,
        rows: [],
        warning: "NSE returned no option rows for the selected expiry",
      } satisfies OptionChainPayload);
    }

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
        payload: { rows, pcr, total_call_oi: totalCallOI, total_put_oi: totalPutOI, expiry: chosenExpiry, expiries, underlying },
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
