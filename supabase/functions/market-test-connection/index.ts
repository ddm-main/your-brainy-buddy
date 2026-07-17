import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const svc = svcClient();
  const { data } = await svc.from("market_api_settings").select("active_provider,connection_status")
    .eq("user_id", auth.userId).eq("connection_status", "connected").maybeSingle();
  return jsonResponse(req, { ok: Boolean(data), provider: data?.active_provider ?? null });
});
