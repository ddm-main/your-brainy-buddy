// Shared provider/feed self-test used by market-test-connection (single
// provider, on demand) and market-selftest (all providers, on demand or from
// pg_cron). Everything that writes status lives here so the UI reads one
// consistent story no matter who ran the probe.
import { getActiveProvider, kotakProvider, yahooProvider, type OhlcvMeta } from "./provider.ts";
import { KOTAK_SETTINGS_COLS, type KotakSettings } from "./kotakClient.ts";
import { fmpValidateKey } from "./fmpClient.ts";
import { alphaValidateKey } from "./alphaVantageClient.ts";
import { nseMarketStatus } from "./nseClient.ts";
import { bseCirculars } from "./bseClient.ts";

// deno-lint-ignore no-explicit-any
type Svc = any;

export type SurfaceState = "ok" | "degraded" | "failed";
export interface SurfaceResult {
  ok: boolean;
  state: SurfaceState;
  provider_used: string;
  detail: string;
  checked_at: string;
}

export const SERVICE_SURFACES: Record<string, string[]> = {
  nse: ["candles_1d", "bhavcopy", "constituents", "corp_actions"],
  fmp: ["fundamentals", "company_info", "shares"],
  alpha_vantage: ["indicators"],
  bse: ["corp_actions"],
};

/**
 * Capability matrix. A provider that cannot serve a surface must never be
 * probed for it — a permanent, meaningless failure (Yahoo has no funds
 * endpoint) is worse than no row at all: it poisons the health tally.
 */
export const PROVIDER_SURFACES: Record<string, string[]> = {
  kotak_neo: ["quotes", "index_quotes", "depth", "funds", "holdings", "positions"],
  yahoo: ["quotes", "index_quotes", "candles_1d", "candles_index_1d", "candles_intraday"],
};

export function supportsSurface(provider: string, surface: string): boolean {
  const caps = PROVIDER_SURFACES[canonicalProvider(provider)];
  return caps ? caps.includes(surface) : true;
}

/** Default primary route per surface — mirrors the client feed catalog chains. */
export const PRIMARY_BY_SURFACE: Record<string, string> = {
  quotes: "kotak_neo",
  index_quotes: "kotak_neo",
  depth: "kotak_neo",
  funds: "kotak_neo",
  holdings: "kotak_neo",
  positions: "kotak_neo",
  candles_1d: "yahoo",
  candles_index_1d: "yahoo",
  candles_intraday: "yahoo",
  bhavcopy: "nse",
  constituents: "nse",
  corp_actions: "nse",
  fundamentals: "fmp",
  company_info: "fmp",
  shares: "fmp",
  indicators: "alpha_vantage",
};


/** One id per provider everywhere — the probe payloads use both spellings. */
export function canonicalProvider(name: string): string {
  const n = (name || "").toLowerCase();
  if (n.includes("kotak")) return "kotak_neo";
  if (n.includes("yahoo")) return "yahoo";
  if (n.includes("alpha")) return "alpha_vantage";
  if (n.includes("fmp") || n.includes("modeling")) return "fmp";
  if (n.includes("nse")) return "nse";
  if (n.includes("bse")) return "bse";
  return n || "unknown";
}

/** Providers that own an API key row we can stamp with the last result. */
const KEYED_PROVIDERS = ["fmp", "alpha_vantage"];


export async function recordProviderProbe(
  svc: Svc,
  provider: string,
  ok: boolean,
  detail: string | null,
  latencyMs: number,
) {
  const now = new Date().toISOString();
  const writes = await Promise.allSettled([
    KEYED_PROVIDERS.includes(provider)
      ? svc.from("market_provider_credentials").update({
        last_tested_at: now,
        last_test_ok: ok,
        last_test_detail: detail,
      }).eq("provider", provider)
      : Promise.resolve(null),
    svc.from("market_provider_health").insert({
      provider,
      endpoint: "market-test-connection",
      ok,
      latency_ms: latencyMs,
      error: ok ? null : detail,
    }),
  ]);
  // A silently-failing status write makes the whole panel lie; make it loud.
  for (const w of writes) {
    if (w.status === "rejected") console.error("probe status write failed", provider, w.reason);
    else if (w.value && (w.value as { error?: unknown }).error) {
      console.error("probe status write error", provider, (w.value as { error?: unknown }).error);
    }
  }
}

