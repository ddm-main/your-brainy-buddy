// market-sync-holdings — pull real holdings from the broker into market_holdings.
// Broker rows upsert on (user_id, symbol, exchange); manual rows are left alone.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const svc = svcClient();
    const { provider, settings } = await getActiveProvider(svc, auth.userId);
    if (provider.name !== "kotak_neo") {
      return errorResponse(req, "Holdings sync needs a connected broker (Kotak Neo). Connect it in Settings.", 400);
    }
    const holdings = await provider.getHoldings();

    const { data: existing } = await svc.from("market_holdings")
      .select("id,symbol,exchange,source")
      .eq("user_id", auth.userId);
    const brokerRows = new Map(
      (existing ?? [])
        .filter((r: any) => r.source === "kotak_sync")
        .map((r: any) => [`${r.exchange}:${r.symbol}`, r.id]),
    );

    let inserted = 0;
    let updated = 0;
    for (const h of holdings) {
      const key = `${h.exchange}:${h.symbol}`;
      const id = brokerRows.get(key);
      if (id) {
        await svc.from("market_holdings")
          .update({ quantity: h.quantity, avg_price: h.avg_price })
          .eq("id", id);
        brokerRows.delete(key);
        updated++;
      } else {
        await svc.from("market_holdings").insert({
          user_id: auth.userId,
          symbol: h.symbol,
          exchange: h.exchange,
          quantity: h.quantity,
          avg_price: h.avg_price,
          source: "kotak_sync",
        });
        inserted++;
      }
    }
    // Broker rows no longer present at Kotak → remove (they were sold)
    const staleIds = [...brokerRows.values()];
    if (staleIds.length > 0) {
      await svc.from("market_holdings").delete().in("id", staleIds);
    }

    if (settings) {
      await svc.from("market_api_settings")
        .update({ last_sync_at: new Date().toISOString() })
        .eq("id", settings.id);
    }
    return jsonResponse(req, { ok: true, inserted, updated, removed: staleIds.length, total: holdings.length });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
