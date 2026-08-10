// market-system-feed — status of the app-wide market-data feed.
//
// Market data (quotes, indices, candles, depth) is NOT account-bound: every
// signed-in user reads it from one designated Kotak Neo connection
// (market_api_settings.is_system). Users connect their own Kotak only for
// account-bound things — orders, holdings, positions, funds, GTT, AutoTrade.
//
// GET-ish default action returns a token-free status payload any signed-in
// user may read (so price banners can say "system feed degraded" instead of
// wrongly telling the user to connect a broker). `action: "designate"` flips
// the designation and is admin-only.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { invalidateSystemFeedCache } from "../_shared/market/provider.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";

const limiter = createMarketLimiter(60, 60_000);

const STATUS_COLS = "id,user_id,active_provider,connection_status,ucc,greeting_name,last_sync_at,last_error,token_expires_at,updated_at,is_system,purpose";

const BROKERS = ["kotak_neo"];

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const rl = limiter.guard(req, auth.userId); if (rl) return rl;

  try {
    const svc = svcClient();
    const body = await req.json().catch(() => ({}));
    const action = String((body as any)?.action ?? "status");

    const isAdmin = await svc
      .from("user_roles").select("role").eq("user_id", auth.userId).eq("role", "admin").maybeSingle()
      .then((r) => !!r.data, () => false);

    // Create (or return) a data-feed connection row for a broker. Data feeds
    // are app-wide plumbing — owned by the admin who created them, but never
    // mixed with that admin's personal trading connection.
    if (action === "create_data_feed") {
      if (!isAdmin) return errorResponse(req, "admin_only", 403);
      const provider = String((body as any)?.provider ?? "");
      if (!BROKERS.includes(provider)) return errorResponse(req, "unsupported provider");
      const { data: existing } = await svc
        .from("market_api_settings").select("id")
        .eq("user_id", auth.userId).eq("active_provider", provider).eq("purpose", "data").maybeSingle();
      if (!existing) {
        const { error: insErr } = await svc.from("market_api_settings").insert({
          user_id: auth.userId,
          active_provider: provider,
          purpose: "data",
          connection_status: "disconnected",
        });
        if (insErr) throw insErr;
      }
      invalidateSystemFeedCache();
    }

    if (action === "designate") {
      if (!isAdmin) return errorResponse(req, "admin_only", 403);
      const id = String((body as any)?.id ?? "");
      if (!id) return errorResponse(req, "id required");
      const { data: target, error: tErr } = await svc
        .from("market_api_settings").select("id,active_provider,purpose").eq("id", id).maybeSingle();
      if (tErr) throw tErr;
      if (!target) return errorResponse(req, "connection not found", 404);
      if (target.purpose !== "data") return errorResponse(req, "only a data-feed connection can serve market data");
      if (!BROKERS.includes(target.active_provider)) return errorResponse(req, "unsupported provider for the data feed");
      // Unique partial index allows exactly one system row — clear first.
      const { error: clearErr } = await svc.from("market_api_settings").update({ is_system: false }).eq("is_system", true);
      if (clearErr) throw clearErr;
      const { error: setErr } = await svc.from("market_api_settings").update({ is_system: true }).eq("id", id);
      if (setErr) throw setErr;
      invalidateSystemFeedCache();
    }

    // Status — the designated data feed, and nothing else. If no admin feed is
    // designated, prices come from public vendors; we say so honestly instead
    // of pointing at some user's broker session.
    const { data: designated } = await svc
      .from("market_api_settings").select(STATUS_COLS)
      .eq("is_system", true).eq("purpose", "data").limit(1);
    const row = (designated ?? [])[0] ?? null;
    const designatedFlag = !!row;


    const owned = !!row && row.user_id === auth.userId;
    return jsonResponse(req, {
      // Non-sensitive for every signed-in user:
      configured: !!row,
      designated: designatedFlag,
      status: row?.connection_status ?? "none",
      healthy: row?.connection_status === "connected",
      last_error: isAdmin || owned ? (row?.last_error ?? null) : null,
      last_sync_at: row?.last_sync_at ?? null,
      token_expires_at: row?.token_expires_at ?? null,
      // Identity of the feed account only for admins / its owner.
      id: isAdmin ? (row?.id ?? null) : null,
      ucc: isAdmin || owned ? (row?.ucc ?? null) : null,
      provider: row?.active_provider ?? null,
      is_owner: owned,
      is_admin: isAdmin,

    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
