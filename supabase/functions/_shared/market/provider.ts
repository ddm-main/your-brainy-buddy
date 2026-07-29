// Provider abstraction — the rest of the backend talks to this interface,
// never to a broker API directly. Active provider comes from market_api_settings.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { encryptStatementPassword } from "../crypto.ts";
import { isDailyGrain as hasDailyGrain } from "./candleGuard.ts";

import {
  KOTAK_SETTINGS_COLS,
  type KotakSettings,
  kotakCancelOrder,
  kotakConvertPosition,
  kotakCandles,
  KOTAK_CANDLES_ROUTE,
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
import { toYahooSymbol, yahooChartRetry, yahooQuote } from "./yahooClient.ts";
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
  source: "kotak" | "yahoo" | "cache";
  as_of?: string | null;
  previous_close_as_of?: string | null;
  high_52w?: number | null;
  low_52w?: number | null;
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

interface SettingsRow extends KotakSettings { active_provider: string }
const settingsCache = new Map<string, { rows: SettingsRow[]; expiresAt: number }>();
const SETTINGS_TTL_MS = 10_000;

async function getSettingsRows(svc: SupabaseClient, userId: string): Promise<SettingsRow[]> {
  const cached = settingsCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;
  const { data } = await svc
    .from("market_api_settings")
    .select(KOTAK_SETTINGS_COLS + ",active_provider")
    .eq("user_id", userId);
  const rows = (data ?? []) as SettingsRow[];
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

let tokenMapCache: { map: Map<string, TokenEntry>; expiresAt: number } | null = null;
const TOKEN_MAP_TTL_MS = 60_000;

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


async function getTokenMap(svc: SupabaseClient): Promise<Map<string, TokenEntry>> {
  if (tokenMapCache && tokenMapCache.expiresAt > Date.now()) return tokenMapCache.map;
  // PostgREST caps an unbounded select at 1000 rows. The universe is ~2.7k
  // tokened instruments, so the un-paged read silently dropped ~two thirds of
  // the book — every dropped symbol resolved "no Kotak token" and was served
  // by Yahoo instead. Page explicitly until the table is drained.
  const PAGE = 1000;
  const data: any[] = [];
  for (let from = 0; from < 20_000; from += PAGE) {
    const { data: page, error } = await svc
      .from("market_stocks").select("symbol,exchange,token,kotak_segment,instrument_type")
      .in("exchange", ["NSE", "BSE"]).not("token", "is", null)
      .order("symbol", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("[market] token map page failed:", error.message); break; }
    data.push(...(page ?? []));
    if (!page || page.length < PAGE) break;
  }
  const map = new Map<string, TokenEntry>();

  for (const r of data ?? []) {
    const isIdx = String(r.instrument_type ?? "").toUpperCase() === "INDEX"
      || String(r.symbol ?? "").startsWith("^");
    const defaultSeg = isIdx
      ? (r.exchange === "BSE" ? "bse_indices" : "nse_indices")
      : (r.exchange === "BSE" ? "bse_cm" : "nse_cm");
    map.set(keyFor(String(r.exchange), String(r.symbol)), { token: String(r.token), segment: r.kotak_segment || defaultSeg });
  }
  // Index alias resolution is GROUP-wise, not canonical-first: the scrip
  // master may carry the instrument under any member of the group ("NIFTY 50",
  // "NIFTY", "^NSEI"). Resolving only from the canonical key meant a master
  // that lists "NIFTY 50" left ^NSEI tokenless, so every index quote silently
  // fell through to Yahoo. Take whichever member exists and map it to all.
  for (const [canonical, aliases] of Object.entries(INDEX_ALIASES)) {
    const [exchange, symbol] = canonical.split(":") as [string, string];
    const members = [symbol, ...aliases];
    let entry = members.map((m) => map.get(keyFor(exchange, m))).find(Boolean);
    // Last resort: NSE's well-known index tokens. Kotak's nse_indices segment
    // uses the same token numbers, so a master missing the index row does not
    // have to cost us the feed.
    if (!entry) {
      const known = KNOWN_INDEX_TOKENS[canonical];
      if (known) entry = { token: known, segment: exchange === "BSE" ? "bse_indices" : "nse_indices" };
    }
    if (!entry) continue;
    for (const m of members) {
      if (!map.has(keyFor(exchange, m))) map.set(keyFor(exchange, m), entry);
    }
  }

  tokenMapCache = { map, expiresAt: Date.now() + TOKEN_MAP_TTL_MS };
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
// free-tier database. Failures are always kept (that's what we debug with);
// successes are sampled, since they only serve as a background heartbeat.
const HEALTH_SUCCESS_SAMPLE = 0.05;

function logProviderHealth(
  svc: SupabaseClient,
  provider: string,
  endpoint: string,
  ok: boolean,
  latencyMs: number,
  error?: string,
): void {
  if (ok && Math.random() > HEALTH_SUCCESS_SAMPLE) return;
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
      const parsed = keys.map((k) => ({ key: k, ...parseKey(k) }));
      const tokenBySymbol = await getTokenMap(svc);
      const tokenEntryFor = (p: { exchange: string; symbol: string }) => tokenBySymbol.get(keyFor(p.exchange, p.symbol));
      const withToken = parsed.filter((p) => tokenEntryFor(p));
      const without = parsed.filter((p) => !tokenEntryFor(p));

      const out: QuoteRow[] = [];
      // Split batches by Kotak segment. One 500 on nse_indices used to fail
      // the equity batch too — a poll-wide collapse to 0 across the UI.
      if (withToken.length > 0) {
        const bySeg = new Map<string, typeof withToken>();
        for (const p of withToken) {
          const seg = tokenEntryFor(p)!.segment;
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
            const entryFor = (p: { exchange: string; symbol: string }) =>
              tokenEntryFor(p)!;
            const neoSymbols = group.map((p) => { const e = entryFor(p); return `${e.segment}|${e.token}`; });
            const raw = await withKotakSession(svc, s, encryptValue, (ss) => kotakQuotes(ss, neoSymbols, "all"));
            logProviderHealth(svc, "kotak_neo", "getQuotes", true, Date.now() - t0);
            kotakBreakerRecordSuccess();
            const byNeoSymbol = new Map<string, any>();
            const byTokenOnly = new Map<string, any>();
            for (const r of raw) {
              const rawNeoSymbol = String(
                r?.symbol ?? r?.neoSymbol ?? r?.neosymbol ?? r?.pSymbolName ?? "",
              ).trim();
              // Neo's /script-details quote payload identifies a row with
              // `exchange_token` + `exchange` (e.g. 2885 / "nse_cm") — it
              // carries no `symbol`/`tk` field at all. Missing this made
              // EVERY tokened symbol look unmatched, so the whole book fell
              // through to Yahoo while Kotak was answering perfectly.
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
            for (const p of group) {
              const e = entryFor(p);
              const r = byNeoSymbol.get(`${e.segment}|${e.token}`) ?? byTokenOnly.get(String(e.token));
              if (!r) { failed.push(p); continue; }
              const price = firstNum(r, ["last_traded_price", "ltp", "lastPrice", "last_price", "lp"]);
              const prevClose = firstNum(r, [
                "previous_close", "prev_close", "previousClose", "prevClose",
                "ohlc.close", "ohlc.c", "closing_price", "close", "c",
              ]);
              if (!price) { failed.push(p); continue; }
              const changeAbs = prevClose ? price - prevClose : firstNum(r, ["change"]);
              rows.push({
                key: p.key,
                price,
                previous_close: prevClose,
                change_abs: changeAbs,
                change_pct: prevClose ? ((price - prevClose) / prevClose) * 100 : firstNum(r, ["per_change"]),
                // Neo calls the cumulative day volume `last_volume`.
                volume: firstNum(r, ["volume", "vol_traded_today", "last_volume", "totalTradedVolume"]),
                day_open: firstNum(r, ["open_price", "ohlc.open", "ohlc.o", "opn_pric", "open", "o"]),
                day_high: firstNum(r, ["high_price", "ohlc.high", "ohlc.h", "hgh_pric", "high", "h"]),
                day_low: firstNum(r, ["low_price", "ohlc.low", "ohlc.l", "lw_pric", "low", "l"]),
                source: "kotak",
                as_of: parseKotakDate(r),
                previous_close_as_of: null,
                high_52w: firstNum(r, ["hgh_52w_val", "high_52w", "52wkHigh", "yearHigh", "year_high"]),
                low_52w: firstNum(r, ["lw_52w_val", "low_52w", "52wkLow", "yearLow", "year_low"]),
              });
            }

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
        //  • during the session — NO Yahoo substitution. The symbol comes back
        //    unquoted and the UI says "broker unavailable" rather than showing
        //    a 15-minute-old price as if it were live.
        //  • off-hours — Yahoo is fine, nothing is live anyway.
        const failedKeys = segResults.flatMap((r) => r.failed.map((p) => p.key));
        if (allowFallback && failedKeys.length > 0 && !nseOpenNow()) {
          try { out.push(...(await yahoo.getQuotes(failedKeys))); }
          catch (e) { console.error("[market] yahoo per-symbol fallback failed:", e); }
        }
      }
      // Symbols with no Kotak token — always use Yahoo. Kotak-primary means
      // "use Yahoo only for coverage Kotak doesn't provide", which is exactly
      // this case (indices/products missing from Kotak's scrip master).
      const covered = new Set(out.map((o) => o.key));
      const remaining = without.map((p) => p.key).filter((k) => !covered.has(k));
      if (allowFallback && remaining.length > 0) {
        try { out.push(...(await yahoo.getQuotes(remaining))); }
        catch (e) { console.error("[market] yahoo coverage fallback failed:", e); }
      }
      return out;
    },
    // Kotak historical candles when we have an instrument token; else Yahoo.
    async getOHLCV(symbol, exchange, range, interval, meta) {
      if (meta) meta.source = "kotak_neo";
      // Resolve through the SAME alias-aware token map the quote path uses.
      // A direct market_stocks lookup missed every index the UI asks for by
      // its trading alias ("NIFTY", "BANKNIFTY", "INDIA VIX"), which is why
      // index candles permanently logged "no token" and fell to Yahoo even
      // though Kotak carries the instrument under its canonical row.
      const tokenBySymbolForCandles = await getTokenMap(svc);
      const entry = tokenBySymbolForCandles.get(keyFor(exchange, symbol))
        ?? tokenBySymbolForCandles.get(keyFor(exchange === "BSE" ? "NSE" : "BSE", symbol));
      const isIndex = symbol.startsWith("^") || /^(NIFTY|BANKNIFTY|FINNIFTY|SENSEX|INDIA VIX)/i.test(symbol);
      // Indices live under nse_indices / bse_indices in Kotak's scrip master.
      // Falling through to nse_cm returned empty and forced Yahoo (delayed).
      const defaultSeg = isIndex
        ? (exchange === "BSE" ? "bse_indices" : "nse_indices")
        : (exchange === "BSE" ? "bse_cm" : "nse_cm");
      const token = entry?.token;
      const seg = entry?.segment || defaultSeg;
      if (!token) {
        // Not a failure — Kotak's scrip master simply has no token for this
        // symbol (mostly indices and new listings), and Yahoo covers it. This
        // used to write one health row per tokenless symbol per pipeline run,
        // which is pure, permanent noise. Log it once per isolate so the gap
        // is still visible without flooding the table.
        if (!loggedTokenGap.has(`${exchange}:${symbol}`)) {
          loggedTokenGap.add(`${exchange}:${symbol}`);
          logProviderHealth(svc, "kotak_neo", "getOHLCV", false, 0, `no token for ${exchange}:${symbol} — using yahoo`);
        }
        // Coverage gap Kotak's scrip master doesn't fill (mostly indices).
        // Yahoo is allowed here regardless of market state — it's the only
        // source we have. `meta` records that so the UI marks it delayed.
        if (meta) meta.reason = "no_token";
        return yahoo.getOHLCV(symbol, exchange, range, interval, meta);
      }
      // range like "2y","60d","30d","max"; interval like "1d","1h","15m"
      const now = Math.floor(Date.now() / 1000);
      const YEAR = 365 * 86400;
      const wanted = rangeSeconds(range);
      const fromEpoch = now - wanted;
      // Full Kotak interval map — the old fallthrough silently returned daily
      // bars for 1m / 3m / 30m / 2h / 4h / 1w / 1mo, so the UI showed the
      // wrong grain and volume looked "missing" on those TFs.
      const kotakIntervalMap: Record<string, string> = {
        "1m": "1", "2m": "1", "3m": "1", "5m": "5", "15m": "15", "30m": "30",
        "60m": "60", "1h": "60", "2h": "60", "4h": "60",
        "1d": "D", "1wk": "W", "1mo": "M",
      };
      const kotakInterval = kotakIntervalMap[interval] ?? "D";
      const isDailyGrain = kotakInterval === "D" || kotakInterval === "W" || kotakInterval === "M";
      // Server-side resample buckets for TFs Kotak doesn't emit natively.
      const resampleFactor = interval === "2h" ? 2 : interval === "4h" ? 4 : interval === "3m" ? 3 : interval === "2m" ? 2 : 1;
      const t0 = Date.now();

      // Kotak's /charts/v2/history silently truncates long windows, so deep
      // history is requested in ≤2-year slices and merged. Tiny intraday
      // intervals stay short at the caller level; 15m+ can walk back to the
      // maximum provider history instead of being capped at 30–60 days.
      const fetchKotak = async (): Promise<Candle[]> => {
        const WINDOW = 2 * YEAR;
        const shouldChunk = wanted > WINDOW && (isDailyGrain || kotakInterval === "15" || kotakInterval === "30" || kotakInterval === "60");
        if (!shouldChunk) {
          return await withKotakSession(svc, s, encryptValue, (ss) =>
            kotakCandles(ss, token, seg, fromEpoch, now, kotakInterval));
        }
        const byTime = new Map<number, Candle>();
        let to = now;
        while (to > fromEpoch) {
          const from = Math.max(fromEpoch, to - WINDOW);
          let slice: Candle[] = [];
          try {
            slice = await withKotakSession(svc, s, encryptValue, (ss) =>
              kotakCandles(ss, token, seg, from, to, kotakInterval));
          } catch (err) {
            // Partial history beats none: stop widening on the first failure
            // but keep whatever earlier windows returned.
            if (byTime.size === 0) throw err;
            break;
          }
          // Kotak returns nothing before the listing date — stop walking back.
          if (slice.length === 0) break;
          for (const c of slice) byTime.set(c.time, c);
          to = from - 1;
        }
        return [...byTime.values()].sort((a, b) => a.time - b.time);
      };

      // Kotak sheds load with HTTP 503 ("no available server"), which usually
      // clears within a second. Retry briefly before declaring the broker down
      // — during the session there is no substitute source, so it's worth the
      // extra ~1s rather than serving nothing.
      const fetchKotakResilient = async (): Promise<Candle[]> => {
        const backoff = [250, 750, 1500];
        for (let attempt = 0; ; attempt++) {
          try {
            return await fetchKotak();
          } catch (err) {
            const st = (err as { status?: number } | null)?.status;
            const retryable = st === 503 || st === 429 || st === 502 || st === 504;
            if (!retryable || attempt >= backoff.length) throw err;
            await sleep(backoff[attempt]);
          }
        }
      };

      try {
        const raw = await fetchKotakResilient();
        if (raw.length === 0) {
          const reason = `empty candles for ${exchange}:${symbol} (seg=${seg})`;
          logProviderHealth(svc, "kotak_neo", "getOHLCV", false, Date.now() - t0, reason);
          // Intraday during the session: Kotak is the only permitted source,
          // so an empty series is a broker failure, not a licence to serve
          // 15-min-delayed bars. Daily/weekly/monthly are historical — Yahoo
          // may still backfill them (pipelines run mid-session too).
          if (nseOpenNow() && !isDailyGrain) {
            if (meta) meta.reason = "empty";
            throw new Error(`kotak returned no ${interval} candles`);
          }
          // Off-hours: Yahoo backfill for history Kotak doesn't carry.
          if (meta) meta.reason = "empty";
          return yahoo.getOHLCV(symbol, exchange, range, interval, meta);
        }
        let c = resampleFactor > 1 ? resampleCandles(raw, resampleFactor) : raw;
        // Depth sanity check: when the caller asked for deep history and
        // Kotak came back materially short (its equity archive is shallow),
        // merge Yahoo's longer series in rather than serving a stub chart.
        // This only ever ADDS older bars — the live tail stays Kotak's, so it
        // doesn't violate the Kotak-only-during-session rule.
        if (isDailyGrain && wanted > 2 * YEAR) {
          const oldest = c[0]?.time ?? now;
          const covered = now - oldest;
          if (covered < Math.min(wanted, 3 * YEAR) * 0.9) {
            try {
              const deep = await yahoo.getOHLCV(symbol, exchange, range, interval);
              // Only merge a genuinely daily series — Yahoo can answer a deep
              // daily request with monthly bars, which must never dilute the
              // Kotak series or reach market_daily_prices.
              if (deep.length > c.length && hasDailyGrain(deep)) {
                const merged = new Map<number, Candle>();
                for (const d of deep) merged.set(d.time, d);
                for (const k of c) merged.set(k.time, k); // Kotak wins on overlap
                c = [...merged.values()].sort((a, b) => a.time - b.time);
              }
            } catch { /* keep the Kotak series */ }

          }
        }
        logProviderHealth(svc, "kotak_neo", "getOHLCV", true, Date.now() - t0);
        if (meta) meta.source = "kotak_neo";
        return c;
      } catch (e) {
        const status = (e as { status?: number } | null)?.status;
        // Don't re-log what the circuit breaker already reported. When the
        // charts route is dead (404) or the broker is shedding load (503),
        // every symbol in the run fails identically; logging each one wrote
        // thousands of duplicate rows a day into market_provider_health
        // (9,658 in a single day) on a 500 MB database. The breaker logs the
        // transition once and this path stays silent until it closes.
        if (!isRouteOpen(KOTAK_CANDLES_ROUTE)) {
          logProviderHealth(svc, "kotak_neo", "getOHLCV", false, Date.now() - t0, e instanceof Error ? e.message : String(e));
        }
        if (meta) {
          meta.reason = status === 503 ? "broker_503"
            : status === 404 ? "route_missing"
            : status === 401 || status === 403 ? "session"
            : meta.reason ?? "other";
        }
        // Kotak-only for live intraday during the session: a broker outage
        // (503, dead route, tripped breaker) surfaces as a failure the UI
        // reports honestly. Delayed Yahoo bars are NEVER substituted for live
        // data. Daily-grain history stays permissive so EOD/backfill pipelines
        // that run mid-session keep working.
        if (nseOpenNow() && !isDailyGrain) throw e;
        return yahoo.getOHLCV(symbol, exchange, range, interval, meta);
      }
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

// ---------- Resolution ----------

export interface ActiveProvider {
  provider: MarketProvider;
  settings: KotakSettings | null;
}

// Account-bound provider: the caller's OWN broker connection. Orders,
// holdings, positions, funds, GTT and AutoTrade must use this and nothing
// else — another account's session would place trades on the wrong book.
export async function getActiveProvider(
  svc: SupabaseClient,
  userId: string,
): Promise<ActiveProvider> {
  const rows = await getSettingsRows(svc, userId);
  const kotak = rows.find((r) => r.active_provider === "kotak_neo" && r.connection_status === "connected");
  if (kotak) return { provider: kotakProvider(svc, kotak), settings: kotak };
  const kotakAny = rows.find((r) => r.active_provider === "kotak_neo" && r.totp_secret_enc);
  if (kotakAny) return { provider: kotakProvider(svc, kotakAny), settings: kotakAny };
  return { provider: yahooProvider(svc), settings: null };
}

// ---------- System market-data feed ----------
// Market data (quotes, candles, depth, index levels) is NOT account-bound, so
// the app runs it off one designated "system" Kotak connection
// (market_api_settings.is_system) instead of requiring every user to connect
// their own broker. Users only connect Kotak for their own account data.
const SYSTEM_FEED_TTL_MS = 15_000;
let systemFeedCache: { row: KotakSettings | null; expiresAt: number } | null = null;

export function invalidateSystemFeedCache(): void {
  systemFeedCache = null;
}

async function getSystemFeedRow(svc: SupabaseClient): Promise<KotakSettings | null> {
  if (systemFeedCache && systemFeedCache.expiresAt > Date.now()) return systemFeedCache.row;
  const cols = KOTAK_SETTINGS_COLS + ",active_provider,is_system";
  // 1) Explicitly designated system feed.
  const { data: designated } = await svc
    .from("market_api_settings").select(cols)
    .eq("is_system", true).eq("active_provider", "kotak_neo").limit(1);
  let row = ((designated ?? []) as KotakSettings[])[0] ?? null;
  // 2) Legacy fallback — no designation yet: newest connected Kotak row.
  if (!row) {
    const { data } = await svc
      .from("market_api_settings").select(cols)
      .eq("active_provider", "kotak_neo")
      .order("updated_at", { ascending: false }).limit(5);
    const rows = (data ?? []) as KotakSettings[];
    row = rows.find((r) => r.connection_status === "connected") ?? rows.find((r) => r.totp_secret_enc) ?? null;
  }
  systemFeedCache = { row, expiresAt: Date.now() + SYSTEM_FEED_TTL_MS };
  return row;
}

const usableSession = (r: KotakSettings | null | undefined): boolean =>
  !!r && (r.connection_status === "connected" || !!r.totp_secret_enc);

// Read-only market-data provider. System Kotak feed first (so every signed-in
// user gets real-time prices without connecting a broker), the caller's own
// Kotak next, Yahoo last. Never use this for account-bound calls.
export async function getReadProvider(
  svc: SupabaseClient,
  userId: string,
): Promise<ActiveProvider> {
  try {
    const sys = await getSystemFeedRow(svc);
    if (usableSession(sys)) return { provider: kotakProvider(svc, sys!), settings: sys };
  } catch { /* fall through to the caller's own connection */ }
  return getActiveProvider(svc, userId);
}

// Service-level provider for cron jobs (no user context) — same system feed.
export async function getServiceProvider(svc: SupabaseClient): Promise<ActiveProvider> {
  const row = await getSystemFeedRow(svc);
  if (usableSession(row)) return { provider: kotakProvider(svc, row!), settings: row };
  return { provider: yahooProvider(svc), settings: null };
}

export { yahooProvider };

