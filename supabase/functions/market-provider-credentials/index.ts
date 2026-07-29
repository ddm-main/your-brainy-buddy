// market-provider-credentials — admin-only management of data-provider API keys.
//
// GET-ish (mode "status"): returns per-provider { key_set, hint, last test }.
// mode "save":   stores an AES-256-GCM encrypted key (plaintext never returned).
// mode "clear":  removes the stored key (env secret, if any, takes over again).
//
// Keys are encrypted with STATEMENT_ENC_SECRET and can only be decrypted by
// service-role edge code — the browser only ever sees a masked hint.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { encryptStatementPassword } from "../_shared/crypto.ts";

const PROVIDERS = new Set(["fmp", "alpha_vantage"]);

function hintFor(key: string): string {
  const tail = key.slice(-4);
  return `••••${tail}`;
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });

  const svc = svcClient();
  const { data: roles } = await svc.from("user_roles")
    .select("role").eq("user_id", auth.userId).eq("role", "admin").maybeSingle();
  if (!roles) return new Response("forbidden", { status: 403, headers: corsFor(req) });

  try {
    const body = await req.json().catch(() => ({}));
    const mode = String(body?.mode ?? "status");

    if (mode === "status") {
      const { data, error } = await svc.from("market_provider_credentials")
        .select("provider,key_set,key_hint,last_tested_at,last_test_ok,last_test_detail,updated_at");
      if (error) return errorResponse(req, error.message, 500);
      return jsonResponse(req, { ok: true, providers: data ?? [] });
    }

    const provider = String(body?.provider ?? "");
    if (!PROVIDERS.has(provider)) return errorResponse(req, "unknown provider", 400);

    if (mode === "clear") {
      const { error } = await svc.from("market_provider_credentials")
        .upsert({ provider, api_key_enc: null, key_set: false, key_hint: null, updated_by: auth.userId, updated_at: new Date().toISOString() });
      if (error) return errorResponse(req, error.message, 500);
      return jsonResponse(req, { ok: true, cleared: true });
    }

    if (mode === "save") {
      const key = String(body?.api_key ?? "").trim();
      if (key.length < 8 || key.length > 512) return errorResponse(req, "API key looks invalid", 400);
      let enc;
      try {
        enc = await encryptStatementPassword(key);
      } catch (e) {
        return errorResponse(req, e instanceof Error ? e.message : "encryption failed", 500);
      }
      const { error } = await svc.from("market_provider_credentials")
        .upsert({
          provider,
          api_key_enc: enc,
          key_set: true,
          key_hint: hintFor(key),
          updated_by: auth.userId,
          updated_at: new Date().toISOString(),
        });
      if (error) return errorResponse(req, error.message, 500);
      return jsonResponse(req, { ok: true, key_hint: hintFor(key) });
    }

    return errorResponse(req, "unknown mode", 400);
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
