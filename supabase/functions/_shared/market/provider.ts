// Provider abstraction — the rest of the backend talks to this interface,
// never to a broker API directly. Active provider comes from market_api_settings.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { encryptStatementPassword } from "../crypto.ts";
import { withPgRetry } from "./paginate.ts";

import {
  KOTAK_SETTINGS_COLS,
  KOTAK_LEAN_COLS,
  hydrateKotakCredentials,

  type KotakSettings,
  kotakCancelOrder,
  kotakConvertPosition,
  kotakDepth,
  kotakHoldings,
  kotakHoldingsEnvelope,
  kotakLimits,
  classifyFundsError,
  kotakModifyOrder,
  kotakPlaceOrder,
  kotakPositions,
  kotakPositionsEnvelope,
  kotakQuotes,
  parseKotakLimits,
  type KotakFundsSnapshot,
  withKotakSession,
} from "./kotakClient.ts";
import { isRouteOpen } from "./routeBreaker.ts";
import {
  chainFor, getFeedRoute, orderChain, toProviderName,
  type FeedRoute, type RouteProvider,
} from "./feedRoute.ts";

import { toYahooSymbol, yahooChartRetry, yahooQuote } from "./yahooClient.ts";
import { isIndexSymbol, resolveIndexQuotes } from "./indexQuotes.ts";
import type { Candle } from "./indicators.ts";

// Symbols already reported as missing a Kotak instrument token, per isolate.
const loggedTokenGap = new Set<string>();

/** Why a depth ladder came back empty. `ok` means the book is real. */
export type DepthReasonCode =
  | "ok"
  | "no_token"
  | "not_connected"
  | "market_closed"
  | "upstream_error"
  | "unsupported";

export type DepthLadder = {
  bids: Array<{ price: number; qty: number; orders: number }>;
  asks: Array<{ price: number; qty: number; orders: number }>;
  ltp: number | null;
  source: "kotak" | "yahoo" | "unavailable";
  reason_code?: DepthReasonCode;
  reason?: string;
};

// NSE/BSE cash session in IST, Mon-Fri. Used only to explain an empty book —
// never to suppress a fetch.
export function isIndianMarketOpen(now = new Date()): boolean {
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60_000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}


export interface QuoteRow {
  key: string; // "NSE:SYMBOL" as requested by the caller
  price: number;
  previous_close: number | null;
  change_abs: number | null;
  change_pct: number | null;
  volume: number | null;
  day_open?: number | null;
  day_high?: number | null;
  day_low?: number | null;
  source: "kotak" | "nse" | "bse" | "yahoo" | "cache";
  as_of?: string | null;
  previous_close_as_of?: string | null;
  high_52w?: number | null;
  low_52w?: number | null;
  /** Why a live-only symbol was not priced, when applicable. */
  reason?: string | null;
  /** True when the UI must not substitute a delayed public quote. */
  live_required?: boolean;
  /** True when a delayed fallback existed or could exist but was intentionally blocked. */
  delayed_blocked?: boolean;
}

export interface HoldingRow {
  symbol: string;
  exchange: string;
  quantity: number;      // effective total = settled + t1 + pledged
  avg_price: number;
  settled_qty?: number | null;
  t1_qty?: number | null;
  pledged_qty?: number | null;
  buy_date?: string | null; // ISO date (YYYY-MM-DD) — earliest known lot
}

export interface PositionRow {
  symbol: string;
  exchange: string;
  side: "long" | "short";
  quantity: number;
  entry_price: number;
  product: "MIS" | "CNC" | "NRML" | null;
}

// Fully-closed intraday trade — buyQty == sellQty, net = 0. Kept for realized
// P&L reporting even though it doesn't survive as an open position.
export interface RealizedTradeRow {
  symbol: string;
  exchange: string;
  quantity: number;
  realized: number;
}

export interface PlaceOrderInput {
  symbol: string;
  exchange: string;
  side: "BUY" | "SELL";
  quantity: number;
  orderType: "MARKET" | "LIMIT" | "SL" | "SL-M";
  product: "MIS" | "CNC" | "NRML";
  price?: number;
  triggerPrice?: number;
  validity?: "DAY" | "IOC";
  disclosedQuantity?: number;
  amo?: boolean;
}
export interface PlaceOrderResult { orderId: string; status: string }

export interface FundsSnapshot {
  net_cash: number | null;
  available_margin: number | null;
  used_margin: number | null;
  collateral: number | null;
  payin_amount: number | null;
  // Extended richer breakdown — nullable, backward compatible with the
  // existing market_funds columns (surfaced via payload.extended).
  cash_balance?: number | null;
  payout_amount?: number | null;
  span_margin?: number | null;
  exposure_margin?: number | null;
  realized_mtm?: number | null;
  unrealized_mtm?: number | null;
  source: "kotak" | "unavailable";
  raw?: unknown;
}

export interface HoldingsResult {
  rows: HoldingRow[];
  // True when the broker responded with a well-formed OK payload — even if
  // it happened to be empty (a genuine empty book). Sync uses this to
  // distinguish "user sold everything" from "upstream returned garbage".
  complete: boolean;
}

export interface PositionsResult {
  rows: PositionRow[];
  realized: RealizedTradeRow[];
  complete: boolean;
}

// `meta` is an out-param the provider fills with the upstream that ACTUALLY
// served the bars. The Kotak provider legitimately falls back to Yahoo for
// coverage gaps (no scrip token), and `provider.name` alone mislabelled those
// delayed bars as "kotak · live" on the chart.
export interface OhlcvMeta {
  source?: "kotak_neo" | "yahoo";
  /** Why Kotak could not serve: broker_503, no_token, empty, session, other. */
  reason?: string;
}

export interface MarketProvider {
  name: string;
  getQuotes(keys: string[], opts?: { allowFallback?: boolean }): Promise<QuoteRow[]>;
  getOHLCV(symbol: string, exchange: string, range: string, interval: string, meta?: OhlcvMeta): Promise<Candle[]>;
  getDepth(symbol: string, exchange: string): Promise<DepthLadder>;
  getHoldings(): Promise<HoldingRow[]>;
  getHoldingsDetailed?(): Promise<HoldingsResult>;
  getPositions(): Promise<PositionRow[]>;
  getPositionsDetailed?(): Promise<PositionsResult>;
  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
  modifyOrder(orderId: string, changes: Partial<Pick<PlaceOrderInput, "quantity" | "price" | "orderType" | "triggerPrice" | "validity">>): Promise<PlaceOrderResult>;
  cancelOrder(orderId: string): Promise<PlaceOrderResult>;
  convertPosition(input: { symbol: string; exchange: string; side: "BUY" | "SELL"; quantity: number; fromProduct: "MIS" | "CNC" | "NRML"; toProduct: "MIS" | "CNC" | "NRML" }): Promise<{ ok: true }>;
  getFunds(): Promise<FundsSnapshot>;
  testAuth(): Promise<{ ok: boolean; detail?: string }>;
}

export const encryptValue = async (v: string): Promise<string> =>
  JSON.stringify(await encryptStatementPassword(v));

function parseKey(key: string): { exchange: string; symbol: string } {
  const [exchange, symbol] = key.includes(":") ? key.split(":") : ["NSE", key];
  return { exchange, symbol };
}

