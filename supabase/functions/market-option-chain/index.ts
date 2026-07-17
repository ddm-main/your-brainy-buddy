// market-option-chain — NSE public option chain (indices + equities).
// NSE requires session cookies; we prime them with a homepage fetch.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";

const HEADERS: HeadersInit = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.nseindia.com/option-chain",
};

const INDEX_SYMBOLS = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"]);

type Row = {
  strike: number;
  call: LegSummary | null;
  put: LegSummary | null;
};
type LegSummary = {
  oi: number; oi_change: number; volume: number;
  iv: number | null; ltp: number; change: number;
  bid: number; ask: number;
};

function summarize(leg: any): LegSummary | null {
  if (!leg) return null;
  const n = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    oi: n(leg.openInterest),
    oi_change: n(leg.changeinOpenInterest),
    volume: n(leg.totalTradedVolume),
    iv: leg.impliedVolatility != null && leg.impliedVolatility !== 0 ? n(leg.impliedVolatility) : null,
    ltp: n(leg.lastPrice),
    change: n(leg.change),
    bid: n(leg.bidprice),
    ask: n(leg.askPrice),
  };
}

async function fetchNseOptionChain(symbol: string): Promise<any> {
  const isIndex = INDEX_SYMBOLS.has(symbol);
  const endpoint = isIndex
    ? `https://www.nseindia.com/api/option-chain-indices?symbol=${encodeURIComponent(symbol)}`
    : `https://www.nseindia.com/api/option-chain-equities?symbol=${encodeURIComponent(symbol)}`;

  // Prime session cookies
  const home = await fetch("https://www.nseindia.com/option-chain", { headers: HEADERS });
  const cookies = home.headers.get("set-cookie") ?? "";
  const cookieHeader = cookies
    .split(/,(?=[^ ]+=)/)
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  const r = await fetch(endpoint, { headers: { ...HEADERS, cookie: cookieHeader } });
  if (!r.ok) throw new Error(`NSE option chain ${symbol}: HTTP ${r.status}`);
  const j = await r.json();
  if (!j?.records) throw new Error(`NSE option chain ${symbol}: no records`);
  return j;
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });

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

    const strikes = new Map<number, Row>();
    for (const entry of records.data ?? []) {
      if (entry.expiryDate !== chosenExpiry) continue;
      const strike = Number(entry.strikePrice);
      if (!Number.isFinite(strike)) continue;
      const row = strikes.get(strike) ?? { strike, call: null, put: null };
      if (entry.CE) row.call = summarize(entry.CE);
      if (entry.PE) row.put = summarize(entry.PE);
      strikes.set(strike, row);
    }
    const rows: Row[] = [...strikes.values()].sort((a, b) => a.strike - b.strike);

    // Aggregate PCR & max pain
    const totalCallOI = rows.reduce((s, r) => s + (r.call?.oi ?? 0), 0);
    const totalPutOI = rows.reduce((s, r) => s + (r.put?.oi ?? 0), 0);
    const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : null;

    // Persist snapshot (best-effort — non-fatal if it fails)
    try {
      const svc = svcClient();
      await svc.from("market_option_chain_snapshots").insert({
        user_id: auth.userId,
        symbol,
        expiry: chosenExpiry.split("-").reverse().join("-").length === 10
          ? new Date(chosenExpiry).toISOString().slice(0, 10)
          : new Date(chosenExpiry).toISOString().slice(0, 10),
        underlying_price: underlying || null,
        payload: { rows, pcr, total_call_oi: totalCallOI, total_put_oi: totalPutOI },
      });
    } catch {
      /* ignore */
    }

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
