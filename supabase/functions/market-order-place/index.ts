// market-order-place — validated, funds-aware order entry against the
// user's active broker. Yahoo provider rejects; only Kotak Neo places.
//
// Pre-trade guardrails:
//   - Zod validation of every field.
//   - For BUY orders with a resolvable price we require notional ≤ available_margin
//     (falls back to the fresh snapshot). Zero-margin accounts still place —
//     the broker will reject with a clean error we surface.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider, type FundsSnapshot } from "../_shared/market/provider.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";
import { KotakAmbiguousOrderError } from "../_shared/market/kotakClient.ts";
import { z } from "npm:zod";

const OrderSchema = z.object({
  symbol: z.string().min(1).max(32).regex(/^[A-Z0-9._&-]+$/),
  exchange: z.enum(["NSE", "BSE"]).default("NSE"),
  side: z.enum(["BUY", "SELL"]),
  quantity: z.number().int().positive().max(500_000),
  orderType: z.enum(["MARKET", "LIMIT", "SL", "SL-M"]),
  product: z.enum(["MIS", "CNC", "NRML"]),
  price: z.number().positive().optional(),
  triggerPrice: z.number().positive().optional(),
  validity: z.enum(["DAY", "IOC"]).default("DAY"),
  disclosedQuantity: z.number().int().nonnegative().optional(),
  amo: z.boolean().optional(),
  skipMarginCheck: z.boolean().optional(),
  // Client-generated, stable across retries of the same order intent (see
  // OrderTicket.tsx — regenerated only when the ticket is reopened for a
  // new order). Lets a network-timeout retry or double-click be answered
  // with the original result instead of placing the order twice.
  idempotencyKey: z.string().min(8).max(128).optional(),
});

// 60 orders / minute per user — well beyond any human, catches runaway
// loops. Kotak itself will throttle much sooner, but a friendly 429 here
// avoids burning API budget and leaves an audit trail.
const limiter = createMarketLimiter(60, 60_000);

