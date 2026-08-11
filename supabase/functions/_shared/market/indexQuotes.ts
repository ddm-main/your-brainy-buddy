// Index quote resolution chain.
//
// Kotak Neo does not reliably answer index quotes (nse_indices|26000 & friends
// return no row on every quote-type/segment combination we try — see
// market_provider_health "missing index rows"). Blocking every other source
// for those symbols, which is what the code used to do, meant NIFTY /
// BANKNIFTY / VIX could NEVER show a price. This module resolves an index
// through an explicit, source-labelled chain instead:
//
//   1. Kotak            → live, broker feed          (resolved by the caller)
//   2. NSE allIndices   → live, exchange's own API   (undelayed, free)
//   3. Yahoo            → ~15 min delayed            (flagged delayed)
//   4. Last stored close → previous session          (flagged stale, with date)
//
// Every row carries the source that served it, so the UI can label rather
// than blank out. Never a number without its provenance.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { nseAllIndices } from "./nseClient.ts";
import { bseIndexQuotes } from "./bseClient.ts";
import { toYahooSymbol, yahooQuote } from "./yahooClient.ts";
import type { QuoteRow } from "./provider.ts";

export interface IndexRequest {
  key: string;      // "NSE:^NSEI" — as the caller asked for it
  exchange: string;
  symbol: string;
}

/** Canonical symbol → the name NSE's allIndices endpoint publishes. */
const NSE_INDEX_NAMES: Record<string, string> = {
  "^NSEI": "NIFTY 50",
  "^NSEBANK": "NIFTY BANK",
  "^INDIAVIX": "INDIA VIX",
  "FINNIFTY": "NIFTY FINANCIAL SERVICES",
  "NIFTY_MIDCAP_100.NS": "NIFTY MIDCAP 100",
  "^CNXSC": "NIFTY SMALLCAP 100",
  "NIFTY": "NIFTY 50",
  "BANKNIFTY": "NIFTY BANK",
};

/** Canonical symbol → the short alias BSE's index feed publishes. */
const BSE_INDEX_ALIASES: Record<string, string> = {
  "^BSESN": "SENSEX",
  "SENSEX": "SENSEX",
  "^BSE500": "BSE500",
  "^BSEMIDCAP": "MIDCAP",
  "^BSESMLCAP": "SMLCAP",
  "BSE100": "BSE100",
  "BSE200": "BSE200",
};

/** `^BSESN` and friends are BSE indices — NSE's feed cannot serve them. */
export function indexExchangeFor(symbol: string): string {
  return symbol.trim().toUpperCase() in BSE_INDEX_ALIASES ? "BSE" : "NSE";
}

export function isIndexSymbol(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  return s.startsWith("^")
    || s in NSE_INDEX_NAMES
    || s in BSE_INDEX_ALIASES
    || /^(NIFTY|BANKNIFTY|FINNIFTY|SENSEX|INDIA VIX)/.test(s);
}

const norm = (s: string): string => s.trim().toUpperCase().replace(/\s+/g, " ");

// ---------- 2. Exchange-native feeds (realtime) ----------

let nseCache: { at: number; byName: Map<string, { last: number | null; change: number | null; pct: number | null }> } | null = null;
// Realtime means realtime — the UI polls every second during the session, so a
// long server-side window would freeze "live" prices between refreshes.
const NSE_TTL_MS = 3_000;

async function nseIndexMap(): Promise<Map<string, { last: number | null; change: number | null; pct: number | null }>> {
  if (nseCache && Date.now() - nseCache.at < NSE_TTL_MS) return nseCache.byName;
  const rows = await nseAllIndices();
  const byName = new Map<string, { last: number | null; change: number | null; pct: number | null }>();
  for (const r of rows) {
    byName.set(norm(r.indexSymbol), { last: r.last, change: r.change, pct: r.changePct });
  }
  // Don't cache an empty read at all — NSE cookie warm-ups fail transiently
  // and the next poll should retry immediately.
  nseCache = { at: byName.size > 0 ? Date.now() : 0, byName };
  return byName;
}