// ---------- Short-TTL in-memory caches (per warm Deno isolate) ----------
// `getQuotes` used to re-read the full market_api_settings row and
// re-resolve the market_stocks token map from Postgres on every single call,
// serially, before ever reaching Kotak — real latency on the hot 1s-poll
// path. Neither value is correctness-critical to cache for a few seconds:
// connection status / instrument tokens don't change tick to tick.

type SettingsRow = KotakSettings & { active_provider: string };

// Union of every provider's column set — one read serves whichever provider
// the row turns out to be, instead of a second round-trip per provider.
//
// EGRESS: this used to be the FULL column set, ciphertext blobs included
// (~3.7 KB per read, ~475 reads/day across the sweep, quotes, indices, orders
// and the autotrade cron). Routing only needs to know which provider is
// active and whether its session is live; the auto-login secrets are
// hydrated by hydrateKotakCredentials() on the rare re-login path.
const ALL_SETTINGS_COLS = Array.from(new Set(
  (KOTAK_LEAN_COLS + ",active_provider").split(","),
)).join(",");
const settingsCache = new Map<string, { rows: SettingsRow[]; expiresAt: number }>();
const SETTINGS_TTL_MS = 10 * 60_000; // EGRESS: settings change by hand, not by the minute.

async function getSettingsRows(svc: SupabaseClient, userId: string, useCache = true): Promise<SettingsRow[]> {
  const cached = useCache ? settingsCache.get(userId) : null;
  if (cached && cached.expiresAt > Date.now()) return cached.rows;
  const { data } = await svc
    .from("market_api_settings")
    .select(ALL_SETTINGS_COLS + ",purpose")
    .eq("user_id", userId)
    // Account-bound reads only ever use the caller's own trading connection;
    // a data-feed row belongs to the market-data plane, never to a user.
    .eq("purpose", "account");

  const rows = (data ?? []) as unknown as SettingsRow[];
  settingsCache.set(userId, { rows, expiresAt: Date.now() + SETTINGS_TTL_MS });
  return rows;
}


async function getFreshSettingsRow(
  svc: SupabaseClient,
  settingsId: string,
): Promise<KotakSettings> {
  const { data, error } = await svc
    .from("market_api_settings")
    .select(KOTAK_SETTINGS_COLS)
    .eq("id", settingsId)
    .single();
  if (error || !data) {
    throw new Error(`Could not reload the current Kotak session: ${error?.message ?? "settings missing"}`);
  }
  return data as KotakSettings;
}

// Per-symbol token cache. The old implementation paged the WHOLE tokened
// universe (~2.7k rows, ~280 KB) with a 60 s TTL; because edge isolates recycle
// constantly that read fired on nearly every quote/candle call — 209 MB of
// PostgREST egress in a single day, i.e. the entire monthly free-plan cap on its
// own. We now resolve only the symbols a request actually asks for and cache
// each entry for 30 minutes (market_stocks only changes on the scrip sync).
const tokenCache = new Map<string, { entry: TokenEntry | null; expiresAt: number }>();
const TOKEN_TTL_MS = 12 * 3_600_000; // EGRESS: instrument tokens are stable for the trading day.
const TOKEN_MISS_TTL_MS = 5 * 60_000;


// "EXCHANGE:SYMBOL" -> instrument token, cached whole (market_stocks is a
// shared reference table that only changes via the weekly scrip sync).
// Keyed by exchange since the same symbol can carry different tokens on NSE
// vs BSE.
type TokenEntry = { token: string; segment: string };

const keyFor = (exchange: string, symbol: string): string => `${exchange.toUpperCase()}:${symbol.trim().toUpperCase()}`;

const INDEX_ALIASES: Record<string, string[]> = {
  "NSE:^NSEI": ["NIFTY", "NIFTY 50", "Nifty 50", "^NSEI"],
  "NSE:^NSEBANK": ["BANKNIFTY", "NIFTY BANK", "Nifty Bank", "BANK NIFTY", "^NSEBANK"],
  "NSE:FINNIFTY": ["FINNIFTY", "NIFTY FIN SERVICE", "Nifty Fin Service", "NIFTY FINANCIAL SERVICES"],
  "NSE:^INDIAVIX": ["INDIA VIX", "INDIAVIX", "^INDIAVIX"],
  "NSE:NIFTY_MIDCAP_100.NS": ["NIFTY MIDCAP 100", "MIDCAP 100"],
  "BSE:^BSESN": ["SENSEX", "BSE SENSEX", "^BSESN"],
};

/** NSE index instrument tokens (Kotak's nse_indices segment reuses them). */
const KNOWN_INDEX_TOKENS: Record<string, string> = {
  "NSE:^NSEI": "26000",
  "NSE:^NSEBANK": "26009",
  "NSE:FINNIFTY": "26037",
  "NSE:^INDIAVIX": "26017",
};

export const LIVE_ONLY_NSE_INDEX_SYMBOLS = new Set(["^NSEI", "^NSEBANK", "^INDIAVIX"]);

export function isLiveOnlyNseIndex(symbol: string, exchange = "NSE"): boolean {
  return exchange.toUpperCase() === "NSE" && LIVE_ONLY_NSE_INDEX_SYMBOLS.has(symbol.toUpperCase());
}



function entryFromRow(r: any): TokenEntry {
  const isIdx = String(r.instrument_type ?? "").toUpperCase() === "INDEX"
    || String(r.symbol ?? "").startsWith("^");
  const defaultSeg = isIdx
    ? (r.exchange === "BSE" ? "bse_indices" : "nse_indices")
    : (r.exchange === "BSE" ? "bse_cm" : "nse_cm");
  return { token: String(r.token), segment: r.kotak_segment || defaultSeg };
}

/** Every scrip-master name an index may be listed under, including the canonical one. */
function aliasMembers(exchange: string, symbol: string): string[] {
  const canonical = keyFor(exchange, symbol);
  for (const [key, aliases] of Object.entries(INDEX_ALIASES)) {
    const [ex, sym] = key.split(":") as [string, string];
    const members = [sym, ...aliases];
    if (key === canonical || members.some((m) => keyFor(ex, m) === canonical)) {
      return members;
    }
  }
  return [symbol];
}

/**
 * Resolve instrument tokens for the requested symbols only.
 * Returns a map keyed the same way the old whole-book map was, so callers are
 * unchanged — but a quote batch of 50 symbols now costs a few KB instead of the
 * full ~280 KB book, and repeat calls inside 30 minutes cost nothing.
 */