/** Persist surface probe results so status survives a reload / a closed tab.
 *  `is_primary_path` records whether the feed's default primary answered, so
 *  the UI can tell "the feed works" apart from "my chosen route works". */
export async function recordSurfaceProbes(
  svc: Svc,
  surfaces: Record<string, SurfaceResult>,
  latencyMs?: number,
) {
  const rows = Object.entries(surfaces)
    .filter(([surface, r]) => supportsSurface(r.provider_used, surface))
    .map(([surface, r]) => {
      const provider = canonicalProvider(r.provider_used || "unknown");
      return {
        surface,
        provider,
        ok: r.ok,
        state: r.state,
        detail: r.detail?.slice(0, 500) ?? null,
        latency_ms: latencyMs ?? null,
        checked_at: r.checked_at,
        is_primary_path: (PRIMARY_BY_SURFACE[surface] ?? provider) === provider,
        supported: true,
        updated_at: new Date().toISOString(),
      };
    });
  if (rows.length === 0) return;
  const { error } = await svc.from("market_surface_probes")
    .upsert(rows, { onConflict: "surface,provider" });
  if (error) console.error("surface probe write failed", error);
}

export async function probeService(provider: string): Promise<{ ok: boolean; detail: string | null }> {
  switch (provider) {
    case "fmp":
      return await fmpValidateKey({ forceRefresh: true });
    case "alpha_vantage":
      return await alphaValidateKey({ forceRefresh: true });
    case "nse": {
      const rows = await nseMarketStatus();
      return rows.length > 0
        ? { ok: true, detail: `NSE reachable — ${rows[0].market}: ${rows[0].status}` }
        : { ok: false, detail: "NSE unreachable (public endpoint blocked or cookie handshake failed)" };
    }
    case "bse": {
      const rows = await bseCirculars();
      return { ok: true, detail: `BSE reachable — ${rows.length} recent circulars` };
    }
    default:
      return { ok: false, detail: "Provider connector is not enabled" };
  }
}