async function fromNse(reqs: IndexRequest[]): Promise<QuoteRow[]> {
  const wanted = reqs.filter((p) => p.exchange.toUpperCase() === "NSE" && NSE_INDEX_NAMES[p.symbol.toUpperCase()]);
  if (wanted.length === 0) return [];
  let byName: Map<string, { last: number | null; change: number | null; pct: number | null }>;
  try { byName = await nseIndexMap(); } catch { return []; }
  const out: QuoteRow[] = [];
  for (const p of wanted) {
    const hit = byName.get(norm(NSE_INDEX_NAMES[p.symbol.toUpperCase()]));
    const price = hit?.last;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    const changeAbs = typeof hit?.change === "number" && Number.isFinite(hit.change) ? hit.change : null;
    out.push({
      key: p.key,
      price,
      previous_close: changeAbs != null ? price - changeAbs : null,
      change_abs: changeAbs,
      change_pct: typeof hit?.pct === "number" && Number.isFinite(hit.pct) ? hit.pct : null,
      volume: null,
      source: "nse",
      as_of: null,
    });
  }
  return out;
}

/**
 * BSE's own index feed — the only realtime source for Sensex, since NSE
 * doesn't carry it and the broker has no index quote route.
 */
async function fromBse(reqs: IndexRequest[]): Promise<QuoteRow[]> {
  const wanted = reqs.filter((p) => BSE_INDEX_ALIASES[p.symbol.toUpperCase()]);
  if (wanted.length === 0) return [];
  let rows: Awaited<ReturnType<typeof bseIndexQuotes>>;
  try { rows = await bseIndexQuotes(); } catch { return []; }
  if (rows.length === 0) return [];
  const byAlias = new Map(rows.map((r) => [norm(r.alias), r]));
  const out: QuoteRow[] = [];
  for (const p of wanted) {
    const hit = byAlias.get(norm(BSE_INDEX_ALIASES[p.symbol.toUpperCase()]));
    const price = hit?.last;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    const changeAbs = typeof hit?.change === "number" && Number.isFinite(hit.change) ? hit.change : null;
    out.push({
      key: p.key,
      price,
      // Prefer BSE's published previous close over deriving it, so the 1D
      // return matches the exchange's own number exactly.
      previous_close: hit?.previousClose ?? (changeAbs != null ? price - changeAbs : null),
      change_abs: changeAbs,
      change_pct: typeof hit?.changePct === "number" && Number.isFinite(hit.changePct) ? hit.changePct : null,
      volume: null,
      day_open: hit?.open ?? null,
      day_high: hit?.high ?? null,
      day_low: hit?.low ?? null,
      source: "bse",
      as_of: hit?.asOf ?? null,
    });
  }
  return out;
}


// ---------- 3. Yahoo ----------

async function fromYahoo(reqs: IndexRequest[]): Promise<QuoteRow[]> {
  if (reqs.length === 0) return [];
  try {
    const rows = await yahooQuote(reqs.map((p) => toYahooSymbol(p.symbol, p.exchange)));
    const byY = new Map(rows.map((r) => [r.symbol, r]));
    return reqs.flatMap((p) => {
      const r = byY.get(toYahooSymbol(p.symbol, p.exchange));
      if (!r || !Number.isFinite(r.price) || r.price <= 0) return [];
      return [{
        key: p.key,
        price: r.price,
        previous_close: r.prev_close ?? null,
        change_abs: r.change_abs,
        change_pct: r.change_pct,
        volume: r.volume ?? null,
        day_open: r.day_open ?? null,
        day_high: r.day_high ?? null,
        day_low: r.day_low ?? null,
        source: "yahoo" as const,
        as_of: r.as_of ?? null,
        previous_close_as_of: r.prev_close_as_of ?? null,
      }];
    });
  } catch {
    return [];
  }
}

// ---------- 4. Last stored close ----------

// EGRESS: this fallback fires whenever the live feed misses, which on a quiet
// day is most calls. Caching by the exact symbol SET meant a different mix of
// indices missed the cache every time — 1,106 reads/day (2.1 MB) of the same
// handful of settled closes. Cache PER SYMBOL instead, and for a full session:
// a settled close is immutable, so only symbols that are not yet cached are
// ever fetched (usually none).
type CloseBar = { date: string; close: number };
const closeCache = new Map<string, { bars: CloseBar[]; expiresAt: number }>();
const CLOSE_TTL_MS = 6 * 3_600_000;

