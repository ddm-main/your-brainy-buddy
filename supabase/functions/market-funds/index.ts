// market-funds — snapshot the signed-in user's Kotak account balance.
// Uses the shared funds helper so repeated dashboard/sync refreshes respect
// Kotak rate-limit/upstream cooldowns and return cached data when available.
import { preflight, jsonResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";
import { refreshFundsSnapshot } from "../_shared/market/funds.ts";
import { kotakLimitsProbe, withKotakSession } from "../_shared/market/kotakClient.ts";
import { encryptValue } from "../_shared/market/provider.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const svc = svcClient();
  try {
    const { provider, settings } = await getActiveProvider(svc, auth.userId);
    // Diagnostic path: echo every seg/exch/prod combo Kotak answers so a wrong
    // segment (all-zero payload) is visible instead of silently rendering ₹0.
    let debug = false;
    try { debug = (await req.clone().json())?.debug === true; } catch { /* no body */ }
    if (debug && settings) {
      const probe = await withKotakSession(svc, settings as any, encryptValue, (ss) => kotakLimitsProbe(ss));
      return jsonResponse(req, { probe });
    }
    const result = await refreshFundsSnapshot({ svc, userId: auth.userId, settingsId: settings?.id ?? null, provider });
    return jsonResponse(req, result);
  } catch (e) {
    console.error("[market-funds] live fetch failed:", e instanceof Error ? e.message : String(e));
    return jsonResponse(req, { funds: null, source: "unavailable", reason: "Live margin unavailable", reason_code: "unknown" });
  }
});
