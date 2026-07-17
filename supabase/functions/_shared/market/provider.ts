// Provider abstraction — the rest of the backend talks to this interface,
// never to a broker API directly. Active provider comes from market_api_settings.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { encryptStatementPassword } from "../crypto.ts";
import {
  KOTAK_SETTINGS_COLS,
  type KotakSettings,
  kotakHoldings,
  kotakLimits,
  kotakPositions,
  kotakQuotes,
  withKotakSession,
} from "./kotakClient.ts";
import { toYahooSymbol, yahooChartRetry, yahooQuote } from "./yahooClient.ts";
import type { Candle } from "./indicators.ts";

export interface QuoteRow {
  key: string; // "NSE:SYMBOL" as requested by the caller
  price: number;
  change_abs: number | null;
  change_pct: number | null;
  volume: number | null;
  source: "kotak" | "yahoo";
}

export interface HoldingRow {
  symbol: string;
  exchange: string;
  quantity: number;
  avg_price: number;
}

export interface PositionRow {
  symbol: string;
  exchange: string;
  side: "long" | "short";
  quantity: number;
  entry_price: number;
}

export interface MarketProvider {
  name: string;
  getQuotes(keys: string[]): Promise<QuoteRow[]>;
  getOHLCV(symbol: string, exchange: string, range: string, interval: string): Promise<Candle[]>;
  getHoldings(): Promise<HoldingRow[]>;
  getPositions(): Promise<PositionRow[]>;
  testAuth(): Promise<{ ok: boolean; detail?: string }>;
}

export const encryptValue = async (v: string): Promise<string> =>
  JSON.stringify(await encryptStatementPassword(v));

function parseKey(key: string): { exchange: string; symbol: string } {
  const [exchange, symbol] = key.includes(":") ? key.split(":") : ["NSE", key];
  return { exchange, symbol };
}

// ---------- Yahoo provider ----------