async function fromStoredClose(svc: SupabaseClient, reqs: IndexRequest[]): Promise<QuoteRow[]> {
  if (reqs.length === 0) return [];
  const symbols = [...new Set(reqs.map((p) => p.symbol))].sort();
  const now = Date.now();
  const bySym = new Map<string, CloseBar[]>();
  const missing: string[] = [];
  for (const s of symbols) {
    const hit = closeCache.get(s);
    if (hit && hit.expiresAt > now) bySym.set(s, hit.bars);
    else missing.push(s);
  }

  if (missing.length > 0) {
    const res = await svc
      .from("market_daily_prices")
      .select("symbol,trade_date,close,close_adjusted")
      .in("symbol", missing)
      .order("trade_date", { ascending: false })
      .limit(missing.length * 6);
    if (!res.error && res.data) {
      const fetched = new Map<string, CloseBar[]>();
      for (const r of res.data as any[]) {
        const close = Number(r.close_adjusted ?? r.close);
        if (!Number.isFinite(close) || close <= 0) continue;
        const arr = fetched.get(String(r.symbol)) ?? [];
        if (arr.length < 2) arr.push({ date: String(r.trade_date), close });
        fetched.set(String(r.symbol), arr);
      }
      for (const s of missing) {
        const bars = fetched.get(s) ?? [];
        closeCache.set(s, { bars, expiresAt: now + CLOSE_TTL_MS });
        bySym.set(s, bars);
      }
    }
  }

  return reqs.flatMap((p) => {
    const arr = bySym.get(p.symbol);
    if (!arr || arr.length === 0) return [];
    const [latest, prev] = arr;
    return [{
      key: p.key,
      price: latest.close,
      previous_close: prev?.close ?? null,
      change_abs: prev ? latest.close - prev.close : null,
      change_pct: prev ? ((latest.close - prev.close) / prev.close) * 100 : null,
      volume: null,
      source: "cache" as const,
      as_of: latest.date,
    }];
  });
}

export interface ResolvedIndexQuote extends QuoteRow {
  /** true when the value is not a live tick (yahoo delayed / stored close). */
  delayed: boolean;
}

/**
 * Resolve index quotes through the full chain. `kotakRows` are whatever the
 * broker already produced (may be empty); everything still missing is filled
 * from the index's own exchange (NSE for NSE indices, BSE for Sensex & co.),
 * then Yahoo, then the last stored close.
 */
export async function resolveIndexQuotes(
  svc: SupabaseClient,
  reqs: IndexRequest[],
  kotakRows: QuoteRow[] = [],
): Promise<ResolvedIndexQuote[]> {
  const out = new Map<string, QuoteRow>();
  for (const r of kotakRows) {
    if (Number.isFinite(r.price) && r.price > 0) out.set(r.key, r);
  }
  const missing = () => reqs.filter((p) => !out.has(p.key));

  // NSE and BSE serve disjoint sets of indices, so run them together — one
  // round trip each, no ordering dependency between them.
  const exchangeNative = async (m: IndexRequest[]): Promise<QuoteRow[]> => {
    const [nse, bse] = await Promise.all([
      fromNse(m).catch(() => [] as QuoteRow[]),
      fromBse(m).catch(() => [] as QuoteRow[]),
    ]);
    return [...nse, ...bse];
  };

  const chain = [
    exchangeNative,
    (m: IndexRequest[]) => fromYahoo(m),
    (m: IndexRequest[]) => fromStoredClose(svc, m),
  ];

  for (const step of chain) {
    const pending = missing();
    if (pending.length === 0) break;
    let rows: QuoteRow[] = [];
    try { rows = await step(pending); } catch { rows = []; }
    for (const r of rows) if (!out.has(r.key)) out.set(r.key, r);
  }

  return [...out.values()].map((r) => ({
    ...r,
    // kotak / nse / bse are live exchange prints; yahoo is ~15 min behind and
    // cache is a previous session's close.
    delayed: r.source === "yahoo" || r.source === "cache",
  }));
}

