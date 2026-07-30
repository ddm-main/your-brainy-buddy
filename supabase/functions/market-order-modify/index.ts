// market-order-modify — change price/qty/trigger/validity on a live Kotak order.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";
import { BROKER_PROVIDERS } from "../_shared/market/provider.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";
import { z } from "npm:zod";

const Schema = z.object({
  order_id: z.string().min(1).max(64),
  quantity: z.number().int().positive().max(500_000).optional(),
  price: z.number().positive().optional(),
  triggerPrice: z.number().positive().optional(),
  orderType: z.enum(["MARKET", "LIMIT", "SL", "SL-M"]).optional(),
  validity: z.enum(["DAY", "IOC"]).optional(),
});
// 30 modifies / minute per user.
const limiter = createMarketLimiter(30, 60_000);

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const rl = limiter.guard(req, auth.userId); if (rl) return rl;
  let body: unknown; try { body = await req.json(); } catch { return errorResponse(req, "invalid json", 400); }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return errorResponse(req, parsed.error.issues.map((i) => i.message).join("; "), 400);
  // Same shape rules the Place endpoint enforces — a bare modify to
  // orderType:"SL" with no triggerPrice was previously round-tripping to the
  // broker for a cryptic rejection instead of failing fast here.
  const { orderType, price, triggerPrice } = parsed.data;
  if ((orderType === "LIMIT" || orderType === "SL") && price == null) {
    return errorResponse(req, "price is required when changing orderType to LIMIT / SL", 400);
  }
  if ((orderType === "SL" || orderType === "SL-M") && triggerPrice == null) {
    return errorResponse(req, "triggerPrice is required when changing orderType to SL / SL-M", 400);
  }
  try {
    const svc = svcClient();
    const { provider } = await getActiveProvider(svc, auth.userId);
    if (!BROKER_PROVIDERS.includes(provider.name)) return errorResponse(req, "Requires Kotak Neo connection", 400);
    const { order_id, ...changes } = parsed.data;
    const r = await provider.modifyOrder(order_id, changes);
    return jsonResponse(req, { ok: true, order_id: r.orderId, status: r.status });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});