async function getTokenMap(
  svc: SupabaseClient,
  reqs: Array<{ exchange: string; symbol: string }>,
): Promise<Map<string, TokenEntry>> {
  const map = new Map<string, TokenEntry>();
  const now = Date.now();

  // Expand each request to its alias group and drop what the cache already knows.
  const wanted = new Map<string, { exchange: string; members: string[] }>();
  for (const r of reqs) {
    const exchange = String(r.exchange || "NSE").toUpperCase();
    const key = keyFor(exchange, r.symbol);
    if (map.has(key)) continue;
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt > now) {
      if (cached.entry) map.set(key, cached.entry);
      continue;
    }
    wanted.set(key, { exchange, members: aliasMembers(exchange, String(r.symbol)) });
  }
  if (wanted.size === 0) return map;

  // One read per chunk of names, columns projected — no paging of the universe.
  const names = Array.from(new Set(Array.from(wanted.values()).flatMap((w) => w.members)));
  const rows: any[] = [];
  const CHUNK = 200;
  let failed = false;
  for (let i = 0; i < names.length; i += CHUNK) {
    const { data, error } = await withPgRetry<any>(() => Promise.resolve(svc
      .from("market_stocks").select("symbol,exchange,token,kotak_segment,instrument_type")
      .in("exchange", ["NSE", "BSE"]).not("token", "is", null)
      .in("symbol", names.slice(i, i + CHUNK)) as any));
    if (error) { console.error("[market] token lookup failed:", error.message); failed = true; break; }
    rows.push(...(data ?? []));
  }

  const byKey = new Map<string, TokenEntry>();
  for (const r of rows) byKey.set(keyFor(String(r.exchange), String(r.symbol)), entryFromRow(r));

  for (const [key, w] of wanted) {
    // Group-wise index resolution: the master may carry the instrument under any
    // alias ("NIFTY 50", "NIFTY", "^NSEI"), so take whichever member exists.
    let entry = w.members.map((m) => byKey.get(keyFor(w.exchange, m))).find(Boolean) ?? null;
    if (!entry) {
      const known = KNOWN_INDEX_TOKENS[keyFor(w.exchange, w.members[0])];
      if (known) entry = { token: known, segment: w.exchange === "BSE" ? "bse_indices" : "nse_indices" };
    }
    if (entry) map.set(key, entry);
    // A failed read must not be cached as a miss — one blip would demote the
    // symbol to Yahoo for the whole TTL.
    if (!failed || entry) {
      tokenCache.set(key, { entry, expiresAt: Date.now() + (entry ? TOKEN_TTL_MS : TOKEN_MISS_TTL_MS) });
    }
  }

  return map;
}


// Aggregate N consecutive base bars into one — used server-side when a UI TF
// (2h/4h/3m) isn't a Kotak-native interval. Preserves OHLC semantics and
// sums volume, so the resulting series is safe for indicators and volume pane.
function resampleCandles(rows: Candle[], factor: number): Candle[] {
  if (factor <= 1 || rows.length === 0) return rows;
  const out: Candle[] = [];
  for (let i = 0; i < rows.length; i += factor) {
    const bucket = rows.slice(i, i + factor);
    if (bucket.length === 0) continue;
    out.push({
      time: bucket[0].time,
      open: bucket[0].open,
      high: bucket.reduce((m, b) => Math.max(m, b.high), -Infinity),
      low: bucket.reduce((m, b) => Math.min(m, b.low), Infinity),
      close: bucket[bucket.length - 1].close,
      volume: bucket.reduce((s, b) => s + (b.volume ?? 0), 0),
    });
  }
  return out;
}

function rangeSeconds(range: string): number {
  const YEAR = 365 * 86400;
  const dayMatch = range.match(/^(\d+)d$/);
  if (dayMatch) return Number(dayMatch[1]) * 86400;
  // Yahoo-style month ranges ("1mo","3mo","6mo") — without this a 3mo request
  // silently fell through to the 2-year default.
  const monthMatch = range.match(/^(\d+)mo$/);
  if (monthMatch) return Number(monthMatch[1]) * 30 * 86400;
  const yearMatch = range.match(/^(\d+)y$/);
  if (yearMatch) return Number(yearMatch[1]) * YEAR;

  const direct: Record<string, number> = {
    "1d": 86400, "5d": 5 * 86400, "7d": 7 * 86400, "30d": 30 * 86400, "60d": 60 * 86400,
    "1y": YEAR, "2y": 2 * YEAR, "5y": 5 * YEAR, "10y": 10 * YEAR, "max": 40 * YEAR,
  };
  return direct[range] ?? 2 * YEAR;
}

function yahooRangeFor(interval: string, requestedRange: string): string {
  const maxByInterval: Record<string, string> = {
    "1m": "7d", "2m": "60d", "5m": "60d", "15m": "60d", "30m": "60d",
    "60m": "730d", "90m": "60d", "1h": "730d",
  };
  const cap = maxByInterval[interval];
  if (!cap) return requestedRange;
  return rangeSeconds(requestedRange) > rangeSeconds(cap) ? cap : requestedRange;
}

// ---------- Provider health logging ----------
// Lightweight — one row per getQuotes call for whichever provider actually
// served it, not every internal call. Never let a logging failure affect
// the actual data path: fire-and-forget, errors swallowed.
//
// Disk budget: this table used to grow ~23k rows/day (~7 MB/day) on a 500 MB
// free-tier database.
//
// Sampling must be SYMMETRIC. Keeping 100% of failures while sampling 5% of
// successes made the stored rows a 20x-magnified picture of failure, and the
// Providers page computes its "24h success rate" straight off those rows — so
// a healthy provider read as broken. Same rate both ways: the ratio in the
// table is now the real ratio, and a repeated failure still lands within a few
// polls. Repeat suppression keeps an identical error from being written more
// than once a minute per provider+endpoint.
const HEALTH_SAMPLE = 0.05;
const REPEAT_ERROR_WINDOW_MS = 60_000;
const lastLoggedError = new Map<string, { msg: string; at: number }>();

function logProviderHealth(
  svc: SupabaseClient,
  provider: string,
  endpoint: string,
  ok: boolean,
  latencyMs: number,
  error?: string,
): void {
  if (!ok) {
    const k = `${provider}:${endpoint}`;
    const msg = (error ?? "").slice(0, 200);
    const prev = lastLoggedError.get(k);
    if (prev && prev.msg === msg && Date.now() - prev.at < REPEAT_ERROR_WINDOW_MS) return;
    lastLoggedError.set(k, { msg, at: Date.now() });
  } else if (Math.random() > HEALTH_SAMPLE) return;
  svc.from("market_provider_health").insert({
    provider, endpoint, ok, latency_ms: Math.round(latencyMs),
    error: error ? error.slice(0, 500) : null,
  }).then(() => {}, () => {});
}


// ---------- Yahoo provider ----------