// Per-surface probe. `which` selects whose feeds are being audited so the
// provider detail page probes the provider you actually opened.
// `provider_used` is read off the payload the probe got back, not the
// provider's own name, so a Kotak→Yahoo fallback is reported honestly.
export async function surfaceReport(
  svc: Svc,
  userId: string,
  which: "active" | "kotak_neo" | "yahoo" = "active",
): Promise<Record<string, SurfaceResult>> {
  let provider;
  if (which === "yahoo") {
    provider = yahooProvider(svc);
  } else if (which === "kotak_neo") {
    const { data } = await svc.from("market_api_settings").select(KOTAK_SETTINGS_COLS)
      .eq("user_id", userId);
    const candidates = (data ?? []) as KotakSettings[];
    const row = candidates.find((r) => !!r.session_token_enc && !!r.sid)
      ?? candidates.find((r) => !!r.totp_secret_enc)
      ?? candidates[0];
    provider = row ? kotakProvider(svc, row) : yahooProvider(svc);
  } else {
    provider = (await getActiveProvider(svc, userId)).provider;
  }

  const wrap = async (fn: () => Promise<{ detail: string; source?: string }>): Promise<SurfaceResult> => {
    const checked_at = new Date().toISOString();
    try {
      const r = await fn();
      const source = r.source ?? provider.name;
      const fellBack = which === "kotak_neo" && source !== "kotak" && source !== "kotak_neo";
      return { ok: true, state: fellBack ? "degraded" : "ok", provider_used: source, detail: r.detail, checked_at };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Broker load-shedding / throttling is transient, not a dead feed.
      const transient = /\b(503|429|502|504)\b|no available server|timeout|no bid\/ask levels/i.test(msg);
      return {
        ok: false,
        state: transient ? "degraded" : "failed",
        provider_used: provider.name,
        detail: msg,
        checked_at,
      };
    }
  };

  // A provider is only judged on the surfaces it actually serves: Yahoo has no
  // funds/holdings/depth endpoint, Kotak publishes no candle API. Unsupported
  // combinations are never called and never stored.
  const owner = which === "active" ? canonicalProvider(provider.name) : which;
  const probes: Record<string, () => Promise<{ detail: string; source?: string }>> = {
    quotes: async () => {
      const rows = await provider.getQuotes(["NSE:RELIANCE"], { allowFallback: which !== "kotak_neo" });
      if (!rows.length) throw new Error("no rows");
      return { detail: `ltp=${rows[0].price}`, source: rows[0].source };
    },
    index_quotes: async () => {
      const rows = await provider.getQuotes(["NSE:^NSEI"], { allowFallback: which !== "kotak_neo" });
      if (!rows.length) throw new Error("no index rows");
      return { detail: `Nifty 50 ltp=${rows[0].price}`, source: rows[0].source };
    },
    depth: async () => {
      const d = await provider.getDepth("RELIANCE", "NSE");
      // An empty ladder is not a working depth feed — the endpoint answered
      // but the surface is dead (off-session that is expected, so it is
      // classified transient/degraded rather than failed).
      if (Math.min(d.bids.length, d.asks.length) === 0) throw new Error("depth returned no bid/ask levels");
      return { detail: `bids=${d.bids.length} asks=${d.asks.length}`, source: d.source };
    },
    candles_1d: async () => {
      const meta: OhlcvMeta = {};
      const c = await provider.getOHLCV("RELIANCE", "NSE", "5d", "1d", meta);
      if (!c.length) throw new Error("no daily bars");
      return { detail: `${c.length} daily bars (RELIANCE)`, source: meta.source };
    },
    candles_index_1d: async () => {
      const meta: OhlcvMeta = {};
      const c = await provider.getOHLCV("^NSEI", "NSE", "5d", "1d", meta);
      if (!c.length) throw new Error("no index bars");
      return { detail: `${c.length} daily bars (NIFTY 50)`, source: meta.source };
    },
    candles_intraday: async () => {
      const meta: OhlcvMeta = {};
      const c = await provider.getOHLCV("RELIANCE", "NSE", "5d", "15m", meta);
      if (!c.length) throw new Error("no intraday bars");
      return { detail: `${c.length} 15m bars`, source: meta.source };
    },
    funds: async () => {
      const f = await provider.getFunds();
      if (f.source === "unavailable") throw new Error("funds not exposed by provider");
      return { detail: `available=${f.available_margin} used=${f.used_margin}`, source: f.source };
    },
    holdings: async () => {
      const h = await provider.getHoldings();
      return { detail: `${h.length} holdings` };
    },
    positions: async () => {
      const p = await provider.getPositions();
      return { detail: `${p.length} positions` };
    },
  };

  const keys = Object.keys(probes).filter((s) => supportsSurface(owner, s));
  const results = await Promise.all(keys.map((k) => wrap(probes[k])));
  return Object.fromEntries(keys.map((k, i) => [k, results[i]]));
}

export interface SelfTestReport {
  ran_at: string;
  providers: Record<string, { ok: boolean; detail: string | null; latency_ms: number }>;
  surfaces: Record<string, SurfaceResult>;
  down: number;
  degraded: number;
}

/**
 * One pass over every provider and every surface. Used by the "test
 * everything" button and by the pg_cron schedule. `skipKeyed` drops the
 * rate-limited key providers (FMP / Alpha) from a high-frequency run.
 */
