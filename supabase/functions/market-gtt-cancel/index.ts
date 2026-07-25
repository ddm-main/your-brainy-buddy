// market-gtt-cancel — flip an active GTT to 'cancelled'. RLS enforces
// ownership; a stale/completed GTT is a no-op (idempotent).
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";
import { z } from "npm:zod";

const Schema = z.object({ id: z.string().uuid() });
const limiter = createMarketLimiter(60, 60_000);

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const rl = limiter.guard(req, auth.userId); if (rl) return rl;
  let body: unknown; try { body = await req.json(); } catch { return errorResponse(req, "invalid json", 400); }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return errorResponse(req, "id required (uuid)", 400);
  try {
    const svc = svcClient();
    const { error } = await svc.from("market_gtt_orders")
      .update({ status: "cancelled" })
      .eq("id", parsed.data.id)
      .eq("user_id", auth.userId)
      .eq("status", "active");
    if (error) return errorResponse(req, error.message, 500);
    return jsonResponse(req, { ok: true });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
