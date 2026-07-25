// market-order-modify — change price/qty/trigger/validity on a live Kotak order.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";
import { z } from "npm:zod";

const Schema = z.object({
  order_id: z.string().min(1).max(64),
  quantity: z.number().int().positive().max(500_000).optional(),
  price: z.number().positive().optional(),
  triggerPrice: z.number().positive().optional(),
  orderType: z.enum(["MARKET", "LIMIT", "SL", "SL-M"]).optional(),
  validity: z.enum(["DAY", "IOC"]).optional(),
});

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  let body: unknown; try { body = await req.json(); } catch { return errorResponse(req, "invalid json", 400); }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return errorResponse(req, parsed.error.issues.map((i) => i.message).join("; "), 400);
  try {
    const svc = svcClient();
    const { provider } = await getActiveProvider(svc, auth.userId);
    if (provider.name !== "kotak_neo") return errorResponse(req, "Requires Kotak Neo connection", 400);
    const { order_id, ...changes } = parsed.data;
    const r = await provider.modifyOrder(order_id, changes);
    return jsonResponse(req, { ok: true, order_id: r.orderId, status: r.status });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