export async function runSelfTest(
  svc: Svc,
  userId: string,
  opts: { skipKeyed?: boolean } = {},
): Promise<SelfTestReport> {
  const ran_at = new Date().toISOString();
  const serviceProviders = (opts.skipKeyed ? ["nse", "bse"] : ["fmp", "alpha_vantage", "nse", "bse"]);

  const providers: SelfTestReport["providers"] = {};
  const surfaces: Record<string, SurfaceResult> = {};

  const serviceRuns = serviceProviders.map(async (p) => {
    const started = Date.now();
    const r = await probeService(p).catch((e) => ({
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    }));
    const latency = Date.now() - started;
    providers[p] = { ok: r.ok, detail: r.detail ?? null, latency_ms: latency };
    await recordProviderProbe(svc, p, r.ok, r.detail ?? null, latency);
    const checked_at = new Date().toISOString();
    const mapped: Record<string, SurfaceResult> = {};
    for (const key of SERVICE_SURFACES[p] ?? []) {
      mapped[key] = {
        ok: r.ok,
        state: r.ok ? "ok" : "failed",
        provider_used: p,
        detail: r.detail ?? "",
        checked_at,
      };
    }
    await recordSurfaceProbes(svc, mapped, latency);
    Object.assign(surfaces, mapped);
  });

  const brokerRun = (async () => {
    // Sequential, not concurrent: the merge below decides which provider owns
    // a surface, and a race made that order (and therefore the UI) random.
    const kStart = Date.now();
    const kotak = await surfaceReport(svc, userId, "kotak_neo").catch(() => ({} as Record<string, SurfaceResult>));
    const kLatency = Date.now() - kStart;
    const kKeys = Object.keys(kotak);
    const kOkCount = kKeys.filter((k) => kotak[k].ok).length;
    const kOk = kOkCount > 0;
    const kDetail = kKeys.length ? `${kOkCount}/${kKeys.length} surfaces answered` : "Kotak Neo probe returned nothing";
    providers["kotak_neo"] = { ok: kOk, detail: kDetail, latency_ms: kLatency };
    await recordProviderProbe(svc, "kotak_neo", kOk, kDetail, kLatency);
    await recordSurfaceProbes(svc, kotak, kLatency);
    Object.assign(surfaces, kotak);

    const yStart = Date.now();
    const yahoo = await surfaceReport(svc, userId, "yahoo").catch(() => ({} as Record<string, SurfaceResult>));
    const yLatency = Date.now() - yStart;
    const yKeys = Object.keys(yahoo);
    const yOkCount = yKeys.filter((k) => yahoo[k].ok).length;
    const yOk = yOkCount > 0;
    providers["yahoo"] = { ok: yOk, detail: `${yOkCount}/${yKeys.length} surfaces answered`, latency_ms: yLatency };
    await recordProviderProbe(svc, "yahoo", yOk, yOk ? null : "Yahoo probe returned nothing", yLatency);
    await recordSurfaceProbes(svc, yahoo, yLatency);
    // Yahoo only fills surfaces the primary could not answer.
    for (const [k, v] of Object.entries(yahoo)) if (!surfaces[k]?.ok) surfaces[k] = v;
  })();


  await Promise.allSettled([...serviceRuns, brokerRun]);

  const values = Object.values(providers);
  return {
    ran_at,
    providers,
    surfaces,
    down: values.filter((v) => !v.ok).length,
    degraded: Object.values(surfaces).filter((s) => s.state === "degraded").length,
  };
}


/**
 * Retention for the status tables the self-test writes to. The 10-minute
 * in-session cadence inserts a health row per provider per run, which is
 * ~1k rows/day — cheap to write, expensive to keep forever.
 */
export async function pruneProbeHistory(svc: Svc, keepDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
  const { error, count } = await svc.from("market_provider_health")
    .delete({ count: "exact" })
    .lt("created_at", cutoff)
    .eq("endpoint", "market-test-connection");
  if (error) { console.error("probe history prune failed", error); return 0; }
  return count ?? 0;
}
