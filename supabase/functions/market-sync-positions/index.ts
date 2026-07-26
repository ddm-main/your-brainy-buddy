// market-sync-positions — pull today's net positions from the broker.
//
// Open synced positions are key-upserted each sync (source of truth = broker);
// manually journaled positions (is_broker_synced=false) are untouched. Fully
// closed intraday trades (buy = sell) are captured into market_realized_pnl_daily
// so today's realized P&L survives even though no open position remains.
// Refuses to wipe synced rows when the Kotak envelope looks incomplete.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";
import { refreshFundsSnapshot } from "../_shared/market/funds.ts";

const SYNC_MARK = "kotak_sync";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const svc = svcClient();
    const { provider, settings } = await getActiveProvider(svc, auth.userId);
    if (provider.name !== "kotak_neo" || !provider.getPositionsDetailed) {
      return errorResponse(req, "Positions sync needs a connected broker (Kotak Neo). Connect it in Settings.", 400);
    }
    const detailed = await provider.getPositionsDetailed();
    const positions = detailed.rows;
    const realized = detailed.realized;

    const { data: existing } = await svc.from("market_positions")
      .select("id,symbol,exchange,side,is_broker_synced,closed_at")
      .eq("user_id", auth.userId)
      .eq("is_broker_synced", true)
      .is("closed_at", null);
    const existingByKey = new Map((existing ?? []).map((r: any) => [`${r.exchange}:${r.symbol}:${r.side}`, r]));

    let inserted = 0;
    let updated = 0;
    for (const p of positions) {
      const key = `${p.exchange}:${p.symbol}:${p.side}`;
      const current: any = existingByKey.get(key);
      if (current) {
        const { error } = await svc.from("market_positions")
          .update({ quantity: p.quantity, entry_price: p.entry_price, product: p.product, journal_notes: SYNC_MARK })
          .eq("id", current.id);
        if (!error) updated++;
        existingByKey.delete(key);
      } else {
        const { error } = await svc.from("market_positions").insert({
          user_id: auth.userId,
          symbol: p.symbol,
          exchange: p.exchange,
          side: p.side,
          quantity: p.quantity,
          entry_price: p.entry_price,
          product: p.product,
          journal_notes: SYNC_MARK,
          is_broker_synced: true,
        });
        if (error?.code === "23505") {
          // A concurrent sync call won the insert between our read and this
          // write — update its row instead, backed by
          // idx_market_positions_broker_unique.
          const { data: race } = await svc.from("market_positions")
            .select("id").eq("user_id", auth.userId).eq("symbol", p.symbol)
            .eq("exchange", p.exchange).eq("side", p.side)
            .eq("is_broker_synced", true).is("closed_at", null).maybeSingle();
          if (race) {
            await svc.from("market_positions")
              .update({ quantity: p.quantity, entry_price: p.entry_price, product: p.product, journal_notes: SYNC_MARK })
              .eq("id", race.id);
            updated++;
          }
        } else if (!error) {
          inserted++;
        }
      }
    }

    let removed = 0;
    const staleIds = [...existingByKey.values()].map((r: any) => r.id);
    if (staleIds.length > 0) {
      if (detailed.complete) {
        await svc.from("market_positions").delete().in("id", staleIds);
        removed = staleIds.length;
      } else {
        console.warn("[market-sync-positions] skipping stale delete: broker payload looks incomplete");
      }
    }

    // Realized intraday snapshot — one row per (user, day, symbol, exchange).
    // Upsert so re-syncing during the day updates the running total instead
    // of stacking rows.
    let realizedRows = 0;
    if (realized.length > 0) {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
      for (const r of realized) {
        const { error } = await svc.from("market_realized_pnl_daily").upsert({
          user_id: auth.userId,
          day,
          symbol: r.symbol,
          exchange: r.exchange,
          quantity: r.quantity,
          realized: r.realized,
          source: "kotak_sync",
        }, { onConflict: "user_id,day,symbol,exchange" });
        if (!error) realizedRows++;
      }
    }

    // Best-effort funds refresh — same rationale as market-sync-holdings.
    try {
      await refreshFundsSnapshot({ svc, userId: auth.userId, settingsId: settings?.id ?? null, provider });
    } catch (fundsErr) {
      console.warn("[market-sync-positions] post-sync funds refresh failed:", fundsErr instanceof Error ? fundsErr.message : String(fundsErr));
    }

    return jsonResponse(req, { ok: true, inserted, updated, removed, total: positions.length, realized: realizedRows, complete: detailed.complete });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
