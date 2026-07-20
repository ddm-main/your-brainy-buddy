// market-sync-positions — pull today's net positions from the broker.
// Open synced positions are replaced wholesale each sync (source of truth = broker);
// manually journaled positions (no external marker) are untouched.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";

const SYNC_MARK = "kotak_sync";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const svc = svcClient();
    const { provider } = await getActiveProvider(svc, auth.userId);
    if (provider.name !== "kotak_neo") {
      return errorResponse(req, "Positions sync needs a connected broker (Kotak Neo). Connect it in Settings.", 400);
    }
    const positions = await provider.getPositions();

    // Replace open synced rows. Matched on is_broker_synced (a dedicated flag)
    // rather than journal_notes text equality — a manually-journaled position
    // whose note happened to be the literal string "kotak_sync" used to be at
    // risk of silent deletion on the next sync.
    await svc.from("market_positions")
      .delete()
      .eq("user_id", auth.userId)
      .eq("is_broker_synced", true)
      .is("closed_at", null);

    let inserted = 0;
    for (const p of positions) {
      const { error } = await svc.from("market_positions").insert({
        user_id: auth.userId,
        symbol: p.symbol,
        exchange: p.exchange,
        side: p.side,
        quantity: p.quantity,
        entry_price: p.entry_price,
        journal_notes: SYNC_MARK,
        is_broker_synced: true,
      });
      if (!error) inserted++;
    }
    return jsonResponse(req, { ok: true, inserted, total: positions.length });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
