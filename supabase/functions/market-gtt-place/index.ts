// market-gtt-place — create a Good-Till-Triggered order. Kotak Neo has no
// native GTT so we watch the trigger locally in market-gtt-eval and place
// a real order via market-order-place once LTP crosses the trigger.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";
import { z } from "npm:zod";

const Schema = z.object({
  symbol: z.string().min(1).max(32).regex(/^[A-Z0-9._&-]+$/),
  exchange: z.enum(["NSE", "BSE"]).default("NSE"),
  side: z.enum(["BUY", "SELL"]),
  triggerType: z.enum(["single", "OCO"]).default("single"),
  triggerPrice: z.number().positive(),
  triggerPriceUpper: z.number().positive().optional(),
  orderType: z.enum(["MARKET", "LIMIT"]).default("LIMIT"),
  price: z.number().positive().optional(),
  quantity: z.number().int().positive().max(500_000),
  product: z.enum(["MIS", "CNC", "NRML"]).default("CNC"),
  expiresAt: z.string().datetime().optional(),
  notes: z.string().max(500).optional(),
});
const limiter = createMarketLimiter(30, 60_000);

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const rl = limiter.guard(req, auth.userId); if (rl) return rl;
  let body: unknown; try { body = await req.json(); } catch { return errorResponse(req, "invalid json", 400); }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return errorResponse(req, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), 400);
  const p = parsed.data;

  if (p.orderType === "LIMIT" && !p.price) return errorResponse(req, "price is required for LIMIT GTT", 400);
  if (p.triggerType === "OCO") {
    if (!p.triggerPriceUpper) return errorResponse(req, "triggerPriceUpper is required for OCO", 400);
    if (p.triggerPriceUpper <= p.triggerPrice) return errorResponse(req, "triggerPriceUpper must be greater than triggerPrice (lower leg)", 400);
  }

  try {
    const svc = svcClient();
    const { data, error } = await svc.from("market_gtt_orders").insert({
      user_id: auth.userId,
      symbol: p.symbol,
      exchange: p.exchange,
      side: p.side,
      trigger_type: p.triggerType,
      trigger_price: p.triggerPrice,
      trigger_price_upper: p.triggerPriceUpper ?? null,
      order_type: p.orderType,
      price: p.price ?? null,
      quantity: p.quantity,
      product: p.product,
      expires_at: p.expiresAt ?? null,
      notes: p.notes ?? null,
      status: "active",
    }).select("id").single();
    if (error) return errorResponse(req, error.message, 500);
    return jsonResponse(req, { ok: true, id: data?.id });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
