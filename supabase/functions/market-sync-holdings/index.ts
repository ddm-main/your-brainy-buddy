// market-sync-holdings — pull real holdings from the broker into market_holdings.
//
// Broker rows upsert on (user_id, symbol, exchange); manual rows are left alone.
// Includes T1 (unsettled) and pledged qty so freshly-bought or pledged shares
// aren't invisible in the portfolio for T+1. Refuses to delete broker rows
// when the Kotak envelope looks incomplete (stat != "Ok") — a rate-limited
// or truncated response previously wiped the whole book.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";
import { BROKER_PROVIDERS } from "../_shared/market/provider.ts";
import { refreshFundsSnapshot } from "../_shared/market/funds.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const svc = svcClient();
    const { provider, settings } = await getActiveProvider(svc, auth.userId);
    if (!BROKER_PROVIDERS.includes(provider.name) || !provider.getHoldingsDetailed) {
      return errorResponse(req, "Holdings sync needs a connected broker (Kotak Neo). Connect it in Settings.", 400);
    }
    const detailed = await provider.getHoldingsDetailed();
    const holdings = detailed.rows;

    const { data: existing } = await svc.from("market_holdings")
      .select("id,symbol,exchange,source,buy_date")
      .eq("user_id", auth.userId);
    const brokerRows = new Map(
      (existing ?? [])
        .filter((r: any) => r.source === "kotak_sync")
        .map((r: any) => [`${r.exchange}:${r.symbol}`, r]),
    );

    let inserted = 0;
    let updated = 0;
    for (const h of holdings) {
      const key = `${h.exchange}:${h.symbol}`;
      const existingRow: any = brokerRows.get(key);
      if (existingRow) {
        await svc.from("market_holdings")
          .update({
            quantity: h.quantity,
            avg_price: h.avg_price,
            settled_qty: h.settled_qty ?? null,
            t1_qty: h.t1_qty ?? null,
            pledged_qty: h.pledged_qty ?? null,
            // Don't overwrite an existing buy_date — preserves the first-seen date.
            buy_date: existingRow.buy_date ?? h.buy_date ?? null,
          })
          .eq("id", existingRow.id);
        brokerRows.delete(key);
        updated++;
      } else {
        const { error: insErr } = await svc.from("market_holdings").insert({
          user_id: auth.userId,
          symbol: h.symbol,
          exchange: h.exchange,
          quantity: h.quantity,
          avg_price: h.avg_price,
          settled_qty: h.settled_qty ?? null,
          t1_qty: h.t1_qty ?? null,
          pledged_qty: h.pledged_qty ?? null,
          buy_date: h.buy_date ?? null,
          source: "kotak_sync",
        });
        if (insErr?.code === "23505") {
          // A concurrent sync call (auto-refresh racing a manual click) won
          // the insert between our read and this write — update its row
          // instead of erroring, backed by idx_market_holdings_broker_unique.
          const { data: race } = await svc.from("market_holdings")
            .select("id").eq("user_id", auth.userId).eq("symbol", h.symbol)
            .eq("exchange", h.exchange).eq("source", "kotak_sync").maybeSingle();
          if (race) {
            await svc.from("market_holdings").update({
              quantity: h.quantity, avg_price: h.avg_price,
              settled_qty: h.settled_qty ?? null, t1_qty: h.t1_qty ?? null, pledged_qty: h.pledged_qty ?? null,
            }).eq("id", race.id);
            updated++;
          }
        } else {
          inserted++;
        }
      }
    }

    // Deletion safeguard: only remove missing rows if the broker response
    // was well-formed. If Kotak returned garbage (empty body while we had
    // real holdings), keep the old rows so we never silently wipe the book.
    let removed = 0;
    const staleIds = [...brokerRows.values()].map((r: any) => r.id);
    if (staleIds.length > 0) {
      const responseLooksReal = detailed.complete && (holdings.length > 0 || (existing ?? []).length === 0);
      if (responseLooksReal) {
        await svc.from("market_holdings").delete().in("id", staleIds);
        removed = staleIds.length;
      } else {
        console.warn("[market-sync-holdings] skipping delete: broker payload looks incomplete", {
          incoming: holdings.length,
          existing: (existing ?? []).length,
          complete: detailed.complete,
        });
      }
    }

    if (settings) {
      await svc.from("market_api_settings")
        .update({ last_sync_at: new Date().toISOString() })
        .eq("id", settings.id);
    }

    // Best-effort funds refresh — margin used moves the moment holdings sync,
    // and the UI keeps yesterday's number otherwise. Never let this fail the sync.
    try {
      await refreshFundsSnapshot({ svc, userId: auth.userId, settingsId: settings?.id ?? null, provider });
    } catch (fundsErr) {
      console.warn("[market-sync-holdings] post-sync funds refresh failed:", fundsErr instanceof Error ? fundsErr.message : String(fundsErr));
    }

    return jsonResponse(req, { ok: true, inserted, updated, removed, total: holdings.length, complete: detailed.complete });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
