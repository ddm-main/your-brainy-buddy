import { preflight, jsonResponse, errorResponse, requireUserId, corsFor } from "../_shared/market/common.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  return errorResponse(req, "Kotak portfolio sync ships in Phase 1.5. Add holdings manually for now.", 501);
});
