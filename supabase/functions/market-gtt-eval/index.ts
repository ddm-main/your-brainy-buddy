// market-gtt-eval — 1-min cron during market hours. For every active GTT:
//   - expire past expires_at
//   - if BUY: fire when LTP >= trigger_price
//   - if SELL: fire when LTP <= trigger_price
//   - OCO: fire whichever leg is hit first; the other is implicitly cancelled
//     because status flips to 'triggered' (single-row status).
// Firing places a real order via the same provider abstraction the
// place/modify/cancel functions use, then records broker_order_id back on
// the GTT row so users can trace what fired.
import { preflight, jsonResponse, errorResponse, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret, istTradeDate, isTradingHoliday } from "../_shared/market/cron.ts";
import { getActiveProvider, type PlaceOrderInput } from "../_shared/market/provider.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

function marketOpenNow(): boolean {
  const d = new Date();
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  const day = ist.getUTCDay(); if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

interface GTT {
  id: string; user_id: string; symbol: string; exchange: string;
  side: "BUY" | "SELL"; trigger_type: "single" | "OCO";
  trigger_price: number; trigger_price_upper: number | null;
  order_type: "MARKET" | "LIMIT"; price: number | null;
  quantity: number; product: "MIS" | "CNC" | "NRML";
  expires_at: string | null;
}

// A tick slow enough to still be placing an order when the next cron fire
// starts must not let both invocations act on the same 'active' row and
// both fire the same GTT. Same lease pattern as market-autotrade-eval's
// eval_lock_at: an atomic conditional UPDATE, not an in-process lock (which
// wouldn't survive across separate stateless calls anyway). Stale-lease
// recovery after CLAIM_LEASE_MS so a crashed invocation can't wedge a GTT
// out of evaluation forever.
const CLAIM_LEASE_MS = 2 * 60_000;

async function claimGtt(svc: SupabaseClient, id: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - CLAIM_LEASE_MS).toISOString();
  const { data } = await svc.from("market_gtt_orders")
    .update({ eval_claimed_at: new Date().toISOString() })
    .eq("id", id).eq("status", "active")
    .or(`eval_claimed_at.is.null,eval_claimed_at.lt.${staleBefore}`)
    .select("id");
  return !!data?.length;
}

async function expireOverdue(svc: SupabaseClient) {
  const now = new Date().toISOString();
  await svc.from("market_gtt_orders")
    .update({ status: "expired" })
    .eq("status", "active")
    .not("expires_at", "is", null)
    .lt("expires_at", now);
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const gate = await requireCronSecret(req); if (gate) return gate;
  try {
    if (!marketOpenNow()) return new Response(JSON.stringify({ ok: true, note: "market_closed" }), { headers: { "Content-Type": "application/json" } });
    const svc = svcClient();
    if (await isTradingHoliday(svc, istTradeDate())) return new Response(JSON.stringify({ ok: true, note: "market_closed_holiday" }), { headers: { "Content-Type": "application/json" } });

    await expireOverdue(svc);

    // Group active GTTs by user so we open one provider session per user.
    const { data: gtts } = await svc.from("market_gtt_orders")
      .select("id,user_id,symbol,exchange,side,trigger_type,trigger_price,trigger_price_upper,order_type,price,quantity,product,expires_at")
      .eq("status", "active");
    if (!gtts?.length) return new Response(JSON.stringify({ ok: true, checked: 0, fired: 0 }), { headers: { "Content-Type": "application/json" } });

    const byUser = new Map<string, GTT[]>();
    for (const g of gtts as GTT[]) {
      const list = byUser.get(g.user_id) ?? [];
      list.push(g); byUser.set(g.user_id, list);
    }

    let fired = 0;
    for (const [userId, list] of byUser) {
      try {
        const { provider, settings } = await getActiveProvider(svc, userId);
        if (provider.name !== "kotak_neo" || !settings || settings.connection_status !== "connected") continue;

        // One quote call per user (deduped symbols).
        const symbols = [...new Set(list.map((g) => `${g.exchange}:${g.symbol}`))];
        const quotes = await provider.getQuotes(symbols);
        const ltpByKey = new Map(quotes.map((q) => [q.key, q.price]));

        for (const g of list) {
          const ltp = ltpByKey.get(`${g.exchange}:${g.symbol}`);
          if (ltp == null) continue;

          // Determine trigger. For OCO: lower leg is trigger_price, upper is trigger_price_upper.
          // Regardless of side, "lower leg hit" = LTP <= trigger_price, "upper leg hit" = LTP >= trigger_price_upper.
          let triggered = false;
          let leg: "lower" | "upper" | null = null;
          if (g.trigger_type === "OCO") {
            if (ltp <= g.trigger_price) { triggered = true; leg = "lower"; }
            else if (g.trigger_price_upper != null && ltp >= g.trigger_price_upper) { triggered = true; leg = "upper"; }
          } else {
            // single: BUY triggers on cross-above (breakout entry), SELL on cross-below (stop-loss).
            if (g.side === "BUY" && ltp >= g.trigger_price) triggered = true;
            else if (g.side === "SELL" && ltp <= g.trigger_price) triggered = true;
          }
          if (!triggered) continue;
          if (!await claimGtt(svc, g.id)) continue; // another invocation is already handling this row

          try {
            const orderInput: PlaceOrderInput = {
              symbol: g.symbol, exchange: g.exchange as "NSE" | "BSE", side: g.side,
              quantity: g.quantity, orderType: g.order_type, product: g.product,
              price: g.order_type === "LIMIT" ? (g.price ?? ltp) : undefined,
            };
            const result = await provider.placeOrder(orderInput);
            await svc.from("market_gtt_orders").update({
              status: "triggered",
              triggered_at: new Date().toISOString(),
              triggered_leg: leg,
              broker_order_id: result.orderId,
              last_error: null,
            }).eq("id", g.id);
            fired++;
          } catch (e) {
            await svc.from("market_gtt_orders").update({
              status: "failed",
              last_error: e instanceof Error ? e.message : String(e),
            }).eq("id", g.id);
          }
        }
      } catch (e) {
        // one user's failure shouldn't affect others
        console.error(`GTT eval failed for user ${userId}:`, e);
      }
    }

    return new Response(JSON.stringify({ ok: true, checked: gtts.length, fired }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
