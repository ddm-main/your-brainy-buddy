// market-test-connection — live probe of any configured data provider.
// Kotak/Yahoo: full surface report / MarketProvider.testAuth().
// FMP/Alpha Vantage/NSE/BSE: lightweight direct probes — these aren't
// per-user broker sessions, just service-level API reachability + key checks.
// The probe implementations themselves live in _shared/market/selftest.ts so
// market-selftest (the "test everything" / cron path) writes identical status.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider, kotakProvider, yahooProvider } from "../_shared/market/provider.ts";
import { KOTAK_SETTINGS_COLS, type KotakSettings } from "../_shared/market/kotakClient.ts";
import {
  probeService, recordProviderProbe, recordSurfaceProbes, surfaceReport,
  SERVICE_SURFACES, type SurfaceResult,
} from "../_shared/market/selftest.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const body = await req.json().catch(() => ({}));
    const requested = String(body?.provider ?? "active");
    // Which plane is being probed: the app-wide data feed (default — this is
    // what Feed Routing reports on) or the caller's own account connection.
    const probePurpose = String(body?.purpose ?? "data") === "account" ? "account" : "data";
    const svc = svcClient();

    // Surface-level end-to-end audit for one provider.
    if (body?.mode === "surfaces") {
      // Service providers (no per-user session) get a single reachability
      // probe mapped onto the surfaces they actually serve, so Feed Routing
      // can show real health for NSE/FMP/Alpha/BSE instead of guessing from
      // table freshness.
      if (SERVICE_SURFACES[requested]) {
        const checked_at = new Date().toISOString();
        const started = Date.now();
        const r = await probeService(requested).catch((e) => ({
          ok: false, detail: e instanceof Error ? e.message : String(e),
        }));
        await recordProviderProbe(svc, requested, r.ok, r.detail ?? null, Date.now() - started);
        const surfaces: Record<string, SurfaceResult> = {};
        for (const key of SERVICE_SURFACES[requested]) {
          surfaces[key] = {
            ok: r.ok,
            state: r.ok ? "ok" : "failed",
            provider_used: requested,
            detail: r.detail ?? "",
            checked_at,
          };
        }
        await recordSurfaceProbes(svc, surfaces, Date.now() - started, "data");
        return jsonResponse(req, { ok: r.ok, mode: "surfaces", provider: requested, surfaces });
      }
      const which = requested === "kotak_neo" || requested === "yahoo" ? requested : "active";
      // A data-feed test probes only the shared feed surfaces; an account test
      // probes only the caller's account surfaces. Never both from one row.
      const scope = probePurpose === "account" ? "account" : "data";
      const report = await surfaceReport(svc, auth.userId, which, probePurpose, scope);
      await recordSurfaceProbes(svc, report, undefined, scope);
      return jsonResponse(req, { ok: true, mode: "surfaces", provider: which, surfaces: report });

    }



    if (["fmp", "alpha_vantage", "nse", "bse"].includes(requested)) {
      const started = Date.now();
      const result = await probeService(requested).catch((e) => ({
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      }));
      await recordProviderProbe(svc, requested, result.ok, result.detail ?? null, Date.now() - started);
      return jsonResponse(req, { ok: result.ok, provider: requested, detail: result.detail });
    }

    let { provider, settings } = await getActiveProvider(svc, auth.userId);
    if (requested === "yahoo") {
      provider = yahooProvider(svc);
      settings = null;
    } else if (requested === "kotak_neo") {
      // Look up the Kotak row regardless of which provider is currently
      // active — a working Kotak session must not report "not configured"
      // just because the user is reading through Yahoo right now.
      const { data, error } = await svc.from("market_api_settings")
        .select(KOTAK_SETTINGS_COLS + ",purpose")
        .eq("user_id", auth.userId)
        .eq("active_provider", "kotak_neo")
        .eq("purpose", probePurpose);
      if (error) return errorResponse(req, error.message, 500);
      const all = (data ?? []) as Array<KotakSettings & { purpose?: string }>;
      // Account and data-feed credentials are separate security planes. A
      // probe must never borrow the other plane merely because it is usable.
      const row = all.find((r) => !!r.session_token_enc && !!r.sid)
        ?? all.find((r) => !!r.totp_secret_enc)
        ?? all[0];
      if (!row) return jsonResponse(req, { ok: false, provider: "kotak_neo", detail: "Kotak Neo is not configured yet" });
      const kotak = row;

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
    } else if (settings && !result.ok) {
      // A failed Kotak test must persist, otherwise the config page keeps
      // left the stored status at "connected" and the config page kept
      // claiming a healthy session right after a test that just failed.
      // A session-shaped failure is "expired"; anything else is "error".
      const detail = result.detail ?? "Broker connection test failed";
      const expired = /401|403|unauthor|session|token|expired|re-?login/i.test(detail);
      await svc.from("market_api_settings")
        .update({ connection_status: expired ? "expired" : "error", last_error: detail })
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
