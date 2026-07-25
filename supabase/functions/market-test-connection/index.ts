// market-test-connection — live probe of any configured data provider.
// Kotak/Yahoo: full MarketProvider.testAuth() (validates session / fetches a quote).
// FMP/Alpha Vantage/NSE/BSE: lightweight direct probes — these aren't
// per-user broker sessions, just service-level API reachability + key checks.
// (Stooq used to be here too — retired, see resolver.ts's PRIORITY_CHAINS
// comment: its public endpoint now sits behind a browser anti-bot challenge.)
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider, kotakProvider, yahooProvider } from "../_shared/market/provider.ts";
import { KOTAK_SETTINGS_COLS, type KotakSettings } from "../_shared/market/kotakClient.ts";
import { fmpProfile } from "../_shared/market/fmpClient.ts";
import { alphaRSI } from "../_shared/market/alphaVantageClient.ts";
import { nseMarketStatus } from "../_shared/market/nseClient.ts";
import { bseCirculars } from "../_shared/market/bseClient.ts";

const PROBE_SYMBOL = "RELIANCE";

async function probeService(provider: string): Promise<{ ok: boolean; detail: string | null }> {
  switch (provider) {
    case "fmp": {
      const p = await fmpProfile(PROBE_SYMBOL, "NSE");
      return p ? { ok: true, detail: `FMP reachable — ${p.company_name ?? PROBE_SYMBOL}` } : { ok: false, detail: "FMP returned no data (check FINANCIAL_MODELING_PREP_API_KEY)" };
    }
    case "alpha_vantage": {
      const v = await alphaRSI(PROBE_SYMBOL, "NSE");
      return v != null ? { ok: true, detail: `Alpha Vantage reachable — RSI ${v.toFixed(1)}` } : { ok: false, detail: "Alpha Vantage returned no data (check ALPHA_VANTAGE_API_KEY or daily quota)" };
    }
    case "nse": {
      const rows = await nseMarketStatus();
      return rows.length > 0 ? { ok: true, detail: `NSE reachable — ${rows[0].market}: ${rows[0].status}` } : { ok: false, detail: "NSE unreachable (public endpoint blocked or cookie handshake failed)" };
    }
    case "bse": {
      const rows = await bseCirculars();
      return { ok: true, detail: `BSE reachable — ${rows.length} recent circulars` };
    }
    default:
      return { ok: false, detail: "Provider connector is not enabled" };
  }
}

// Per-surface probe — proves Kotak-first routing end-to-end from a single
// call. Each field is `{ ok, provider_used, detail }`. Uses tiny read-only
// probes (RELIANCE quote, NIFTY OHLCV, no orders placed).
async function surfaceReport(svc: ReturnType<typeof svcClient>, userId: string) {
  const { provider } = await getActiveProvider(svc, userId);
  const wrap = async (name: string, fn: () => Promise<string>) => {
    try {
      const detail = await fn();
      return { ok: true, provider_used: provider.name, detail };
    } catch (e) {
      return { ok: false, provider_used: provider.name, detail: e instanceof Error ? e.message : String(e) };
    }
  };
  return {
    quotes: await wrap("quotes", async () => {
      const rows = await provider.getQuotes(["NSE:RELIANCE"]);
      if (!rows.length) throw new Error("no rows");
      return `ltp=${rows[0].price} via ${rows[0].source}`;
    }),
    depth: await wrap("depth", async () => {
      const d = await provider.getDepth("RELIANCE", "NSE");
      return `bids=${d.bids.length} asks=${d.asks.length} source=${d.source}`;
    }),
    candles_1d: await wrap("candles_1d", async () => {
      const c = await provider.getOHLCV("NIFTY", "NSE", "5d", "1d");
      return `${c.length} daily bars`;
    }),
    candles_intraday: await wrap("candles_intraday", async () => {
      const c = await provider.getOHLCV("RELIANCE", "NSE", "5d", "15m");
      return `${c.length} 15m bars`;
    }),
    funds: await wrap("funds", async () => {
      const f = await provider.getFunds();
      if (f.source === "unavailable") throw new Error("funds not exposed by provider");
      return `available=${f.available_margin} used=${f.used_margin}`;
    }),
    holdings: await wrap("holdings", async () => {
      const h = await provider.getHoldings();
      return `${h.length} holdings`;
    }),
    positions: await wrap("positions", async () => {
      const p = await provider.getPositions();
      return `${p.length} positions`;
    }),
  };
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const body = await req.json().catch(() => ({}));
    const requested = String(body?.provider ?? "active");
    const svc = svcClient();

    // Surface-level end-to-end audit: one call proves every user-facing
    // surface routes through the active provider (Kotak → Yahoo fallback).
    if (body?.mode === "surfaces") {
      const report = await surfaceReport(svc, auth.userId);
      return jsonResponse(req, { ok: true, mode: "surfaces", surfaces: report });
    }

    if (["fmp", "alpha_vantage", "nse", "bse"].includes(requested)) {
      const result = await probeService(requested).catch((e) => ({
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      }));
      return jsonResponse(req, { ok: result.ok, provider: requested, detail: result.detail });
    }

    let { provider, settings } = await getActiveProvider(svc, auth.userId);
    if (requested === "yahoo") {
      provider = yahooProvider(svc);
      settings = null;
    } else if (requested === "kotak_neo") {
      const { data, error } = await svc.from("market_api_settings")
        .select(KOTAK_SETTINGS_COLS)
        .eq("user_id", auth.userId)
        .eq("active_provider", "kotak_neo")
        .maybeSingle();
      if (error) return errorResponse(req, error.message, 500);
      if (!data) return jsonResponse(req, { ok: false, provider: "kotak_neo", detail: "Kotak Neo is not configured yet" });
      const kotak = data as KotakSettings;
      const hasAutoLogin = !!kotak.totp_secret_enc;
      const hasSession = !!kotak.session_token_enc && !!kotak.sid;
      if (!hasAutoLogin && !hasSession) return jsonResponse(req, { ok: false, provider: "kotak_neo", detail: "Login to Kotak first" });
      provider = kotakProvider(svc, kotak);
      settings = kotak;
    } else if (!["active", "kotak_neo", "yahoo"].includes(requested)) {
      return jsonResponse(req, { ok: false, provider: requested, detail: "Provider connector is not enabled" });
    }
    const result = await provider.testAuth().catch((e) => ({
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    }));
    if (settings && result.ok) {
      await svc.from("market_api_settings")
        .update({ connection_status: "connected", last_error: null })
        .eq("id", settings.id);
    }
    // When probing the "active" pathway (or Kotak directly), also probe
    // Yahoo so the UI can distinguish "Kotak down → Yahoo reachable" from
    // "everything down". Kept lightweight; never blocks a Kotak-success path.
    let fallback: { provider: string; ok: boolean; detail: string | null } | null = null;
    if (!result.ok && (requested === "active" || requested === "kotak_neo")) {
      const yahoo = yahooProvider(svc);
      const yr = await yahoo.testAuth().catch((e) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
      fallback = { provider: yahoo.name, ok: yr.ok, detail: yr.detail ?? null };
    }
    return jsonResponse(req, { ok: result.ok, provider: provider.name, detail: result.detail ?? null, fallback });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
