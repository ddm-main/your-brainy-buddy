import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { safeFetch } from "../http.ts";

const TT_HOSTS = ["api.tickertape.in"];
const TT_UA = "Mozilla/5.0 (Jarvis market parity)";

export type MetricKey =
  | "market_cap"
  | "pe"
  | "pb"
  | "eps"
  | "book_value"
  | "dividend_yield"
  | "roe"
  | "roce"
  | "debt_to_equity"
  | "high_52w"
  | "low_52w"
  | "price"
  | "volume";

export interface MarketRowForParity {
  symbol: string;
  exchange?: string | null;
  company_name?: string | null;
  tickertape_sid?: string | null;
  market_cap?: number | null;
  close?: number | null;
  pe_ttm?: number | null;
  pb?: number | null;
  eps_ttm?: number | null;
  book_value?: number | null;
  dividend_yield?: number | null;
  roe?: number | null;
  roce?: number | null;
  debt_to_equity?: number | null;
  high_52w?: number | null;
  low_52w?: number | null;
  volume?: number | null;
  data_provenance?: Record<string, unknown> | null;
}

export interface ProviderMetric {
  metric: MetricKey;
  value: number | null;
  provider: string;
  sourceMethod: string;
  confidence: number;
  providerAsOf?: string | null;
  status?: "ok" | "partial" | "stale" | "missing" | "error" | "rejected";
  unit?: string;
  rawPayload?: unknown;
  notes?: string | null;
}

export interface TickertapeMetrics {
  sid: string;
  raw: unknown;
  values: Partial<Record<MetricKey, number>>;
  providerAsOf: string;
}

const FIELD_OF: Record<MetricKey, keyof MarketRowForParity> = {
  market_cap: "market_cap",
  pe: "pe_ttm",
  pb: "pb",
  eps: "eps_ttm",
  book_value: "book_value",
  dividend_yield: "dividend_yield",
  roe: "roe",
  roce: "roce",
  debt_to_equity: "debt_to_equity",
  high_52w: "high_52w",
  low_52w: "low_52w",
  price: "close",
  volume: "volume",
};

export const AUDIT_THRESHOLDS: Partial<Record<MetricKey, number>> = {
  market_cap: 1,
  pe: 3,
  pb: 3,
  eps: 3,
  book_value: 3,
  dividend_yield: 5,
  roe: 3,
  roce: 3,
  debt_to_equity: 5,
  high_52w: 1,
  low_52w: 1,
  price: 0.5,
  volume: 5,
};

