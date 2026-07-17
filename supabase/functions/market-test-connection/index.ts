// market-test-connection — live probe of the active provider.
// Kotak: user limits call (validates session). Yahoo: index quote.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider, yahooProvider } from "../_shared/market/provider.ts";
import { KOTAK_SETTINGS_COLS, type KotakSettings } from "../_shared/market/kotakClient.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const body = await req.json().catch(() => ({}));
    const requested = String(body?.provider ?? "active");
    const svc = svcClient();
    let { provider, settings } = await getActiveProvider(svc, auth.userId);
    if (requested === "yahoo") {
      provider = yahooProvider();
      settings = null;
    } else if (requested === "kotak_neo") {
      const { data, error } = await svc.from("market_api_settings")
        .select(KOTAK_SETTINGS_COLS)
        .eq("user_id", auth.userId)
        .eq("active_provider", "kotak_neo")
        .maybeSingle();
      if (error) return errorResponse(req, error.message, 500);
      if (!data) return jsonResponse(req, { ok: false, provider: "kotak_neo", detail: "Kotak Neo is not configured yet" });
      const { provider: selected } = await import("../_shared/market/provider.ts").then((m) => m.getActiveProvider(svc, auth.userId));
      if (selected.name !== "kotak_neo") {
        const hasSession = (data as KotakSettings).session_token_enc && (data as KotakSettings).sid;
        if (!hasSession) return jsonResponse(req, { ok: false, provider: "kotak_neo", detail: "Login to Kotak first" });
      }
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
    return jsonResponse(req, { ok: result.ok, provider: provider.name, detail: result.detail ?? null });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
