// Provider abstraction — the rest of the backend talks to this interface,
// never to a broker API directly. Active provider comes from market_api_settings.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { encryptStatementPassword } from "../crypto.ts";
import {
  KOTAK_SETTINGS_COLS,
  type KotakSettings,
  kotakCancelOrder,
  kotakConvertPosition,
  kotakCandles,
  kotakDepth,
  kotakHoldings,
  kotakHoldingsEnvelope,
  kotakLimits,
  kotakUserMargin,
  kotakModifyOrder,
  kotakPlaceOrder,
  kotakPositions,
  kotakPositionsEnvelope,
  kotakQuotes,
  parseKotakLimits,
  type KotakFundsSnapshot,
  withKotakSession,
} from "./kotakClient.ts";
import { toYahooSymbol, yahooChartRetry, yahooQuote } from "./yahooClient.ts";
import type { Candle } from "./indicators.ts";

export type DepthLadder = {
  bids: Array<{ price: number; qty: number; orders: number }>;
  asks: Array<{ price: number; qty: number; orders: number }>;
  ltp: number | null;
  source: "kotak" | "yahoo" | "unavailable";
};

export interface QuoteRow {
  key: string; // "NSE:SYMBOL" as requested by the caller
  price: number;
  previous_close: number | null;
  change_abs: number | null;
  change_pct: number | null;
  volume: number | null;
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

export interface MarketProvider {
  name: string;
  getQuotes(keys: string[]): Promise<QuoteRow[]>;
  getOHLCV(symbol: string, exchange: string, range: string, interval: string): Promise<Candle[]>;
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
async function getTokenMap(svc: SupabaseClient): Promise<Map<string, TokenEntry>> {
  if (tokenMapCache && tokenMapCache.expiresAt > Date.now()) return tokenMapCache.map;
  const { data } = await svc
    .from("market_stocks").select("symbol,exchange,token,kotak_segment,instrument_type")
    .in("exchange", ["NSE", "BSE"]).not("token", "is", null);
  const map = new Map<string, TokenEntry>(
    (data ?? []).map((r: any) => {
      const isIdx = String(r.instrument_type ?? "").toUpperCase() === "INDEX"
        || String(r.symbol ?? "").startsWith("^");
      const defaultSeg = isIdx
        ? (r.exchange === "BSE" ? "bse_indices" : "nse_indices")
        : (r.exchange === "BSE" ? "bse_cm" : "nse_cm");
      return [
        `${r.exchange}:${r.symbol}`,
        { token: String(r.token), segment: r.kotak_segment || defaultSeg },
      ];
    }),
  );
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

// ---------- Provider health logging ----------
// Lightweight — one row per getQuotes call for whichever provider actually
// served it, not every internal call. Never let a logging failure affect
// the actual data path: fire-and-forget, errors swallowed.
function logProviderHealth(
  svc: SupabaseClient,
  provider: string,
  endpoint: string,
  ok: boolean,
  latencyMs: number,
  error?: string,
): void {
  svc.from("market_provider_health").insert({
    provider, endpoint, ok, latency_ms: Math.round(latencyMs),
    error: error ? error.slice(0, 500) : null,
  }).then(() => {}, () => {});
}

// ---------- Yahoo provider ----------

function yahooProvider(svc: SupabaseClient): MarketProvider {
  return {
    name: "yahoo",
    async getQuotes(keys) {
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
    async getOHLCV(symbol, exchange, range, interval) {
      // Yahoo accepts 1m/2m/5m/15m/30m/60m/90m/1h/1d/5d/1wk/1mo/3mo only.
      // 3m -> resample from 1m, 2h/4h -> resample from 60m. 1h passes as 60m.
      const yInterval = interval === "3m" ? "1m"
        : interval === "2h" || interval === "4h" ? "60m"
        : interval === "1h" ? "60m"
        : interval;
      const factor = interval === "3m" ? 3 : interval === "2h" ? 2 : interval === "4h" ? 4 : 1;
      const raw = await yahooChartRetry(toYahooSymbol(symbol, exchange), range, yInterval);
      return factor > 1 ? resampleCandles(raw, factor) : raw;
    },
    async getDepth() {
      return { bids: [], asks: [], ltp: null, source: "unavailable" };
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
  const raw = obj?.last_traded_time ?? obj?.lastTradeTime ?? obj?.ltt ?? obj?.tradeTime ?? obj?.time;
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

export function kotakProvider(svc: SupabaseClient, s: KotakSettings): MarketProvider {
  const yahoo = yahooProvider(svc);
  // NSE regular session (IST 09:15–15:30, Mon–Fri). During this window we
  // MUST NOT quietly serve Yahoo (15-min delayed) prices in place of Kotak —
  // that turns a broker outage into silent bad ticks. Off-hours Yahoo is
  // still allowed for coverage of long history and instruments Kotak doesn't
  // carry (indices, obscure segments).
  const nseOpenNow = (now = new Date()): boolean => {
    const day = now.getUTCDay();
    if (day === 0 || day === 6) return false;
    const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    return utcMin >= 225 && utcMin <= 600;
  };
  return {
    name: "kotak_neo",
    async getQuotes(keys) {
      // Resolve instrument tokens from the cached market_stocks map; unresolved keys fall back to Yahoo per-symbol.
      const parsed = keys.map((k) => ({ key: k, ...parseKey(k) }));
      const tokenBySymbol = await getTokenMap(svc);
      const withToken = parsed.filter((p) => tokenBySymbol.has(`${p.exchange}:${p.symbol}`));
      const without = parsed.filter((p) => !tokenBySymbol.has(`${p.exchange}:${p.symbol}`));

      const out: QuoteRow[] = [];
      // Split batches by Kotak segment. One 500 on nse_indices used to fail
      // the equity batch too — a poll-wide collapse to 0 across the UI.
      if (withToken.length > 0) {
        const bySeg = new Map<string, typeof withToken>();
        for (const p of withToken) {
          const seg = tokenBySymbol.get(`${p.exchange}:${p.symbol}`)!.segment;
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
              tokenBySymbol.get(`${p.exchange}:${p.symbol}`)!;
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
              const rawToken = String(
                r?.tk ?? r?.token ?? r?.instrumentToken ?? r?.instrument_token ?? r?.pSymbol ?? "",
              ).trim();
              const segTok = rawNeoSymbol.match(/^([a-z]+_[a-z]+)\|(.+)$/i);
              if (segTok) {
                const normalized = `${segTok[1].toLowerCase()}|${segTok[2]}`;
                byNeoSymbol.set(normalized, r);
                byTokenOnly.set(String(segTok[2]), r);
              } else if (rawNeoSymbol) {
                byTokenOnly.set(rawNeoSymbol.includes("|") ? String(rawNeoSymbol.split("|").pop()) : rawNeoSymbol, r);
              }
              const tokenOnly = rawToken.includes("|") ? rawToken.split("|").pop() : rawToken;
              if (tokenOnly) byTokenOnly.set(String(tokenOnly), r);
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
              rows.push({
                key: p.key,
                price,
                previous_close: prevClose,
                change_abs: prevClose ? price - prevClose : null,
                change_pct: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
                volume: num(r.volume ?? r.vol_traded_today) || null,
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
        // Any Kotak-tokened symbol Kotak couldn't quote falls to Yahoo per-symbol
        // (source tagged "yahoo" so PriceSourceChip can show delayed if needed).
        const failedKeys = segResults.flatMap((r) => r.failed.map((p) => p.key));
        if (failedKeys.length > 0) {
          try { out.push(...(await yahoo.getQuotes(failedKeys))); }
          catch (e) { console.error("[market] yahoo per-symbol fallback failed:", e); }
        }
      }
      // Symbols with no Kotak token — always use Yahoo. Kotak-primary means
      // "use Yahoo only for coverage Kotak doesn't provide", which is exactly
      // this case (indices/products missing from Kotak's scrip master).
      const covered = new Set(out.map((o) => o.key));
      const remaining = without.map((p) => p.key).filter((k) => !covered.has(k));
      if (remaining.length > 0) {
        try { out.push(...(await yahoo.getQuotes(remaining))); }
        catch (e) { console.error("[market] yahoo coverage fallback failed:", e); }
      }
      return out;
    },
    // Kotak historical candles when we have an instrument token; else Yahoo.
    async getOHLCV(symbol, exchange, range, interval) {
      const { data: stock } = await svc
        .from("market_stocks").select("token,kotak_segment,instrument_type")
        .eq("symbol", symbol).eq("exchange", exchange)
        .not("token", "is", null).maybeSingle();
      const token = stock?.token as string | undefined;
      const isIndex = (stock?.instrument_type as string | undefined)?.toUpperCase() === "INDEX"
        || symbol.startsWith("^");
      // Indices live under nse_indices / bse_indices in Kotak's scrip master.
      // Falling through to nse_cm returned empty and forced Yahoo (delayed).
      const defaultSeg = isIndex
        ? (exchange === "BSE" ? "bse_indices" : "nse_indices")
        : (exchange === "BSE" ? "bse_cm" : "nse_cm");
      const seg = (stock?.kotak_segment as string | undefined) || defaultSeg;
      if (!token) {
        logProviderHealth(svc, "kotak_neo", "getOHLCV", false, 0, `no token for ${exchange}:${symbol} — using yahoo`);
        // Coverage gap Kotak's scrip master doesn't fill (mostly indices).
        // Yahoo is allowed here regardless of market state — it's the only
        // source we have.
        return yahoo.getOHLCV(symbol, exchange, range, interval);
      }
      // range like "2y","60d","30d"; interval like "1d","1h","15m"
      const now = Math.floor(Date.now() / 1000);
      const rangeSec: Record<string, number> = {
        "1d": 86400, "5d": 5 * 86400, "30d": 30 * 86400, "60d": 60 * 86400,
        "1y": 365 * 86400, "2y": 730 * 86400,
        // Previously missing — any caller requesting "5y"/"10y" (e.g. the
        // backtester) silently fell through to the `?? 730 * 86400` default
        // below and got capped at 2 years of Kotak candles with no error.
        "5y": 5 * 365 * 86400, "10y": 10 * 365 * 86400,
      };
      const fromEpoch = now - (rangeSec[range] ?? 730 * 86400);
      // Full Kotak interval map — the old fallthrough silently returned daily
      // bars for 1m / 3m / 30m / 2h / 4h / 1w / 1mo, so the UI showed the
      // wrong grain and volume looked "missing" on those TFs.
      const kotakIntervalMap: Record<string, string> = {
        "1m": "1", "2m": "1", "3m": "1", "5m": "5", "15m": "15", "30m": "30",
        "60m": "60", "1h": "60", "2h": "60", "4h": "60",
        "1d": "D", "1wk": "W", "1mo": "M",
      };
      const kotakInterval = kotakIntervalMap[interval] ?? "D";
      // Server-side resample buckets for TFs Kotak doesn't emit natively.
      const resampleFactor = interval === "2h" ? 2 : interval === "4h" ? 4 : interval === "3m" ? 3 : interval === "2m" ? 2 : 1;
      const t0 = Date.now();
      try {
        const raw = await withKotakSession(svc, s, encryptValue, (ss) => kotakCandles(ss, token, seg, fromEpoch, now, kotakInterval));
        if (raw.length === 0) {
          const reason = `empty candles for ${exchange}:${symbol} (seg=${seg})`;
          logProviderHealth(svc, "kotak_neo", "getOHLCV", false, Date.now() - t0, reason);
          const isIntraday = kotakInterval !== "D" && kotakInterval !== "W" && kotakInterval !== "M";
          // Intraday during market hours must NOT silently fall to Yahoo.
          // For daily/weekly/monthly, Yahoo backfill for missing long history
          // is still fine — that's data Kotak doesn't provide anyway.
          if (isIntraday && nseOpenNow()) throw new Error(`kotak returned no ${interval} candles`);
          return yahoo.getOHLCV(symbol, exchange, range, interval);
        }
        const c = resampleFactor > 1 ? resampleCandles(raw, resampleFactor) : raw;
        logProviderHealth(svc, "kotak_neo", "getOHLCV", true, Date.now() - t0);
        return c;
      } catch (e) {
        logProviderHealth(svc, "kotak_neo", "getOHLCV", false, Date.now() - t0, e instanceof Error ? e.message : String(e));
        const isIntraday = kotakInterval !== "D" && kotakInterval !== "W" && kotakInterval !== "M";
        // A 404 means the charts route isn't available on this session's
        // base URL (Kotak plan / route family), not a live-data failure —
        // Yahoo is the only source then, even intraday during market hours.
        const status = (e as { status?: number } | null)?.status;
        const routeMissing = status === 404;
        // Same rule as above: strict for live intraday, permissive for
        // historical/EOD tail-filling.
        if (isIntraday && nseOpenNow() && !routeMissing) throw e;
        return yahoo.getOHLCV(symbol, exchange, range, interval);
      }
    },

    async getDepth(symbol, exchange) {
      const { data: stock } = await svc
        .from("market_stocks").select("token,kotak_segment")
        .eq("symbol", symbol).eq("exchange", exchange)
        .not("token", "is", null).maybeSingle();
      const token = stock?.token as string | undefined;
      const seg = (stock?.kotak_segment as string | undefined) || (exchange === "BSE" ? "bse_cm" : "nse_cm");
      if (!token) return { bids: [], asks: [], ltp: null, source: "unavailable" };
      try {
        const d = await withKotakSession(svc, s, encryptValue, (ss) => kotakDepth(ss, token, seg));
        if (!d) return { bids: [], asks: [], ltp: null, source: "unavailable" };
        return { ...d, source: "kotak" };
      } catch {
        return { bids: [], asks: [], ltp: null, source: "unavailable" };
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
      // Kotak's /quick/user/limits is flaky for cash-only accounts. Try it
      // first; on failure, fall back to /quick/user/margin (used by Neo web)
      // before surfacing an error. The shared funds helper owns cooldown/
      // cached fallback so we don't multiply calls across Funds + syncs.
      let lastErr: unknown = null;
      try {
        const j = await withKotakSession(svc, s, encryptValue, (ss) => kotakLimits(ss));
        const parsed = parseKotakLimits(j);
        logProviderHealth(svc, "kotak_neo", "getFunds:limits", true, Date.now() - t0);
        return { ...parsed, source: "kotak" };
      } catch (e) {
        lastErr = e;
        const status = (e as any)?.status;
        // Don't try /margin when the session itself is dead.
        if (status !== 401 && status !== 403) {
          try {
            const j2 = await withKotakSession(svc, s, encryptValue, (ss) => kotakUserMargin(ss));
            const parsed = parseKotakLimits(j2);
            logProviderHealth(svc, "kotak_neo", "getFunds:margin", true, Date.now() - t0);
            return { ...parsed, source: "kotak" };
          } catch (e2) {
            lastErr = e2;
          }
        }
      }
      logProviderHealth(svc, "kotak_neo", "getFunds", false, Date.now() - t0, lastErr instanceof Error ? lastErr.message : String(lastErr));
      throw lastErr;
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