// Intraday leverage assumed for the margin guardrail. Kotak's real leverage
// per scrip varies and F&O SPAN margin isn't derivable client-side; these
// constants keep the check useful (catches obvious over-orders) without
// false-rejecting reasonable MIS trades. Broker validation is the backstop.
const PRODUCT_LEVERAGE: Record<string, number> = { MIS: 5, CNC: 1, NRML: 1 };

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const rl = limiter.guard(req, auth.userId); if (rl) return rl;

  let body: unknown;
  try { body = await req.json(); } catch { return errorResponse(req, "invalid json", 400); }
  const parsed = OrderSchema.safeParse(body);
  if (!parsed.success) return errorResponse(req, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), 400);
  const input = parsed.data;

  // Field-shape rules the schema alone can't express.
  if ((input.orderType === "LIMIT" || input.orderType === "SL") && !input.price) {
    return errorResponse(req, "price is required for LIMIT / SL orders", 400);
  }
  if ((input.orderType === "SL" || input.orderType === "SL-M") && !input.triggerPrice) {
    return errorResponse(req, "triggerPrice is required for SL / SL-M orders", 400);
  }
  // NSE iceberg rule: disclosed qty must be ≥ 10% of order qty (or 0 = no iceberg).
  if (input.disclosedQuantity && input.disclosedQuantity > 0) {
    const minDq = Math.ceil(input.quantity * 0.10);
    if (input.disclosedQuantity < minDq) {
      return errorResponse(req, `disclosedQuantity must be at least 10% of quantity (min ${minDq})`, 400);
    }
    if (input.disclosedQuantity > input.quantity) {
      return errorResponse(req, "disclosedQuantity cannot exceed quantity", 400);
    }
  }

  const svc = svcClient();

  // Idempotency: claim the intent before touching the broker. A repeat call
  // with the same key either replays the stored result (already placed) or
  // is rejected as still in-flight — it never reaches provider.placeOrder()
  // twice.
  let intentId: string | null = null;
  if (input.idempotencyKey) {
    const { data: inserted, error: insErr } = await svc
      .from("market_order_intents")
      .insert({ user_id: auth.userId, idempotency_key: input.idempotencyKey, request: input })
      .select("id")
      .single();
    if (insErr) {
      if (insErr.code === "23505") {
        const { data: existing } = await svc
          .from("market_order_intents")
          .select("id,status,broker_order_id,broker_status")
          .eq("user_id", auth.userId).eq("idempotency_key", input.idempotencyKey)
          .maybeSingle();
        if (existing?.status === "placed") {
          return jsonResponse(req, { ok: true, order_id: existing.broker_order_id, status: existing.broker_status, replayed: true });
        }
        if (existing?.status === "pending") {
          return errorResponse(req, "This order is already being placed — check Orders before resubmitting.", 409);
        }
        if (existing?.status === "ambiguous") {
          return errorResponse(req, "The last attempt under this order ticket hit a session error mid-request and it's unknown whether the broker received it. Check Orders/Trades to confirm before placing a fresh order.", 409);
        }
        // status === "failed": the prior attempt never reached the broker
        // (or was cleanly rejected before placement); legitimate to retry
        // under the same key. Re-claim it.
        if (existing) {
          await svc.from("market_order_intents").update({ status: "pending", error: null }).eq("id", existing.id);
          intentId = existing.id;
        }
      } else {
        return errorResponse(req, "Could not record order intent — try again.", 502);
      }
    } else {
      intentId = inserted.id;
    }
  }

  // Any early return past this point that isn't a successful placement must
  // release the intent row (mark it 'failed') so a legitimate retry under
  // the same key isn't blocked forever by a row stuck 'pending'.
  const failIntent = async (message: string, status: number) => {
    if (intentId) await svc.from("market_order_intents").update({ status: "failed", error: message }).eq("id", intentId);
    return errorResponse(req, message, status);
  };

  try {
    const { provider } = await getActiveProvider(svc, auth.userId);
    if (provider.name !== "kotak_neo") {
      return await failIntent("Order placement requires an active Kotak Neo connection. Connect it in Market → Config.", 400);
    }

    // Funds guardrail — buys only. Uses today's snapshot; refreshes if missing/stale.
    // For MARKET orders (no explicit price/triggerPrice) we still enforce a
    // rough guardrail by fetching the current LTP; previously MARKET buys
    // bypassed the check entirely, which let obviously-oversized orders
    // through to the broker without a friendly early rejection.
    if (input.side === "BUY" && !input.skipMarginCheck) {
      let refPrice = input.price ?? input.triggerPrice;
      if (!refPrice) {
        try {
          const q = await provider.getQuotes([`${input.exchange}:${input.symbol}`]);
          if (q[0]?.price) refPrice = q[0].price;
        } catch { /* fall through — broker rejection is the backstop */ }
      }
      if (refPrice) {
        let funds: FundsSnapshot | null = null;
        const { data: cached } = await svc.from("market_funds")
          .select("available_margin,synced_at").eq("user_id", auth.userId).maybeSingle();
        const stale = !cached || (Date.now() - new Date(cached.synced_at).getTime()) > 5 * 60_000;
        if (stale) {
          try { funds = await provider.getFunds(); } catch { /* fall through */ }
        } else {
          funds = { available_margin: cached.available_margin, net_cash: null, used_margin: null, collateral: null, payin_amount: null, source: "kotak" };
        }
        // Leverage-aware guardrail: MIS gets ~5× (equity intraday), CNC
        // needs full cash (1×). Previously every product was treated as
        // 1×, which false-rejected legitimate MIS orders on small accounts
        // (a ₹200k MIS order on ₹50k free margin is fine at 5×, but was
        // being blocked as "insufficient").
        const leverage = PRODUCT_LEVERAGE[input.product] ?? 1;
        const notional = input.quantity * refPrice;
        const marginNeeded = notional / leverage;
        if (funds?.available_margin != null && funds.available_margin > 0 && marginNeeded > funds.available_margin) {
          return await failIntent(`Insufficient margin: ${input.product} order needs ₹${marginNeeded.toFixed(0)} (notional ₹${notional.toFixed(0)} at ${leverage}× leverage) but only ₹${funds.available_margin.toFixed(0)} available. Set skipMarginCheck to override.`, 400);
        }
      }
    }

    const result = await provider.placeOrder({
      symbol: input.symbol,
      exchange: input.exchange,
      side: input.side,
      quantity: input.quantity,
      orderType: input.orderType,
      product: input.product,
      price: input.price,
      triggerPrice: input.triggerPrice,
      validity: input.validity,
      disclosedQuantity: input.disclosedQuantity,
      amo: input.amo,
    });
    if (intentId) {
      await svc.from("market_order_intents")
        .update({ status: "placed", broker_order_id: result.orderId, broker_status: result.status })
        .eq("id", intentId);
    }
    return jsonResponse(req, { ok: true, order_id: result.orderId, status: result.status });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof KotakAmbiguousOrderError) {
      if (intentId) await svc.from("market_order_intents").update({ status: "ambiguous", error: message }).eq("id", intentId);
      return errorResponse(req, message, 502);
    }
    return await failIntent(message, 502);
  }
});
