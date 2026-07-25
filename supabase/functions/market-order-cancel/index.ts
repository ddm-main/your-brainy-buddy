// market-order-cancel — cancel a pending Kotak order.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";
import { z } from "npm:zod";

const Schema = z.object({ order_id: z.string().min(1).max(64) });

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  let body: unknown; try { body = await req.json(); } catch { return errorResponse(req, "invalid json", 400); }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return errorResponse(req, "order_id required", 400);
  try {
    const svc = svcClient();
    const { provider } = await getActiveProvider(svc, auth.userId);
    if (provider.name !== "kotak_neo") return errorResponse(req, "Requires Kotak Neo connection", 400);
    const r = await provider.cancelOrder(parsed.data.order_id);
    return jsonResponse(req, { ok: true, order_id: r.orderId, status: r.status });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