function yahooProvider(): MarketProvider {
  return {
    name: "yahoo",
    async getQuotes(keys) {
      const ySyms = keys.map((k) => {
        const { exchange, symbol } = parseKey(k);
        return toYahooSymbol(symbol, exchange);
      });
      const rows = await yahooQuote(ySyms);
      const byY = new Map(rows.map((r) => [r.symbol, r]));
      return keys.flatMap((k) => {
        const { exchange, symbol } = parseKey(k);
        const r = byY.get(toYahooSymbol(symbol, exchange));
        if (!r) return [];
        return [{
          key: k,
          price: r.price,
          change_abs: r.change_abs,
          change_pct: r.change_pct,
          volume: r.volume ?? null,
          source: "yahoo" as const,
        }];
      });
    },
    getOHLCV(symbol, exchange, range, interval) {
      return yahooChartRetry(toYahooSymbol(symbol, exchange), range, interval);
    },
    getHoldings() {
      return Promise.reject(new Error("Holdings sync requires a broker provider (Kotak Neo)."));
    },
    getPositions() {
      return Promise.reject(new Error("Positions sync requires a broker provider (Kotak Neo)."));
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

function kotakProvider(svc: SupabaseClient, s: KotakSettings): MarketProvider {
  const yahoo = yahooProvider();
  return {
    name: "kotak_neo",
    async getQuotes(keys) {
      // Resolve instrument tokens from market_stocks; unresolved keys fall back to Yahoo.
      const parsed = keys.map((k) => ({ key: k, ...parseKey(k) }));
      const nse = parsed.filter((p) => p.exchange === "NSE");
      const { data: stocks } = await svc
        .from("market_stocks")
        .select("symbol,token")
        .in("symbol", nse.map((p) => p.symbol))
        .eq("exchange", "NSE")
        .not("token", "is", null);
      const tokenBySymbol = new Map((stocks ?? []).map((r: any) => [r.symbol, r.token]));
      const withToken = parsed.filter((p) => tokenBySymbol.has(p.symbol) && p.exchange === "NSE");
      const without = parsed.filter((p) => !tokenBySymbol.has(p.symbol) || p.exchange !== "NSE");

      const out: QuoteRow[] = [];
      if (withToken.length > 0) {
        try {
          const neoSymbols = withToken.map((p) => `nse_cm|${tokenBySymbol.get(p.symbol)}`);
          const rows = await kotakQuotes(s, neoSymbols, "all");
          const byToken = new Map<string, any>();
          for (const r of rows) {
            const tok = String(r?.symbol ?? r?.tk ?? r?.instrumentToken ?? "").replace(/^nse_cm\|/, "");
            if (tok) byToken.set(tok, r);
          }
          for (const p of withToken) {
            const r = byToken.get(String(tokenBySymbol.get(p.symbol)));
            if (!r) continue;
            const price = num(r.last_traded_price ?? r.ltp ?? r.lastPrice);
            const prevClose = num(r.close ?? r.closing_price ?? r.prevClose);
            out.push({
              key: p.key,
              price,
              change_abs: prevClose ? price - prevClose : null,
              change_pct: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
              volume: num(r.volume ?? r.vol_traded_today) || null,
              source: "kotak",
            });
          }
        } catch {
          // whole Kotak quote batch failed — let Yahoo cover everything
          return yahoo.getQuotes(keys);
        }
      }
      const covered = new Set(out.map((o) => o.key));
      const remaining = [...without.map((p) => p.key), ...withToken.map((p) => p.key).filter((k) => !covered.has(k))];
      if (remaining.length > 0) out.push(...(await yahoo.getQuotes(remaining)));
      return out;
    },
    // Kotak Neo has no historical-candles REST endpoint — delegate to Yahoo.
    getOHLCV(symbol, exchange, range, interval) {
      return yahoo.getOHLCV(symbol, exchange, range, interval);
    },
    async getHoldings() {
      const raw = await withKotakSession(svc, s, encryptValue, (ss) => kotakHoldings(ss));
      return raw
        .map((h: any) => ({
          symbol: String(h.displaySymbol ?? h.symbol ?? h.trdSym ?? "").replace(/-EQ$/, ""),
          exchange: String(h.exchangeSegment ?? "nse_cm").startsWith("bse") ? "BSE" : "NSE",
          quantity: num(h.quantity ?? h.qty ?? h.holdingQty),
          avg_price: num(h.averagePrice ?? h.avgPrice ?? h.avgPrc),
        }))
        .filter((h: HoldingRow) => h.symbol && h.quantity > 0);
    },
    async getPositions() {
      const raw = await withKotakSession(svc, s, encryptValue, (ss) => kotakPositions(ss));
      return raw
        .map((p: any) => {
          const buyQty = num(p.flBuyQty ?? p.buyQty) + num(p.cfBuyQty);
          const sellQty = num(p.flSellQty ?? p.sellQty) + num(p.cfSellQty);
          const netQty = buyQty - sellQty;
          const buyAmt = num(p.buyAmt) + num(p.cfBuyAmt);
          const sellAmt = num(p.sellAmt) + num(p.cfSellAmt);
          const entry = netQty > 0 && buyQty > 0 ? buyAmt / buyQty : netQty < 0 && sellQty > 0 ? sellAmt / sellQty : 0;
          return {
            symbol: String(p.trdSym ?? p.sym ?? "").replace(/-EQ$/, ""),
            exchange: String(p.exSeg ?? "nse_cm").startsWith("bse") ? "BSE" : "NSE",
            side: (netQty >= 0 ? "long" : "short") as "long" | "short",
            quantity: Math.abs(netQty),
            entry_price: entry,
          };
        })
        .filter((p: PositionRow) => p.symbol && p.quantity > 0);
    },
    async testAuth() {
      const j = await withKotakSession(svc, s, encryptValue, (ss) => kotakLimits(ss));
      const ok = !!j && !j.errMsg;
      return { ok, detail: ok ? "Kotak session valid" : String(j?.errMsg ?? "limits call failed") };
    },
  };
}

// ---------- Resolution ----------

export interface ActiveProvider {
  provider: MarketProvider;
  settings: KotakSettings | null;
}

// Highest-priority connected provider for the user; falls back to Yahoo.
export async function getActiveProvider(
  svc: SupabaseClient,
  userId: string,
): Promise<ActiveProvider> {
  const { data } = await svc
    .from("market_api_settings")
    .select(KOTAK_SETTINGS_COLS + ",active_provider")
    .eq("user_id", userId);
  const rows = (data ?? []) as (KotakSettings & { active_provider: string })[];
  const kotak = rows.find((r) => r.active_provider === "kotak_neo" && r.connection_status === "connected");
  if (kotak) return { provider: kotakProvider(svc, kotak), settings: kotak };
  const kotakAny = rows.find((r) => r.active_provider === "kotak_neo" && r.totp_secret_enc);
  if (kotakAny) return { provider: kotakProvider(svc, kotakAny), settings: kotakAny };
  return { provider: yahooProvider(), settings: null };
}

// Service-level provider for cron jobs (no user context): first connected kotak row, else yahoo.
export async function getServiceProvider(svc: SupabaseClient): Promise<ActiveProvider> {
  const { data } = await svc
    .from("market_api_settings")
    .select(KOTAK_SETTINGS_COLS + ",active_provider")
    .eq("active_provider", "kotak_neo")
    .order("updated_at", { ascending: false })
    .limit(5);
  const rows = (data ?? []) as KotakSettings[];
  const usable = rows.find((r) => r.connection_status === "connected") ?? rows.find((r) => r.totp_secret_enc);
  if (usable) return { provider: kotakProvider(svc, usable), settings: usable };
  return { provider: yahooProvider(), settings: null };
}

export { yahooProvider };
