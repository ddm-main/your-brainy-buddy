// market-feed-routing — the only writer of market_feed_prefs.
//
// The panel used to write the table straight from the browser. That left the
// edge side serving the previous pin for up to the route cache's TTL, so a
// freshly saved Primary looked like it "didn't take". Saving through here lets
// us drop the cache in the same breath as the write, and keeps the write
// admin-only in code rather than relying on policy shape alone.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { getFeedRoutes, invalidateFeedRouteCache } from "../_shared/market/feedRoute.ts";

const PROVIDERS = new Set(["kotak", "yahoo", "nse", "fmp", "alpha", "computed"]);
const clean = (v: unknown): string | null => {
  const s = String(v ?? "auto").trim().toLowerCase();
  if (!s || s === "auto") return null;
  return PROVIDERS.has(s) ? s : null;
};

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const auth = await requireUserId(req);
    if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
    const svc = svcClient();
    const b = await req.json().catch(() => ({}));
    const action = String(b?.action ?? "save");

    if (action === "list") {
      invalidateFeedRouteCache();
      return jsonResponse(req, { routes: await getFeedRoutes(svc) });
    }

    // Routing is an app-wide operator decision.
    const isAdmin = await svc
      .from("user_roles").select("role").eq("user_id", auth.userId).eq("role", "admin").maybeSingle()
      .then((r) => !!r.data, () => false);
    if (!isAdmin) return errorResponse(req, "admin_only", 403);

    const feedId = String(b?.feed_id ?? "").trim();
    if (!feedId) return errorResponse(req, "feed_id required");
    const primary = clean(b?.provider);
    const fallback = clean(b?.fallback_provider);
    if (b?.provider && b.provider !== "auto" && !primary) return errorResponse(req, `unknown provider: ${b.provider}`);
    if (b?.fallback_provider && b.fallback_provider !== "auto" && !fallback) {
      return errorResponse(req, `unknown fallback provider: ${b.fallback_provider}`);
    }

    // Replace rather than upsert: the unique index is partial
    // (feed_id WHERE scope='system'), which PostgREST cannot infer.
    const { error: delErr } = await svc.from("market_feed_prefs")
      .delete().eq("feed_id", feedId).eq("scope", "system");
    if (delErr) return errorResponse(req, delErr.message, 500);

    if (primary || fallback) {
      const { error } = await svc.from("market_feed_prefs").insert({
        scope: "system", user_id: null, feed_id: feedId,
        // `provider` is NOT NULL — a fallback-only pin still needs a primary,
        // so an explicit "auto" primary is stored as the fallback itself.
        provider: primary ?? fallback,
        fallback_provider: primary ? fallback : null,
      });
      if (error) return errorResponse(req, error.message, 500);
    }

    // The whole point of routing through an edge function.
    invalidateFeedRouteCache();
    return jsonResponse(req, { ok: true, feed_id: feedId, provider: primary, fallback_provider: fallback });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