export function num(...values: unknown[]): number | null {
  for (const v of values) {
    if (v == null || v === "") continue;
    const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function deltaPct(ours: number | null, ref: number | null): number | null {
  if (ours == null || ref == null || !Number.isFinite(ours) || !Number.isFinite(ref) || ref === 0) return null;
  return ((ours - ref) / ref) * 100;
}

function getOurValue(row: MarketRowForParity, metric: MetricKey): number | null {
  return num(row[FIELD_OF[metric]]);
}

async function sha256(value: unknown): Promise<string> {
  const text = JSON.stringify(value ?? null);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchJson(url: string): Promise<unknown | null> {
  const r = await safeFetch(url, {
    timeoutMs: 9000,
    maxBytes: 512 * 1024,
    allowHosts: TT_HOSTS,
    headers: { "User-Agent": TT_UA, Accept: "application/json" },
  });
  if (!r.ok) return null;
  try { return JSON.parse(new TextDecoder().decode(r.bytes)); }
  catch { return null; }
}

function parseTickertapePayload(payload: any, sid: string): TickertapeMetrics | null {
  const data = payload?.data;
  const ratios = data?.ratios;
  if (!data || !ratios) return null;
  const values: Partial<Record<MetricKey, number>> = {};
  const assign = (metric: MetricKey, ...candidates: unknown[]) => {
    const n = num(...candidates);
    if (n != null) values[metric] = n;
  };
  assign("market_cap", ratios.marketCap, ratios.mrktCapf);
  assign("pe", ratios.ttmPe, ratios.pe, ratios.apef);
  assign("pb", ratios.pb, ratios.pbr);
  assign("eps", ratios.eps);
  assign("book_value", ratios.bps);
  assign("dividend_yield", ratios.divYield);
  assign("roe", ratios.roe);
  assign("roce", ratios.roce);
  assign("debt_to_equity", ratios.dte);
  assign("high_52w", ratios["52wHigh"]);
  assign("low_52w", ratios["52wLow"]);
  assign("price", ratios.lastPrice, data?.price?.close);
  assign("volume", ratios["3mAvgVol"]);
  return { sid: String(data?.sid ?? sid), raw: payload, values, providerAsOf: new Date().toISOString() };
}

async function searchTickertapeSid(row: MarketRowForParity): Promise<string | null> {
  const terms = [row.symbol, row.company_name].filter((v): v is string => Boolean(v && v.trim()));
  for (const term of terms) {
    const payload = await fetchJson(`https://api.tickertape.in/stocks/search?text=${encodeURIComponent(term)}`) as any;
    const results: any[] = payload?.data?.searchResults ?? [];
    const exact = results.find((r) => {
      const info = r?.stock?.info;
      return info?.ticker === row.symbol && (!row.exchange || info?.exchange === row.exchange);
    }) ?? results.find((r) => r?.stock?.info?.ticker === row.symbol) ?? results[0];
    if (exact?.sid) return String(exact.sid);
  }
  return null;
}

export async function fetchTickertapeMetrics(
  row: MarketRowForParity,
  svc?: SupabaseClient,
): Promise<TickertapeMetrics | null> {
  const candidates = [row.tickertape_sid, row.symbol].filter((v): v is string => Boolean(v && v.trim()));
  for (const sid of candidates) {
    const payload = await fetchJson(`https://api.tickertape.in/stocks/info/${encodeURIComponent(sid)}`);
    const parsed = parseTickertapePayload(payload, sid);
    if (parsed) {
      if (svc && parsed.sid !== row.tickertape_sid) await persistTickertapeSid(svc, row, parsed.sid);
      return parsed;
    }
  }
  const found = await searchTickertapeSid(row);
  if (!found) return null;
  const payload = await fetchJson(`https://api.tickertape.in/stocks/info/${encodeURIComponent(found)}`);
  const parsed = parseTickertapePayload(payload, found);
  if (parsed && svc) await persistTickertapeSid(svc, row, parsed.sid);
  return parsed;
}

async function persistTickertapeSid(svc: SupabaseClient, row: MarketRowForParity, sid: string) {
  await svc.from("market_stocks").update({
    tickertape_sid: sid,
    tickertape_sid_as_of: new Date().toISOString(),
  }).eq("symbol", row.symbol).eq("exchange", row.exchange ?? "NSE");
}

export async function writeProviderObservations(
  svc: SupabaseClient,
  symbol: string,
  exchange: string,
  metrics: ProviderMetric[],
) {
  const now = new Date().toISOString();
  const rows = [];
  for (const m of metrics) {
    rows.push({
      symbol,
      exchange,
      metric: m.metric,
      provider: m.provider,
      value: m.value,
      unit: m.unit ?? null,
      provider_as_of: m.providerAsOf ?? now,
      fetched_at: now,
      confidence: Math.max(0, Math.min(1, m.confidence)),
      status: m.status ?? (m.value == null ? "missing" : "ok"),
      source_method: m.sourceMethod,
      raw_payload_hash: m.rawPayload ? await sha256(m.rawPayload) : null,
      raw_payload: m.rawPayload ?? null,
      notes: m.notes ?? null,
    });
  }
  if (rows.length > 0) await svc.from("market_provider_observations").insert(rows);
}

export async function persistTickertapeParity(
  svc: SupabaseClient,
  row: MarketRowForParity,
  tt: TickertapeMetrics,
  runId?: string | null,
): Promise<{ auditRows: number; mismatches: number; consensusRows: number }> {
  const exchange = row.exchange ?? "NSE";
  const observed: ProviderMetric[] = Object.entries(tt.values).map(([metric, value]) => ({
    metric: metric as MetricKey,
    value: value as number,
    provider: "tickertape",
    sourceMethod: "stocks_info_ratios",
    confidence: metric === "market_cap" ? 0.99 : 0.95,
    providerAsOf: tt.providerAsOf,
    rawPayload: metric === "market_cap" ? tt.raw : undefined,
  }));
  await writeProviderObservations(svc, row.symbol, exchange, observed);

  const consensus = Object.entries(tt.values).map(([metric, value]) => {
    const k = metric as MetricKey;
    const ours = getOurValue(row, k);
    const d = deltaPct(ours, value as number);
    const threshold = AUDIT_THRESHOLDS[k] ?? 3;
    return {
      symbol: row.symbol,
      exchange,
      metric: k,
      value: value as number,
      unit: k === "market_cap" ? "Cr" : k === "price" ? "₹" : k === "volume" ? "shares" : null,
      source_provider: "tickertape",
      source_method: "reference_ratios",
      confidence: k === "market_cap" ? 0.99 : 0.95,
      ref_value: value as number,
      delta_pct: d,
      status: d != null && Math.abs(d) > threshold ? "mismatch" : "ok",
      provider_as_of: tt.providerAsOf,
      computed_at: new Date().toISOString(),
      notes: `tickertape_sid=${tt.sid}`,
    };
  });
  if (consensus.length > 0) {
    await svc.from("market_metric_consensus").upsert(consensus, { onConflict: "symbol,exchange,metric" });
  }

  const audits = Object.entries(tt.values).map(([metric, ref]) => {
    const k = metric as MetricKey;
    const ours = getOurValue(row, k);
    const d = deltaPct(ours, ref as number);
    const threshold = AUDIT_THRESHOLDS[k] ?? 3;
    const status = d == null ? "missing_ours" : Math.abs(d) > threshold ? "mismatch" : "ok";
    return {
      run_id: runId ?? null,
      symbol: row.symbol,
      exchange,
      field: k,
      our_value: ours,
      ref_value: ref as number,
      ref_source: "tickertape",
      delta_pct: d,
      checked_at: new Date().toISOString(),
      source_provider: "tickertape",
      source_method: "stocks_info_ratios",
      status,
      threshold_pct: threshold,
      remediation: status === "mismatch" ? "consensus updated from Tickertape reference; review upstream provider drift" : null,
      metadata: { tickertape_sid: tt.sid },
    };
  });
  if (audits.length > 0) await svc.from("market_value_audit").insert(audits);
  return {
    auditRows: audits.length,
    mismatches: audits.filter((a) => a.status === "mismatch").length,
    consensusRows: consensus.length,
  };
}

export async function seedComputedMarketCapConsensus(
  svc: SupabaseClient,
  row: MarketRowForParity,
  marketCap: number | null,
  sourceProvider: string,
  sourceMethod: string,
  confidence = 0.82,
) {
  if (marketCap == null || !Number.isFinite(marketCap) || marketCap <= 0) return;
  const exchange = row.exchange ?? "NSE";
  await writeProviderObservations(svc, row.symbol, exchange, [{
    metric: "market_cap",
    value: marketCap,
    provider: sourceProvider,
    sourceMethod,
    confidence,
    providerAsOf: new Date().toISOString(),
    unit: "Cr",
  }]);
  await svc.from("market_metric_consensus").upsert({
    symbol: row.symbol,
    exchange,
    metric: "market_cap",
    value: marketCap,
    unit: "Cr",
    source_provider: sourceProvider,
    source_method: sourceMethod,
    confidence,
    status: confidence >= 0.9 ? "ok" : "estimated",
    provider_as_of: new Date().toISOString(),
    computed_at: new Date().toISOString(),
    notes: "computed fallback until Tickertape parity refresh confirms reference value",
  }, { onConflict: "symbol,exchange,metric" });
}