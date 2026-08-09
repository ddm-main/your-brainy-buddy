// market-shoonya-login — mint (or refresh) a Shoonya (Finvasia Noren) session.
//
// Uses Shoonya's OAuth code flow: called with no body this returns the consent
// URL; called with { code } it exchanges the code for an access token.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { encryptStatementPassword } from "../_shared/crypto.ts";
import {
  SHOONYA_SETTINGS_COLS,
  ShoonyaError,
  persistShoonyaSession,
  shoonyaAuthorizeUrl,
  shoonyaLoginWithCode,
  type ShoonyaSettings,
} from "../_shared/market/shoonyaClient.ts";
import { invalidateSystemFeedCache } from "../_shared/market/provider.ts";

const encrypt = async (v: string) => JSON.stringify(await encryptStatementPassword(v));

async function loginForUser(
  svc: ReturnType<typeof svcClient>,
  userId: string,
  code?: string,
  redirectUrl?: string,
  state?: string,
  purpose: "account" | "data" = "account",
): Promise<{ ok: boolean; detail: string; greeting_name?: string | null; authorize_url?: string }> {
  const { data, error } = await svc.from("market_api_settings")
    .select(SHOONYA_SETTINGS_COLS)
    .eq("user_id", userId).eq("active_provider", "shoonya").eq("purpose", purpose);
  if (error) throw new ShoonyaError(error.message, 500);
  const rows = (data ?? []) as unknown as ShoonyaSettings[];
  const s = rows.find((r) => !!r.api_secret_enc) ?? rows[0];
  if (!s) return { ok: false, detail: "Shoonya is not configured yet" };

  if (!code) {
    // No authorization code yet: hand the caller the consent URL.
    try {
      return {
        ok: false,
        detail: "Open Shoonya, enter your password/TOTP there, then paste the returned redirect URL or its `code=` value here.",
        authorize_url: shoonyaAuthorizeUrl(s, redirectUrl, state),
      };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  try {
    const sess = await shoonyaLoginWithCode(s, code);
    await persistShoonyaSession(svc, s, sess, encrypt);
    if (purpose === "data") invalidateSystemFeedCache();
    return { ok: true, detail: `Connected as ${sess.greetingName ?? sess.uid}`, greeting_name: sess.greetingName };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await svc.from("market_api_settings")
      .update({ connection_status: "error", session_token_enc: null, token_expires_at: null, last_error: detail })
      .eq("id", s.id);
    return { ok: false, detail };
  }
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const body = await req.json().catch(() => ({} as Record<string, unknown>));

  // Cron path: refresh every configured Shoonya connection before the session
  // is first needed in the morning.
  const cronDenied = await requireCronSecret(req);
  if (!cronDenied) {
    const svc = svcClient();
    const { data } = await svc.from("market_api_settings")
      .select("user_id").eq("active_provider", "shoonya").not("api_secret_enc", "is", null);
    const users = [...new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id))];
    // Shoonya's OAuth flow needs interactive consent, so cron can only report.
    return jsonResponse(req, {
      ok: true,
      refreshed: 0,
      pending: users.length,
      detail: "Shoonya requires interactive OAuth authorization; unattended refresh is not possible.",
    });
  }

  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const code = typeof body?.code === "string" && body.code.trim() ? body.code.trim() : undefined;
    const redirectUrl = trustedShoonyaRedirect(body?.redirect_url);
    const state = trustedShoonyaState(body?.state);
    const purpose = String((body as any)?.purpose ?? "account") === "data" ? "data" : "account";
    const r = await loginForUser(svcClient(), auth.userId, code, redirectUrl, state, purpose);
    // Returning the authorization URL is the successful first stage of the
    // flow, not an HTTP error; the browser must be able to read and open it.
    return jsonResponse(req, r, r.ok || r.authorize_url ? 200 : 400);
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});

function trustedShoonyaRedirect(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const u = new URL(raw.trim());
    const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
    const expectedOrigin = supabaseUrl ? new URL(supabaseUrl).origin : null;
    if (u.protocol !== "https:") return undefined;
    if (expectedOrigin && u.origin !== expectedOrigin) return undefined;
    if (!u.pathname.startsWith("/functions/v1/shoonya-oauth-callback")) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

function trustedShoonyaState(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const cleaned = decodeURIComponent(raw.trim()).replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(cleaned.padEnd(Math.ceil(cleaned.length / 4) * 4, "="));
    const origin = new URL(decoded).origin;
    if (origin === "http://localhost:8080") return raw.trim();
    if (/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(lovable\.app|lovableproject\.com)$/i.test(origin)) return raw.trim();
  } catch {
    return undefined;
  }
  return undefined;
}