function yahooProvider(svc: SupabaseClient): MarketProvider {
  return {
    name: "yahoo",
    async getQuotes(keys, opts) {
      const allowFallback = opts?.allowFallback !== false;
      const t0 = Date.now();
      try {
        const ySyms = keys.map((k) => {
          const { exchange, symbol } = parseKey(k);
          return toYahooSymbol(symbol, exchange);
        });
        const rows = await yahooQuote(ySyms);
        logProviderHealth(svc, "yahoo", "getQuotes", true, Date.now() - t0);
        const byY = new Map(rows.map((r) => [r.symbol, r]));
        return keys.flatMap((k) => {
          const { exchange, symbol } = parseKey(k);
          const r = byY.get(toYahooSymbol(symbol, exchange));
          if (!r) return [];
          return [{
            key: k,
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
      } catch (e) {
        logProviderHealth(svc, "yahoo", "getQuotes", false, Date.now() - t0, e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    async getOHLCV(symbol, exchange, range, interval, meta) {
      if (meta) meta.source = "yahoo";
      // Yahoo accepts 1m/2m/5m/15m/30m/60m/90m/1h/1d/5d/1wk/1mo/3mo only.
      // 3m -> resample from 1m, 2h/4h -> resample from 60m. 1h passes as 60m.
      const yInterval = interval === "3m" ? "1m"
        : interval === "2h" || interval === "4h" ? "60m"
        : interval === "1h" ? "60m"
        : interval;
      const factor = interval === "3m" ? 3 : interval === "2h" ? 2 : interval === "4h" ? 4 : 1;
      const safeRange = yahooRangeFor(yInterval, range);
      const raw = await yahooChartRetry(toYahooSymbol(symbol, exchange), safeRange, yInterval);
      return factor > 1 ? resampleCandles(raw, factor) : raw;
    },
    async getDepth(): Promise<DepthLadder> {
      // Yahoo has no order book — say so instead of implying a broker problem.
      return {
        bids: [], asks: [], ltp: null, source: "yahoo",
        reason_code: "unsupported",
        reason: "The delayed price feed does not carry an order book.",
      };
    },

    getHoldings() {
      return Promise.reject(new Error("Holdings sync requires a broker provider (Kotak Neo)."));
    },
    getPositions() {
      return Promise.reject(new Error("Positions sync requires a broker provider (Kotak Neo)."));
    },
    placeOrder() {
      return Promise.reject(new Error("Order placement requires a broker provider (Kotak Neo)."));
    },
    modifyOrder() {
      return Promise.reject(new Error("Order modification requires a broker provider (Kotak Neo)."));
    },
    cancelOrder() {
      return Promise.reject(new Error("Order cancellation requires a broker provider (Kotak Neo)."));
    },
    convertPosition() {
      return Promise.reject(new Error("Position conversion requires a broker provider (Kotak Neo)."));
    },
    async getFunds(): Promise<FundsSnapshot> {
      return { net_cash: null, available_margin: null, used_margin: null, collateral: null, payin_amount: null, source: "unavailable" };
    },
    async testAuth() {
      const rows = await yahooQuote(["^NSEI"]);
      return { ok: rows.length > 0, detail: rows.length ? "Yahoo reachable" : "Yahoo unreachable" };
    },
  };
}

// ---------- Kotak provider ----------

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const firstNum = (obj: any, paths: string[]): number | null => {
  for (const path of paths) {
    const value = path.split(".").reduce((acc, key) => acc?.[key], obj);
    const n = num(value);
    if (n > 0) return n;
  }
  return null;
};

const finiteNum = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

const firstFiniteNum = (obj: any, paths: string[]): number | null => {
  for (const path of paths) {
    const value = path.split(".").reduce((acc, key) => acc?.[key], obj);
    const n = finiteNum(value);
    if (n != null) return n;
  }
  return null;
};

const parseKotakDate = (obj: any): string | null => {
  const raw = obj?.last_traded_time ?? obj?.lastTradeTime ?? obj?.ltt ?? obj?.tradeTime ?? obj?.lstup_time ?? obj?.time;

  if (!raw) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  const d = Number.isFinite(n)
    ? new Date(n > 9_999_999_999 ? n : n * 1000)
    : new Date(String(raw).replace(/(\d{2})-(\d{2})-(\d{4})/, "$3-$2-$1"));
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
};

type ParsedQuoteRequest = { key: string; exchange: string; symbol: string };


function kotakQuoteMaps(raw: any[]): { byNeoSymbol: Map<string, any>; byTokenOnly: Map<string, any> } {
  const byNeoSymbol = new Map<string, any>();
  const byTokenOnly = new Map<string, any>();
  for (const r of raw) {
    const rawNeoSymbol = String(
      r?.symbol ?? r?.neoSymbol ?? r?.neosymbol ?? r?.pSymbolName ?? "",
    ).trim();
    const rawToken = String(
      r?.tk ?? r?.token ?? r?.instrumentToken ?? r?.instrument_token
      ?? r?.exchange_token ?? r?.exchangeToken ?? r?.pSymbol ?? "",
    ).trim();
    const rawSeg = String(r?.exchange ?? r?.exchangeSegment ?? r?.exchange_segment ?? "").trim().toLowerCase();
    const segTok = rawNeoSymbol.match(/^([a-z]+_[a-z]+)\|(.+)$/i);
    if (segTok) {
      const normalized = `${segTok[1].toLowerCase()}|${segTok[2]}`;
      byNeoSymbol.set(normalized, r);
      byTokenOnly.set(String(segTok[2]), r);
    } else if (rawNeoSymbol) {
      byTokenOnly.set(rawNeoSymbol.includes("|") ? String(rawNeoSymbol.split("|").pop()) : rawNeoSymbol, r);
    }
    const tokenOnly = rawToken.includes("|") ? rawToken.split("|").pop() : rawToken;
    if (tokenOnly) {
      byTokenOnly.set(String(tokenOnly), r);
      if (rawSeg) byNeoSymbol.set(`${rawSeg}|${tokenOnly}`, r);
    }
  }
  return { byNeoSymbol, byTokenOnly };
}



function quoteRowFromKotak(p: ParsedQuoteRequest, r: any): QuoteRow | null {
  if (!r) return null;
  const price = firstNum(r, [
    "last_traded_price", "ltp", "lastPrice", "last_price", "lp",
    "index_value", "indexValue", "index", "value", "iv",
  ]);
  const prevClose = firstNum(r, [
    "previous_close", "prev_close", "previousClose", "prevClose",
    "previous_close_price", "previousClosePrice", "prv_close", "prev_close_price",
    "ohlc.close", "ohlc.c", "closing_price", "close", "c",
  ]);
  if (!price) return null;
  const changeAbs = prevClose ? price - prevClose : firstFiniteNum(r, ["change", "net_change", "day_change", "chg", "cng"]);
  const directChangePct = firstFiniteNum(r, ["per_change", "change_pct", "percent_change", "changePercent", "nc"]);
  return {
    key: p.key,
    price,
    previous_close: prevClose,
    change_abs: changeAbs,
    change_pct: prevClose ? ((price - prevClose) / prevClose) * 100 : directChangePct,
    // Only cumulative-session fields belong here. `last_volume` is last-trade
    // quantity on some Neo payloads; treating it as day volume made the 30-day
    // comparison change meaning between symbols.
    volume: firstNum(r, [
      "volume", "vol_traded_today", "totalTradedVolume", "total_traded_volume",
      "total_volume", "totTrdQty", "tot_trd_qty", "vtt", "v",
    ]),
    day_open: firstNum(r, ["open_price", "ohlc.open", "ohlc.o", "opn_pric", "open", "o"]),
    day_high: firstNum(r, ["high_price", "ohlc.high", "ohlc.h", "hgh_pric", "high", "h"]),
    day_low: firstNum(r, ["low_price", "ohlc.low", "ohlc.l", "lw_pric", "low", "l"]),
    source: "kotak",
    as_of: parseKotakDate(r),
    previous_close_as_of: null,
    high_52w: firstNum(r, ["hgh_52w_val", "high_52w", "52wkHigh", "yearHigh", "year_high"]),
    low_52w: firstNum(r, ["lw_52w_val", "low_52w", "52wkLow", "yearLow", "year_low"]),
  };
}

// resolveKotakIndexQuote() lived here. Removed: Kotak Neo answers no index
// quote on any segment/quote-type combination, so the retry matrix was pure
// latency and pure noise in market_provider_health. Indices are resolved by
// resolveIndexQuotes() (NSE/BSE native → Yahoo → stored close) before the
// broker is consulted at all.


// In-isolate circuit breaker for Kotak getQuotes. After N consecutive batch
// failures, skip Kotak briefly and serve Yahoo per-symbol instead of hammering
// a failing endpoint every 1s poll. Auto-resets after the cooldown.
let kotakFailStreak = 0;
let kotakBreakerOpenUntil = 0;
const KOTAK_FAIL_THRESHOLD = 3;
const KOTAK_BREAKER_COOLDOWN_MS = 5_000;
function kotakBreakerOpen(): boolean { return Date.now() < kotakBreakerOpenUntil; }
function kotakBreakerRecordSuccess(): void { kotakFailStreak = 0; kotakBreakerOpenUntil = 0; }
function kotakBreakerRecordFailure(): void {
  kotakFailStreak += 1;
  if (kotakFailStreak >= KOTAK_FAIL_THRESHOLD) kotakBreakerOpenUntil = Date.now() + KOTAK_BREAKER_COOLDOWN_MS;
}

// NSE regular session (IST 09:15–15:30, Mon–Fri). During this window Kotak
// Neo is the ONLY permitted source for live prices, candles and depth: Yahoo
// is ~15 min delayed, so quietly substituting it turns a broker outage into
// silent bad ticks. Off-hours Yahoo is still allowed for coverage of long
// history and instruments Kotak doesn't carry (indices, obscure segments).
export function nseSessionOpen(now = new Date()): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMin >= 225 && utcMin <= 600;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function kotakProvider(svc: SupabaseClient, s: KotakSettings): MarketProvider {
  const yahoo = yahooProvider(svc);
  const nseOpenNow = nseSessionOpen;
  return {
    name: "kotak_neo",
    async getQuotes(keys, opts) {
      const allowFallback = opts?.allowFallback !== false;
      // Resolve instrument tokens from the cached market_stocks map; unresolved keys fall back to Yahoo per-symbol.
      const parsedAll = keys.map((k) => ({ key: k, ...parseKey(k) }));

      const out: QuoteRow[] = [];
      const failedFromKotak: typeof parsedAll = [];

      // Indices are never asked of Kotak. Every quote-type/segment combination
      // returns an empty row (verified: 1,048 consecutive "missing index rows"
      // failures in 24h at ~2.9s each), so the call only added latency to the
      // index poll, tanked the broker's health stats and flooded
      // market_provider_health. NSE/BSE native → Yahoo → stored close is the
      // real chain and always has been the one that served the UI.
      const indexReqs = parsedAll.filter((p) => isIndexSymbol(p.symbol));
      const parsed = parsedAll.filter((p) => !isIndexSymbol(p.symbol));
      if (allowFallback && indexReqs.length > 0) {
        try {
          out.push(...(await resolveIndexQuotes(
            svc,
            indexReqs.map((p) => ({ key: p.key, exchange: p.exchange, symbol: p.symbol })),
            [],
          )));
        } catch (e) { console.error("[market] index chain failed:", e); }
      }

      const tokenBySymbol = await getTokenMap(svc, parsed);
      const tokenEntryFor = (p: { exchange: string; symbol: string }) => tokenBySymbol.get(keyFor(p.exchange, p.symbol));
      const withToken = parsed.filter((p) => tokenEntryFor(p));
      const without = parsed.filter((p) => !tokenEntryFor(p));

      const normalReqs = withToken;

      // Split batches by Kotak segment. One 500 on nse_indices used to fail
      // the equity batch too — a poll-wide collapse to 0 across the UI.
      if (normalReqs.length > 0) {
        const bySeg = new Map<string, typeof normalReqs>();
        for (const p of normalReqs) {
          const entry = tokenEntryFor(p);
          if (!entry) continue;
          const seg = entry.segment;
          const arr = bySeg.get(seg) ?? [];
          arr.push(p); bySeg.set(seg, arr);
        }
        const segResults = await Promise.all(Array.from(bySeg.entries()).map(async ([_seg, group]) => {
          const t0 = Date.now();
          const rows: QuoteRow[] = [];
          const failed: typeof group = [];
          if (kotakBreakerOpen()) {
            // Circuit is open — skip Kotak, let per-symbol Yahoo fallback below handle it.
            for (const p of group) failed.push(p);
            return { rows, failed };
          }
          try {
            const neoSymbols = group.flatMap((p) => {
              const e = tokenEntryFor(p);
              return e ? [`${e.segment}|${e.token}`] : [];
            });
            const raw = await withKotakSession(svc, s, encryptValue, (ss) => kotakQuotes(ss, neoSymbols, "all"));
            const maps = kotakQuoteMaps(raw);
            for (const p of group) {
              const e = tokenEntryFor(p);
              if (!e) { failed.push(p); continue; }
              const r = maps.byNeoSymbol.get(`${e.segment}|${e.token}`) ?? maps.byTokenOnly.get(String(e.token));
              if (!r) { failed.push(p); continue; }
              const row = quoteRowFromKotak(p, r);
              if (row) rows.push(row);
              else failed.push(p);
            }
            logProviderHealth(
              svc,
              "kotak_neo",
              "getQuotes",
              rows.length > 0,
              Date.now() - t0,
              rows.length > 0 ? undefined : `no quote rows for ${group.map((p) => p.key).join(",")}`,
            );
            if (rows.length > 0) kotakBreakerRecordSuccess();

          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logProviderHealth(svc, "kotak_neo", "getQuotes", false, Date.now() - t0, msg);
            kotakBreakerRecordFailure();
            console.error("[market] kotak getQuotes batch failed — per-symbol yahoo fallback:", msg);
            for (const p of group) failed.push(p);
          }
          return { rows, failed };
        }));
        for (const r of segResults) out.push(...r.rows);
        // A Kotak-tokened symbol Kotak couldn't quote:
        //  • an INDEX — Kotak has no working index quote route at all, so a
        //    public source is the only source. Always allowed, and labelled
        //    with whichever upstream served it.
        //  • an equity during the session — NO delayed substitution. The
        //    symbol comes back unquoted and the UI says "broker unavailable"
        //    rather than showing a 15-minute-old price as if it were live.
        //  • an equity off-hours — Yahoo is fine, nothing is live anyway.
        const failedKeys = [...failedFromKotak.map((p) => p.key), ...segResults.flatMap((r) => r.failed.map((p) => p.key))];
        const fallbackKeys = failedKeys.filter((k) => {
          const p = parseKey(k);
          return isIndexSymbol(p.symbol) || !nseOpenNow();
        });
        if (allowFallback && fallbackKeys.length > 0) {
          try { out.push(...(await resolveIndexQuotes(svc, fallbackKeys.map((k) => ({ key: k, ...parseKey(k) })), []))); }
          catch (e) { console.error("[market] per-symbol fallback failed:", e); }
        }
      } else if (failedFromKotak.length > 0 && allowFallback) {
        const fallbackKeys = failedFromKotak
          .filter((p) => isIndexSymbol(p.symbol) || !nseOpenNow())
          .map((p) => ({ key: p.key, exchange: p.exchange, symbol: p.symbol }));
        try { if (fallbackKeys.length > 0) out.push(...(await resolveIndexQuotes(svc, fallbackKeys, []))); }
        catch (e) { console.error("[market] index fallback failed:", e); }
      }
      // Symbols with no Kotak token — always use the public chain. Kotak-primary
      // means "use another source only for coverage Kotak doesn't provide",
      // which is exactly this case (indices/products missing from the master).
      const covered = new Set(out.map((o) => o.key));
      const remaining = without.filter((p) => !covered.has(p.key));
      if (allowFallback && remaining.length > 0) {
        try { out.push(...(await resolveIndexQuotes(svc, remaining.map((p) => ({ key: p.key, exchange: p.exchange, symbol: p.symbol })), []))); }
        catch (e) { console.error("[market] coverage fallback failed:", e); }
      }
      return out;
    },
    // Kotak Neo publishes no historical/candle API at all (see
    // KOTAK_HISTORY_SUPPORTED in kotakClient.ts — every charts route 404s on a
    // live session, and Kotak support confirms it). The old body still tried a
    // token lookup + charts call first, which cost ~2k guaranteed-failing calls
    // a day and dragged Kotak's ok-rate into single digits for a surface it
    // never claimed to serve. Candles go straight to Yahoo.
    async getOHLCV(symbol, exchange, range, interval, meta) {
      if (meta) { meta.source = "yahoo"; meta.reason = "no_broker_history"; }
      return yahoo.getOHLCV(symbol, exchange, range, interval, meta);
    },

    async getDepth(symbol, exchange): Promise<DepthLadder> {
      const t0 = Date.now();
      const { data: stock } = await svc
        .from("market_stocks").select("token,kotak_segment")
        .eq("symbol", symbol).eq("exchange", exchange)
        .not("token", "is", null).maybeSingle();
      const token = stock?.token as string | undefined;
      const seg = (stock?.kotak_segment as string | undefined) || (exchange === "BSE" ? "bse_cm" : "nse_cm");
      if (!token) {
        // Same once-per-isolate rule as getOHLCV above: a tokenless symbol is
        // a permanent scrip-master gap (market_stocks.token_missing_at marks
        // it), not an incident, so it must not write a health row per poll.
        if (!loggedTokenGap.has(`depth:${exchange}:${symbol}`)) {
          loggedTokenGap.add(`depth:${exchange}:${symbol}`);
          logProviderHealth(svc, "kotak_neo", "getDepth", false, 0, `no token for ${exchange}:${symbol}`);
        }

        return {
          bids: [], asks: [], ltp: null, source: "unavailable",
          reason_code: "no_token",
          reason: `No broker instrument token mapped for ${exchange}:${symbol}.`,
        };
      }
      try {
        const d = await withKotakSession(svc, s, encryptValue, (ss) => kotakDepth(ss, token, seg));
        if (d && (d.bids.length || d.asks.length)) {
          logProviderHealth(svc, "kotak_neo", "getDepth", true, Date.now() - t0);
          return { bids: d.bids, asks: d.asks, ltp: d.ltp, source: "kotak", reason_code: "ok" };
        }
        // A well-formed but empty book. Outside session hours that is normal;
        // inside them it means the gateway shape changed — log the keys once.
        const closed = !isIndianMarketOpen();
        const keys = d?.payloadKeys?.join(",") ?? "no payload";
        logProviderHealth(
          svc, "kotak_neo", "getDepth", false, Date.now() - t0,
          `empty book for ${exchange}:${symbol} (${closed ? "market closed" : "market open"}) keys=${keys}`,
        );
        return {
          bids: [], asks: [], ltp: d?.ltp ?? null, source: "kotak",
          reason_code: closed ? "market_closed" : "upstream_error",
          reason: closed
            ? "The exchange order book is only published during market hours."
            : "The broker returned an empty order book.",
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = (e as { status?: number })?.status;
        const authFail = status === 401 || status === 403 || /session|unauthor/i.test(msg);
        logProviderHealth(svc, "kotak_neo", "getDepth", false, Date.now() - t0, msg);
        return {
          bids: [], asks: [], ltp: null, source: "unavailable",
          reason_code: authFail ? "not_connected" : "upstream_error",
          reason: msg.slice(0, 200),
        };
      }
    },

    async getHoldings() {
      const detailed = await this.getHoldingsDetailed!();
      return detailed.rows;
    },
    async getHoldingsDetailed(): Promise<HoldingsResult> {
      const env = await withKotakSession(svc, s, encryptValue, (ss) => kotakHoldingsEnvelope(ss));
      const rows = env.rows.map((h: any) => {
        // Kotak splits equity qty across settled / T1 / pledged. Missing
        // any of these silently understates the portfolio.
        const settled = num(h.quantity ?? h.qty ?? h.holdingQty ?? h.sellableQuantity);
        const t1 = num(h.t1Quantity ?? h.t1Qty ?? h.holdingT1Qty ?? h.usedQuantity);
        const pledged = num(h.collateralQty ?? h.pledgeQty ?? h.pledgedQty ?? h.collateralQuantity);
        const total = settled + t1 + pledged;
        // Prefer costPrice (corp-action-adjusted) over averagePrice when both present.
        const avg = num(h.costPrice ?? h.averagePrice ?? h.avgPrice ?? h.avgPrc);
        // Earliest lot date, when Kotak surfaces one.
        const buyRaw = h.purchaseDate ?? h.buyDate ?? h.holdingPurchaseDate ?? null;
        let buyDate: string | null = null;
        if (buyRaw) {
          const d = new Date(String(buyRaw).replace(/(\d{2})-(\d{2})-(\d{4})/, "$3-$2-$1"));
          if (!Number.isNaN(d.getTime())) {
            buyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
          }
        }
        return {
          symbol: String(h.displaySymbol ?? h.symbol ?? h.trdSym ?? "").replace(/-EQ$/, ""),
          exchange: String(h.exchangeSegment ?? "nse_cm").startsWith("bse") ? "BSE" : "NSE",
          quantity: total,
          avg_price: avg,
          settled_qty: settled || null,
          t1_qty: t1 || null,
          pledged_qty: pledged || null,
          buy_date: buyDate,
        } as HoldingRow;
      }).filter((h: HoldingRow) => h.symbol && h.quantity > 0);
      return { rows, complete: env.ok };
    },
    async getPositions() {
      const detailed = await this.getPositionsDetailed!();
      return detailed.rows;
    },
    async getPositionsDetailed(): Promise<PositionsResult> {
      const env = await withKotakSession(svc, s, encryptValue, (ss) => kotakPositionsEnvelope(ss));
      const rows: PositionRow[] = [];
      const realized: RealizedTradeRow[] = [];
      for (const p of env.rows) {
        const flBuyQty = num(p.flBuyQty ?? p.buyQty);
        const flSellQty = num(p.flSellQty ?? p.sellQty);
        const cfBuyQty = num(p.cfBuyQty);
        const cfSellQty = num(p.cfSellQty);
        const buyQty = flBuyQty + cfBuyQty;
        const sellQty = flSellQty + cfSellQty;
        const netQty = buyQty - sellQty;
        const symbol = String(p.trdSym ?? p.sym ?? "").replace(/-EQ$/, "");
        const exchange = String(p.exSeg ?? "nse_cm").startsWith("bse") ? "BSE" : "NSE";
        if (!symbol) continue;
        // Intraday realized — buy exactly cancels sell, no carry. Kotak reports
        // `flBuyAmt`/`flSellAmt` for today's fills.
        const flBuyAmt = num(p.flBuyAmt ?? (p.buyAmt != null && !p.cfBuyAmt ? p.buyAmt : 0));
        const flSellAmt = num(p.flSellAmt ?? (p.sellAmt != null && !p.cfSellAmt ? p.sellAmt : 0));
        if (netQty === 0 && flBuyQty > 0 && flBuyQty === flSellQty) {
          realized.push({ symbol, exchange, quantity: flBuyQty, realized: flSellAmt - flBuyAmt });
          continue;
        }
        if (netQty === 0) continue;
        // Entry price:
        //  - if there is a carry-forward leg, trust Kotak's carry avg
        //    (`netUploadPrice` / `cfAvgPrice` / prior settlement); blending
        //    it with today's `buyAmt/sellAmt` drifts entry each night.
        //  - purely intraday (no cf leg): today's own average is correct.
        const hasCarry = cfBuyQty > 0 || cfSellQty > 0;
        let entry = 0;
        if (hasCarry) {
          entry = num(p.netUploadPrice ?? p.cfAvgPrice ?? p.upldPrc ?? p.uploadPrice);
          if (!entry) {
            // Fallback: reconstruct from carry side only.
            const cfBuyAmt = num(p.cfBuyAmt);
            const cfSellAmt = num(p.cfSellAmt);
            entry = netQty > 0 && cfBuyQty > 0 ? cfBuyAmt / cfBuyQty
                  : netQty < 0 && cfSellQty > 0 ? cfSellAmt / cfSellQty : 0;
          }
        } else {
          const buyAmt = num(p.buyAmt);
          const sellAmt = num(p.sellAmt);
          entry = netQty > 0 && flBuyQty > 0 ? buyAmt / flBuyQty
                : netQty < 0 && flSellQty > 0 ? sellAmt / flSellQty : 0;
        }
        const rawProduct = String(p.prod ?? p.product ?? "").toUpperCase();
        const product = (rawProduct === "MIS" || rawProduct === "CNC" || rawProduct === "NRML") ? rawProduct : null;
        rows.push({
          symbol,
          exchange,
          side: (netQty >= 0 ? "long" : "short"),
          quantity: Math.abs(netQty),
          entry_price: entry,
          product,
        });
      }
      return { rows, realized, complete: env.ok };
    },
    async placeOrder(input) {
      const seg = input.exchange === "BSE" ? "bse_cm" : "nse_cm";
      const { data: stock } = await svc
        .from("market_stocks").select("token,series")
        .eq("symbol", input.symbol).eq("exchange", input.exchange)
        .not("token", "is", null).maybeSingle();
      const token = stock?.token as string | undefined;
      // Validate/refresh the broker session with a read-only request before
      // touching the order endpoint. A reconnect can happen in a different
      // warm isolate while this provider still holds the old 10-second
      // settings-cache entry; reloading after the preflight guarantees the
      // mutation uses the token that is currently persisted. We still never
      // replay the mutation itself: a 401 after POST remains ambiguous.
      await withKotakSession(svc, s, encryptValue, (ss) => kotakHoldings(ss));
      const fresh = await getFreshSettingsRow(svc, s.id);
      const series = String(stock?.series ?? "EQ").trim().toUpperCase() || "EQ";
      const tradingSymbol = input.symbol.toUpperCase().endsWith(`-${series}`)
        ? input.symbol
        : `${input.symbol}-${series}`;
      const result = await withKotakSession(svc, fresh, encryptValue, (ss) => kotakPlaceOrder(ss, {
        exchangeSegment: seg,
        tradingSymbol,
        instrumentToken: token,
        transactionType: input.side,
        orderType: input.orderType,
        product: input.product,
        quantity: input.quantity,
        price: input.price,
        triggerPrice: input.triggerPrice,
        validity: input.validity,
        disclosedQuantity: input.disclosedQuantity,
        amo: input.amo,
      }), { retryOnAuthError: false });
      return { orderId: result.orderId, status: result.status };
    },
    async modifyOrder(orderId, changes) {
      await withKotakSession(svc, s, encryptValue, (ss) => kotakHoldings(ss));
      const fresh = await getFreshSettingsRow(svc, s.id);
      const r = await withKotakSession(svc, fresh, encryptValue, (ss) => kotakModifyOrder(ss, orderId, changes), { retryOnAuthError: false });
      return { orderId: r.orderId, status: r.status };
    },
    async cancelOrder(orderId) {
      await withKotakSession(svc, s, encryptValue, (ss) => kotakHoldings(ss));
      const fresh = await getFreshSettingsRow(svc, s.id);
      const r = await withKotakSession(svc, fresh, encryptValue, (ss) => kotakCancelOrder(ss, orderId), { retryOnAuthError: false });
      return { orderId: r.orderId, status: r.status };
    },
    async convertPosition(input) {
      const seg = input.exchange === "BSE" ? "bse_cm" : "nse_cm";
      const { data: stock } = await svc
        .from("market_stocks").select("token")
        .eq("symbol", input.symbol).eq("exchange", input.exchange)
        .not("token", "is", null).maybeSingle();
      const token = stock?.token as string | undefined;
      await withKotakSession(svc, s, encryptValue, (ss) => kotakHoldings(ss));
      const fresh = await getFreshSettingsRow(svc, s.id);
      await withKotakSession(svc, fresh, encryptValue, (ss) => kotakConvertPosition(ss, {
        exchangeSegment: seg,
        tradingSymbol: `${input.symbol}-EQ`,
        instrumentToken: token,
        transactionType: input.side,
        quantity: input.quantity,
        fromProduct: input.fromProduct,
        toProduct: input.toProduct,
      }), { retryOnAuthError: false });
      return { ok: true };
    },
    async getFunds(): Promise<FundsSnapshot> {
      const t0 = Date.now();
      // Neo exposes margins only through /quick/user/limits (jData form-encoded).
      // The old JSON body 404'd, and the /quick/user/margin "fallback" isn't a
      // real Neo route — it just doubled the latency of every failure.
      try {
        const j = await withKotakSession(svc, s, encryptValue, (ss) => kotakLimits(ss));
        const parsed = parseKotakLimits(j);
        logProviderHealth(svc, "kotak_neo", "getFunds:limits", true, Date.now() - t0);
        svc.from("market_api_settings")
          .update({ funds_last_error_code: null, funds_last_attempt_at: new Date().toISOString() })
          .eq("id", s.id).then(() => {}, () => {});
        return { ...parsed, source: "kotak" };
      } catch (e) {
        const code = classifyFundsError(e);
        logProviderHealth(svc, "kotak_neo", "getFunds", false, Date.now() - t0, e instanceof Error ? e.message : String(e));
        svc.from("market_api_settings")
          .update({ funds_last_error_code: code, funds_last_attempt_at: new Date().toISOString() })
          .eq("id", s.id).then(() => {}, () => {});
        throw e;
      }
    },


    async testAuth() {
      // Holdings is a lightweight GET that succeeds whenever the session is
      // valid (even for a brand-new account with zero holdings — the payload
      // is just `{data: []}`). It's what the app actually uses in production,
      // so if this passes the connection is genuinely usable.
      // /quick/user/limits (what we used to probe) frequently returns 500 with
      // an empty body from Kotak even on valid sessions, giving false negatives.
      try {
        await withKotakSession(svc, s, encryptValue, (ss) => kotakHoldings(ss));
        return { ok: true, detail: "Kotak session valid" };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, detail: msg };
      }
    },
  };
}


// ---------- Cross-invocation token priming ----------
// EGRESS: the two caches above are per-isolate, and a live sweep is a chain of
// COLD invocations, so they almost never hit — the Kotak lookup
// (symbol,exchange,token,kotak_segment,instrument_type) was re-issued for
// every quote chunk, ~19 MB a day. A caller that already holds the tokens (the live-sweep
// snapshot) primes them here, so `getTokenMap` finds every symbol in cache and
// issues no query at all.

/** Seed the Kotak token cache from a snapshot: `{ "NSE:RELIANCE": { token, segment } }`. */
export function primeTokenMap(entries: Record<string, { token: string; segment: string }>): void {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry?.token) continue;
    tokenCache.set(key.toUpperCase(), { entry: { token: String(entry.token), segment: String(entry.segment) }, expiresAt });
  }
}



// ---------- Resolution ----------

export interface ActiveProvider {
  provider: MarketProvider;
  settings: KotakSettings | null;
  /** The operator's pin for this feed, if any (empty for account reads). */
  route?: FeedRoute;
  /** primary → fallback → built-in chain, as actually resolved. */
  chain?: RouteProvider[];
  /** Which link of the chain answered. */
  resolved?: RouteProvider;
}


/** Providers that carry a real broker account (orders, holdings, funds). */
export const BROKER_PROVIDERS = ["kotak_neo"] as const as readonly string[];

const kotakUsable = (r: SettingsRow): boolean => {
  const completeSession = r.connection_status === "connected"
    && !!r.session_token_enc && !!r.sid && !!r.base_url;
  // On a lean row the auto-login secrets are `undefined` (not read), so this
  // half of the test is unknown until hydrateKotakCredentials() fills them in.
  const completeAutoLogin = !!r.consumer_key && !!r.mobile_number_enc
    && !!r.mpin_enc && !!r.totp_secret_enc && !!r.ucc;
  return completeSession || completeAutoLogin;
};

/** kotakUsable, but hydrates a lean row's secrets before giving up. */
async function kotakUsableHydrated(svc: SupabaseClient, r: SettingsRow): Promise<boolean> {
  if (kotakUsable(r)) return true;
  if (r.mobile_number_enc !== undefined) return false;
  await hydrateKotakCredentials(svc, r);
  return kotakUsable(r);
}


function providerForRow(svc: SupabaseClient, row: SettingsRow): MarketProvider | null {
  if (row.active_provider === "kotak_neo") return kotakProvider(svc, row);
  return null;
}

// Account-bound provider: the caller's OWN broker connection. Orders,
// holdings, positions, funds, GTT and AutoTrade must use this and nothing
// else — another account's session would place trades on the wrong book.
export async function getActiveProvider(
  svc: SupabaseClient,
  userId: string,
): Promise<ActiveProvider> {
  // Account-bound reads and mutations must never reuse a cached credential or
  // session row. A reconnect/key-recovery can clear or replace encrypted
  // values in another isolate; using the old row for ten minutes caused
  // Orders/Trades to keep attempting decryption after recovery had completed.
  const rows = await getSettingsRows(svc, userId, false);
  const connected = rows.find((r) => BROKER_PROVIDERS.includes(r.active_provider) && r.connection_status === "connected");
  if (connected) {
    const p = providerForRow(svc, connected);
    if (p) return { provider: p, settings: connected };
  }
  const credentialed: SettingsRow | undefined = await (async () => {
    for (const r of rows) {
      if (r.active_provider !== "kotak_neo") continue;
      if (await kotakUsableHydrated(svc, r)) return r;
    }
    return undefined;
  })();

  if (credentialed) {
    const p = providerForRow(svc, credentialed);
    if (p) return { provider: p, settings: credentialed };
  }

  return { provider: yahooProvider(svc), settings: null };
}

// ---------- System market-data feed ----------
// Market data (quotes, candles, depth, index levels) is NOT account-bound, so
// the app runs it off one designated "system" Kotak connection
// (market_api_settings.is_system) instead of requiring every user to connect
// their own broker. Users only connect Kotak for their own account data.
// EGRESS: the system feed row changes only when the user reconnects a broker,
// and every such path calls invalidateSystemFeedCache(). A 15 s TTL made this
// the app's most-requested table (1,492 reads/day, 5.8 MB) for no benefit.
const SYSTEM_FEED_TTL_MS = 10 * 60_000;
let systemFeedCache: { row: SettingsRow | null; expiresAt: number } | null = null;

export function invalidateSystemFeedCache(): void {
  systemFeedCache = null;
}

async function getSystemFeedRow(svc: SupabaseClient): Promise<SettingsRow | null> {
  if (systemFeedCache && systemFeedCache.expiresAt > Date.now()) return systemFeedCache.row;
  const cols = ALL_SETTINGS_COLS + ",is_system,purpose";
  // Only an explicitly designated data-purpose connection may serve market
  // data. There is deliberately NO "newest connected row" fallback: a user
  // connecting their broker for their portfolio must never silently become
  // the app's price feed.
  const { data: designated } = await svc
    .from("market_api_settings").select(cols)
    .eq("is_system", true).eq("purpose", "data")
    .in("active_provider", BROKER_PROVIDERS as string[]).limit(1);
  const row: SettingsRow | null = ((designated ?? []) as unknown as SettingsRow[])[0] ?? null;
  // Lean read: pull the auto-login secrets only when the live session alone
  // does not already qualify the feed (i.e. it is expired/disconnected).
  if (row) await kotakUsableHydrated(svc, row);
  systemFeedCache = { row, expiresAt: Date.now() + SYSTEM_FEED_TTL_MS };
  return row;
}


const usableSession = (r: SettingsRow | null | undefined): boolean => !!r && kotakUsable(r);

// Read-only market-data provider: the admin-designated data feed, else public
// vendors (Yahoo/NSE). A user's own broker session is NEVER used for market
// data — that plane is account-bound only.
//
// One generic walk down `primary → fallback → built-in chain` (feedRoute.ts is
// the single source of truth).
export async function getReadProvider(
  svc: SupabaseClient,
  _userId: string,
  /** Routed feed id ("ltp", "indices", "candles_1d", "depth", ...) — honours
   *  the operator's Primary/Fallback choice for that feed. */
  feedId?: string,
): Promise<ActiveProvider> {
  const base = chainFor(feedId);
  let route: FeedRoute = {};
  let chain = base;
  try {
    route = feedId ? await getFeedRoute(svc, feedId) : {};
    chain = orderChain(base, route);
    const sys = await getSystemFeedRow(svc);
    for (const p of chain) {
      if (p === "yahoo" || p === "nse") {
        return { provider: yahooProvider(svc), settings: null, route, chain, resolved: p };
      }
      if (p === "kotak") {
        // Only the designated system data feed may serve market data.
        if (sys && sys.active_provider === toProviderName(p) && usableSession(sys)) {
          const impl = providerForRow(svc, sys);
          if (impl) return { provider: impl, settings: sys, route, chain, resolved: p };
        }
      }
      // anything else (fmp/alpha/computed) is not a live-quote provider — skip
    }
  } catch { /* fall through to public vendors */ }
  return { provider: yahooProvider(svc), settings: null, route, chain, resolved: "yahoo" };
}



// Service-level provider for cron jobs (no user context) — same system feed.
export async function getServiceProvider(svc: SupabaseClient): Promise<ActiveProvider> {
  const row = await getSystemFeedRow(svc);
  if (usableSession(row)) {
    const p = row ? providerForRow(svc, row) : null;
    if (p) return { provider: p, settings: row };
  }
  return { provider: yahooProvider(svc), settings: null };
}

export { yahooProvider };

