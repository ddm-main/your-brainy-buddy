// market-funds — snapshot the signed-in user's Kotak account balance
// (net cash, available margin, used margin, collateral) and persist it into
// market_funds. Yahoo-only users get a stub null response. Non-blocking:
// if the broker call fails, return the last cached row so the UI still
// renders yesterday's number instead of a red banner.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const svc = svcClient();
  try {
    const { provider } = await getActiveProvider(svc, auth.userId);
    if (provider.name !== "kotak_neo") {
      const { data: cached } = await svc.from("market_funds").select("*").eq("user_id", auth.userId).maybeSingle();
      return jsonResponse(req, { funds: cached ?? null, source: "unavailable", note: "connect Kotak Neo to see live margin" });
    }
    const snap = await provider.getFunds();
    const row = {
      user_id: auth.userId,
      net_cash: snap.net_cash,
      available_margin: snap.available_margin,
      used_margin: snap.used_margin,
      collateral: snap.collateral,
      payin_amount: snap.payin_amount,
      payload: (snap.raw ?? null) as any,
      synced_at: new Date().toISOString(),
    };
    await svc.from("market_funds").upsert(row, { onConflict: "user_id" });
    return jsonResponse(req, { funds: row, source: snap.source });
  } catch (e) {
    // Return last cached row rather than a hard error — the UI banners it.
    const { data: cached } = await svc.from("market_funds").select("*").eq("user_id", auth.userId).maybeSingle();
    return jsonResponse(req, {
      funds: cached ?? null,
      source: "stale",
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
