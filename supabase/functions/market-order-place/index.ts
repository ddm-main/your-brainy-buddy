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
});

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });

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

  const svc = svcClient();
  try {
    const { provider } = await getActiveProvider(svc, auth.userId);
    if (provider.name !== "kotak_neo") {
      return errorResponse(req, "Order placement requires an active Kotak Neo connection. Connect it in Market → Config.", 400);
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
        const notional = input.quantity * refPrice;
        if (funds?.available_margin != null && funds.available_margin > 0 && notional > funds.available_margin) {
          return errorResponse(req, `Insufficient margin: order needs ₹${notional.toFixed(0)} but only ₹${funds.available_margin.toFixed(0)} available. Set skipMarginCheck to override.`, 400);
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
    return jsonResponse(req, { ok: true, order_id: result.orderId, status: result.status });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
