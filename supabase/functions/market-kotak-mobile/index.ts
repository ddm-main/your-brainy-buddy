// market-kotak-mobile — decrypt and return just the saved Kotak mobile
// number for the authenticated user, so the Settings form can show it back
// (relatively low-sensitivity — it's contact info, not a credential). MPIN
// and the TOTP secret deliberately have no equivalent endpoint: those are
// the actual trading PIN and the seed that generates every future login
// code, and never get decrypted back to the browser.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { decryptStatementPassword, type StatementPasswordRule } from "../_shared/crypto.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const svc = svcClient();
    const { data, error } = await svc.from("market_api_settings")
      .select("mobile_number_enc")
      .eq("user_id", auth.userId).eq("active_provider", "kotak_neo").maybeSingle();
    if (error) return errorResponse(req, error.message, 500);
    const enc = data?.mobile_number_enc as string | null;
    if (!enc) return jsonResponse(req, { mobile_number: null });
    const mobile_number = await decryptStatementPassword(JSON.parse(enc) as StatementPasswordRule);
    return jsonResponse(req, { mobile_number });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
