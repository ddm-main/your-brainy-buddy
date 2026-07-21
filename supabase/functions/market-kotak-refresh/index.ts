// market-kotak-refresh — refresh Kotak sessions via stored TOTP secrets.
// Callable two ways: by cron (x-cron-secret header) for all users, or by an
// authenticated user for their own row ("Refresh session" button).
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { KOTAK_SETTINGS_COLS, type KotakSettings, KotakError, kotakAutoLogin, persistSession } from "../_shared/market/kotakClient.ts";
import { encryptValue } from "../_shared/market/provider.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const svc = svcClient();
    const isCron = req.headers.get("x-cron-secret") != null;
    let userFilter: string | null = null;

    if (isCron) {
      const guard = await requireCronSecret(req);
      if (guard) return guard;
    } else {
      const auth = await requireUserId(req);
      if ("error" in auth) return auth.error;
      userFilter = auth.userId;
    }

    let q = svc.from("market_api_settings")
      .select(KOTAK_SETTINGS_COLS)
      .eq("active_provider", "kotak_neo")
      .not("totp_secret_enc", "is", null);
    if (userFilter) q = q.eq("user_id", userFilter);
    const { data, error } = await q;
    if (error) return errorResponse(req, error.message, 500);

    const results: Array<{ user_id: string; ok: boolean; error?: string; greeting_name?: string | null }> = [];
    for (const row of (data ?? []) as KotakSettings[]) {
      try {
        const sess = await kotakAutoLogin(row);
        await persistSession(svc, row, sess, encryptValue);
        results.push({ user_id: row.user_id, ok: true, greeting_name: sess.greetingName });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Not a KotakError means the secret itself failed to decode, not a
        // broker/network hiccup — it'll fail identically every night
        // forever. Clear it so the auto-login status shown in Settings
        // reflects reality instead of silently retrying a known-dead value.
        const badSecret = !(e instanceof KotakError);
        await svc.from("market_api_settings")
          .update({
            connection_status: "error",
            last_error: badSecret ? `Saved TOTP secret is invalid (${msg}) — cleared, re-save it to restore auto-login.` : `refresh: ${msg}`,
            ...(badSecret ? { totp_secret_enc: null } : {}),
          })
          .eq("id", row.id);
        results.push({ user_id: row.user_id, ok: false, error: msg });
      }
    }
    return jsonResponse(req, { ok: true, refreshed: results });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
