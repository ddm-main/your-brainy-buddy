// market-position-convert — change product code on an open position (MIS ↔ CNC ↔ NRML)
// without flattening + re-buying. Kotak Neo only.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";
import { BROKER_PROVIDERS } from "../_shared/market/provider.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";
import { z } from "npm:zod";

const Schema = z.object({
  symbol: z.string().min(1).max(32).regex(/^[A-Z0-9._&-]+$/),
  exchange: z.enum(["NSE", "BSE"]).default("NSE"),
  side: z.enum(["BUY", "SELL"]), // side of the open position: long=BUY, short=SELL
  quantity: z.number().int().positive().max(500_000),
  fromProduct: z.enum(["MIS", "CNC", "NRML"]),
  toProduct: z.enum(["MIS", "CNC", "NRML"]),
});

// 20 conversions / min / user — this is a heavy broker op; runaway loops
// would be catastrophic.
const limiter = createMarketLimiter(20, 60_000);

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const rl = limiter.guard(req, auth.userId); if (rl) return rl;
  let body: unknown; try { body = await req.json(); } catch { return errorResponse(req, "invalid json", 400); }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return errorResponse(req, parsed.error.issues.map((i) => i.message).join("; "), 400);
  if (parsed.data.fromProduct === parsed.data.toProduct) return errorResponse(req, "fromProduct and toProduct must differ", 400);

  try {
    const svc = svcClient();
    const { provider } = await getActiveProvider(svc, auth.userId);
    if (!BROKER_PROVIDERS.includes(provider.name)) return errorResponse(req, "Position conversion requires a Kotak Neo connection", 400);
    await provider.convertPosition(parsed.data);
    return jsonResponse(req, { ok: true });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
