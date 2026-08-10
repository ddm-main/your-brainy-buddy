// Shared provider/feed self-test used by market-test-connection (single
// provider, on demand) and market-selftest (all providers, on demand or from
// pg_cron). Everything that writes status lives here so the UI reads one
// consistent story no matter who ran the probe.
import { getActiveProvider, kotakProvider, yahooProvider, type OhlcvMeta } from "./provider.ts";
import { KOTAK_SETTINGS_COLS, type KotakSettings } from "./kotakClient.ts";
import { fmpValidateKey, fmpProfile, fmpRatios } from "./fmpClient.ts";
import { alphaValidateKey, alphaRSI } from "./alphaVantageClient.ts";
import { nseMarketStatus, nseCorporateActions, nseEquityMeta } from "./nseClient.ts";
import { fetchCsvMembers, SLUG_TO_FILE } from "./indexConstituents.ts";
import { bseCirculars } from "./bseClient.ts";
import { refreshFundsSnapshot } from "./funds.ts";

// deno-lint-ignore no-explicit-any
type Svc = any;

// "not_configured" is NOT a failure: a broker with no credentials, or a key
// provider with no key, has nothing to be healthy about. Counting it as an
// outage is what made the page show a wall of red for a broker nobody
// authorized.
export type SurfaceState = "ok" | "degraded" | "failed" | "not_configured";
export interface SurfaceResult {
  ok: boolean;
  state: SurfaceState;
  provider_used: string;
  detail: string;
  checked_at: string;
  /** Latency of THIS surface's own call — not the whole provider run. */
  latency_ms?: number | null;
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
/** A session worth spending a probe on: anything but a dead/absent one. */
export const probeableSession = (status: string | null | undefined): boolean =>
  status !== "expired" && status !== "disconnected" && status !== "error" && status !== null;

export const PROVIDER_SURFACES: Record<string, string[]> = {
  // Kotak Neo has no index instrument in its quote API (NSE:^NSEI always comes
  // back empty) and no candle API — both are Yahoo-served by design, so they
  // are not probed here. Probing them produced a permanent "IDX DOWN".
  kotak_neo: ["quotes", "depth", "funds", "holdings", "positions"],
  yahoo: ["quotes", "index_quotes", "candles_1d", "candles_index_1d", "candles_intraday"],
};


export function supportsSurface(provider: string, surface: string): boolean {
  const caps = PROVIDER_SURFACES[canonicalProvider(provider)];
  return caps ? caps.includes(surface) : true;
}

/** Default primary route per surface — mirrors the client feed catalog chains. */
export const PRIMARY_BY_SURFACE: Record<string, string> = {
  quotes: "kotak_neo",
  // Indices are Yahoo's job — the broker quote API carries no index tokens.
  index_quotes: "yahoo",

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

/** Surfaces that describe ONE broker account, not the shared market-data feed.
 *  They are probed against the user's `purpose='account'` connection and stored
 *  under plane='account' so a personal broker problem never reads as a
 *  platform-wide feed outage (and never shows up on the admin feed page). */
export const ACCOUNT_SURFACES = ["funds", "holdings", "positions"];
export type ProbePlane = "data" | "account";
export const isAccountSurface = (s: string) => ACCOUNT_SURFACES.includes(s);

/** Persist surface probe results so status survives a reload / a closed tab.
 *  `is_primary_path` records whether the feed's default primary answered, so
 *  the UI can tell "the feed works" apart from "my chosen route works". */
export async function recordSurfaceProbes(
  svc: Svc,
  surfaces: Record<string, SurfaceResult>,
  latencyMs?: number,
  plane: ProbePlane = "data",
) {
  const rows = Object.entries(surfaces)
    .filter(([surface, r]) => supportsSurface(r.provider_used, surface))
    .map(([surface, r]) => {
      const provider = canonicalProvider(r.provider_used || "unknown");
      return {
        surface,
        provider,
        // Account surfaces are always account-plane, whatever the caller says —
        // one mislabelled write is enough to put a broker failure back on the
        // shared feed health tally.
        plane: isAccountSurface(surface) ? "account" : plane,
        ok: r.ok,
        state: r.state,
        detail: r.detail?.slice(0, 500) ?? null,
        // Per-surface timing when the probe measured it; the whole-run latency
        // only as a last resort. Stamping the run latency on every surface (the
        // old behaviour) made "which provider is fastest for this feed"
        // unanswerable — every Kotak surface carried the same number.
        latency_ms: r.latency_ms ?? latencyMs ?? null,
        checked_at: r.checked_at,
        is_primary_path: (PRIMARY_BY_SURFACE[surface] ?? provider) === provider,
        supported: true,
        updated_at: new Date().toISOString(),
      };
    });
  if (rows.length === 0) return;
  const { error } = await svc.from("market_surface_probes")
    .upsert(rows, { onConflict: "surface,provider,plane" });
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

/**
 * Per-surface assertion for the keyless / keyed *service* providers. The old
 * code proved one endpoint ("is the vendor reachable?") and copied that single
 * verdict onto every surface the vendor owns, so a vendor whose ratios endpoint
 * was dead still reported "fundamentals ok". Each surface now runs its own
 * cheap call; on failure the surface — and only that surface — goes red.
 */
export async function probeServiceSurfaces(
  provider: string,
  base: { ok: boolean; detail: string | null },
  svc?: Svc,
): Promise<Record<string, { ok: boolean; detail: string; degraded?: boolean }>> {
  const out: Record<string, { ok: boolean; detail: string; degraded?: boolean }> = {};
  const surfaces = SERVICE_SURFACES[provider] ?? [];
  // Vendor unreachable at all — no point spending calls per surface.
  if (!base.ok) {
    for (const s of surfaces) out[s] = { ok: false, detail: base.detail ?? "provider unreachable" };
    return out;
  }

  // A probe may answer "working, but on the fallback path" by returning
  // { detail, degraded: true } instead of a bare string.
  const run = async (surface: string, fn: () => Promise<string | { detail: string; degraded?: boolean }>) => {
    try {
      const r = await fn();
      out[surface] = typeof r === "string" ? { ok: true, detail: r } : { ok: true, detail: r.detail, degraded: r.degraded };
    }
    catch (e) { out[surface] = { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
  };

  if (provider === "fmp") {
    await run("company_info", async () => {
      const p = await fmpProfile("RELIANCE");
      if (!p) throw new Error("FMP profile returned nothing for RELIANCE");
      return `profile ok — ${p.company_name ?? "RELIANCE"}`;
    });
    await run("shares", async () => {
      const p = await fmpProfile("RELIANCE");
      if (!p) throw new Error("FMP profile returned nothing for RELIANCE");
      if (p.shares_outstanding == null) throw new Error("FMP profile has no shares-outstanding figure");
      return `shares outstanding ${p.shares_outstanding} Cr`;
    });
    await run("fundamentals", async () => {
      const r = await fmpRatios("RELIANCE");
      if (!r) throw new Error("FMP ratios returned nothing for RELIANCE");
      return `ratios ok — pe=${r.pe ?? "n/a"}`;
    });
    return out;
  }

  if (provider === "alpha_vantage") {
    await run("indicators", async () => {
      const rsi = await alphaRSI("RELIANCE");
      if (rsi == null) throw new Error("Alpha Vantage returned no RSI (rate limit or dead key)");
      return `RSI(14) = ${rsi}`;
    });
    return out;
  }

  if (provider === "nse") {
    // Previously both of these were hard-coded to ok off the generic
    // reachability check, so a dead bhavcopy pipeline still reported green.
    await run("bhavcopy", async () => {
      if (!svc) throw new Error("bhavcopy freshness needs a database client");
      const { data, error } = await svc.from("market_eod_nse")
        .select("trade_date").order("trade_date", { ascending: false }).limit(1);
      if (error) throw new Error(`bhavcopy table read failed: ${error.message}`);
      const last = (data ?? [])[0]?.trade_date as string | undefined;
      if (!last) throw new Error("no bhavcopy rows stored");
      const ageDays = Math.floor((Date.now() - new Date(`${last}T00:00:00Z`).getTime()) / 86_400_000);
      // Weekend + a holiday can legitimately be 4 days; beyond that it is stale.
      if (ageDays > 4) throw new Error(`bhavcopy stale — last session stored is ${last} (${ageDays}d old)`);
      return `bhavcopy current — ${last}`;
    });
    await run("candles_1d", async () => {
      const meta = await nseEquityMeta("RELIANCE");
      if (!meta) throw new Error("NSE quote-equity returned nothing for RELIANCE");
      return "NSE quote-equity ok (RELIANCE)";
    });
    // Probe the path the app actually uses: the niftyindices CSV (NSE archives
    // mirror as fallback). The old probe called NSE's api/equity-stockIndices,
    // which is IP-blocked server-side — it reported DOWN for a feed that works.
    await run("constituents", async () => {
      const { members, source } = await fetchCsvMembers(SLUG_TO_FILE.nifty50);
      if (members.length > 0) return `${members.length} Nifty 50 constituents (${source})`;
      // Both mirrors unreachable right now — a recent stored list still keeps
      // every consumer working, so that is degraded, not down.
      if (!svc) throw new Error("index constituent CSV mirrors unreachable");
      const { data } = await svc.from("market_index_members")
        .select("symbol,updated_at").eq("index_key", "NIFTY50");
      const rows = (data ?? []) as Array<{ updated_at: string | null }>;
      if (rows.length === 0) throw new Error("index constituent CSV mirrors unreachable and no stored list");
      const newest = rows.reduce((m, r) => Math.max(m, r.updated_at ? new Date(r.updated_at).getTime() : 0), 0);
      const ageDays = newest ? Math.floor((Date.now() - newest) / 86_400_000) : null;
      if (ageDays != null && ageDays > 30) {
        throw new Error(`CSV mirrors unreachable and stored list is ${ageDays}d old`);
      }
      return {
        detail: `stored list — ${rows.length} members${ageDays != null ? `, refreshed ${ageDays}d ago` : ""}`,
        degraded: true,
      };
    });
    await run("corp_actions", async () => {
      const rows = await nseCorporateActions("RELIANCE");
      return `${rows.length} corporate actions (RELIANCE)`;
    });
    return out;
  }

  for (const s of surfaces) out[s] = { ok: true, detail: base.detail ?? "reachable" };
  return out;
}


// Per-surface probe. `which` selects whose feeds are being audited so the
// provider detail page probes the provider you actually opened.
// `provider_used` is read off the payload the probe got back, not the
// provider's own name, so a Kotak→Yahoo fallback is reported honestly.
export async function surfaceReport(
  svc: Svc,
  userId: string,
  which: "active" | "kotak_neo" | "yahoo" = "active",
  purpose: "account" | "data" = "account",
  /** Which plane of surfaces to probe: shared market data, the broker account,
   *  or both. Account surfaces must only ever be probed on an account row. */
  scope: "data" | "account" | "all" = "all",
): Promise<Record<string, SurfaceResult>> {

  let provider;
  // Tracked so the funds probe can write a real snapshot through the shared
  // funds helper (cooldown bookkeeping lives on this settings row).
  let settingsId: string | null = null;
  if (which === "yahoo") {
    provider = yahooProvider(svc);
  } else if (which === "kotak_neo") {
    const { data } = await svc.from("market_api_settings").select(KOTAK_SETTINGS_COLS)
      .eq("user_id", userId).eq("active_provider", "kotak_neo").eq("purpose", purpose);
    const candidates = (data ?? []) as KotakSettings[];
    const row = candidates.find((r) => !!r.session_token_enc && !!r.sid)
      ?? candidates.find((r) => !!r.totp_secret_enc)
      ?? candidates[0];
    settingsId = row?.id ?? null;
    provider = row ? kotakProvider(svc, row) : yahooProvider(svc);
  } else {
    const active = await getActiveProvider(svc, userId);
    provider = active.provider;
    settingsId = active.settings?.id ?? null;
  }


  const wrap = async (fn: () => Promise<{ detail: string; source?: string; degraded?: boolean }>): Promise<SurfaceResult> => {
    const checked_at = new Date().toISOString();
    const t0 = Date.now();
    try {
      const r = await fn();
      const source = r.source ?? provider.name;
      const fellBack = which !== "active" && which !== "yahoo" && canonicalProvider(source) !== which;
      // `degraded` = the endpoint answered but the payload is incomplete
      // (e.g. funds without an available-margin figure). Reporting that as a
      // clean "ok" is how a half-broken feed hides in the health tally.
      const partial = r.degraded === true;
      return {
        ok: !partial,
        state: fellBack || partial ? "degraded" : "ok",
        provider_used: source,
        detail: r.detail,
        checked_at,
        latency_ms: Date.now() - t0,
      };

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Broker load-shedding / throttling is transient, not a dead feed.
      const transient = /\b(503|429|502|504)\b|no available server|timeout|no bid\/ask levels/i.test(msg);
      // "authorize with X first" is a setup state, not an outage — a broker
      // nobody connected must not be counted as a broken feed.
      const unconfigured = /authoriz|not connected|no session|credentials?\s+(are\s+)?(missing|required)|api key/i.test(msg);
      return {
        ok: false,
        state: unconfigured ? "not_configured" : transient ? "degraded" : "failed",
        provider_used: provider.name,
        detail: msg,
        checked_at,
        latency_ms: Date.now() - t0,
      };
    }
  };


  // A provider is only judged on the surfaces it actually serves: Yahoo has no
  // funds/holdings/depth endpoint, Kotak publishes no candle API. Unsupported
  // combinations are never called and never stored.
  const owner = which === "active" ? canonicalProvider(provider.name) : which;
  const probes: Record<string, () => Promise<{ detail: string; source?: string }>> = {
    quotes: async () => {
      const rows = await provider.getQuotes(["NSE:RELIANCE"], { allowFallback: which === "active" || which === "yahoo" });
      if (!rows.length) throw new Error("no rows");
      // A zero price is not a quote. This used to be stored as ok, so an
      // unauthorised session could sit on the page looking healthy.
      if (!(Number(rows[0].price) > 0)) throw new Error("provider returned ltp=0");
      return { detail: `ltp=${rows[0].price}`, source: rows[0].source };
    },
    index_quotes: async () => {
      const rows = await provider.getQuotes(["NSE:^NSEI"], { allowFallback: which === "active" || which === "yahoo" });
      if (!rows.length) throw new Error("no index rows");
      if (!(Number(rows[0].price) > 0)) throw new Error("provider returned ltp=0 for Nifty 50");
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
      // Go through the shared snapshot path so a successful probe actually
      // persists `market_funds`. The old probe called the broker directly and
      // wrote only a pass/fail row, which is why the Funds card could sit on a
      // day-old snapshot while the probe reported "ok" every hour.
      const res = await refreshFundsSnapshot({
        svc, userId, settingsId, provider, respectCooldown: false,
      });
      if (res.not_connected) throw new Error(res.reason ?? "broker not connected");
      if (res.source !== "kotak") throw new Error(res.reason ?? "funds not exposed by provider");
      const f = res.funds!;
      // Only a missing figure is degraded. A broker that genuinely reports a
      // zero balance is a working feed and must not read as an outage.
      const degraded = f.available_margin == null;
      return {
        detail: degraded
          ? `available margin not reported (used=${f.used_margin})`
          : f.available_margin === 0 && (f.used_margin ?? 0) === 0
          ? "broker reports a zero balance (available=0)"
          : `available=${f.available_margin} used=${f.used_margin} (snapshot saved)`,
        source: provider.name,
        degraded,
      };
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

  const keys = Object.keys(probes).filter((s) => {
    if (!supportsSurface(owner, s)) return false;
    if (scope === "data") return !isAccountSurface(s);
    if (scope === "account") return isAccountSurface(s);
    return true;
  });

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
    const per = await probeServiceSurfaces(p, { ok: r.ok, detail: r.detail ?? null }, svc)
      .catch(() => ({} as Record<string, { ok: boolean; detail: string }>));
    const mapped: Record<string, SurfaceResult> = {};
    for (const key of SERVICE_SURFACES[p] ?? []) {
      const s = per[key] ?? { ok: r.ok, detail: r.detail ?? "" };
      mapped[key] = {
        ok: s.ok,
        state: s.ok ? (s.degraded ? "degraded" : "ok") : "failed",
        provider_used: p,
        detail: s.detail ?? "",
        checked_at,
      };
    }
    await recordSurfaceProbes(svc, mapped, latency);
    Object.assign(surfaces, mapped);

  });

  const brokerRun = (async () => {
    // Sequential, not concurrent: the merge below decides which provider owns
    // a surface, and a race made that order (and therefore the UI) random.
    // DATA plane — the designated system feed row (purpose='data'). Account
    // surfaces are deliberately excluded: the shared feed never serves funds,
    // holdings or positions, so probing them here produced permanent red rows
    // on the admin feed page.
    const kStart = Date.now();
    const kotak = await surfaceReport(svc, userId, "kotak_neo", "data", "data")
      .catch(() => ({} as Record<string, SurfaceResult>));
    const kLatency = Date.now() - kStart;
    const kKeys = Object.keys(kotak);
    const kOkCount = kKeys.filter((k) => kotak[k].ok).length;
    const kOk = kOkCount > 0;
    const kDetail = kKeys.length ? `${kOkCount}/${kKeys.length} surfaces answered` : "Kotak Neo probe returned nothing";
    providers["kotak_neo"] = { ok: kOk, detail: kDetail, latency_ms: kLatency };
    await recordProviderProbe(svc, "kotak_neo", kOk, kDetail, kLatency);
    await recordSurfaceProbes(svc, kotak, kLatency, "data");
    Object.assign(surfaces, kotak);

    // ACCOUNT plane — the caller's own broker connection (purpose='account'),
    // probed only when such a row exists. Stored under plane='account'.
    const { data: kotakAcct } = await svc.from("market_api_settings")
      .select("id").eq("user_id", userId).eq("active_provider", "kotak_neo").eq("purpose", "account").limit(1);
    if ((kotakAcct ?? []).length > 0) {
      const aStart = Date.now();
      const acct = await surfaceReport(svc, userId, "kotak_neo", "account", "account")
        .catch(() => ({} as Record<string, SurfaceResult>));
      await recordSurfaceProbes(svc, acct, Date.now() - aStart, "account");
    }





    const yStart = Date.now();
    const yahoo = await surfaceReport(svc, userId, "yahoo", "data", "data")
      .catch(() => ({} as Record<string, SurfaceResult>));
    const yLatency = Date.now() - yStart;
    const yKeys = Object.keys(yahoo);
    const yOkCount = yKeys.filter((k) => yahoo[k].ok).length;
    const yOk = yOkCount > 0;
    providers["yahoo"] = { ok: yOk, detail: `${yOkCount}/${yKeys.length} surfaces answered`, latency_ms: yLatency };
    await recordProviderProbe(svc, "yahoo", yOk, yOk ? null : "Yahoo probe returned nothing", yLatency);
    await recordSurfaceProbes(svc, yahoo, yLatency, "data");

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
  // Surface rows are upserted per (surface, provider) and never deleted, so a
  // provider dropped from a chain kept voting on that feed's status forever.
  // Anything not re-probed within 2 days is no longer evidence.
  const surfaceCutoff = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const { error: sErr, count: sCount } = await svc.from("market_surface_probes")
    .delete({ count: "exact" })
    .lt("checked_at", surfaceCutoff);
  if (sErr) console.error("surface probe prune failed", sErr);
  return (count ?? 0) + (sCount ?? 0);
}

