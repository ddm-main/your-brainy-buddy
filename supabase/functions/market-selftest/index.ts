// market-selftest — one pass over every data provider and every feed surface.
// Called by the "test everything" button in Market Config (user JWT) and by
// pg_cron (x-cron-secret): every 10 minutes during the NSE session, hourly
// outside it. Results land in market_provider_health,
// market_provider_credentials and market_surface_probes so the UI (and the
// navbar chip) can show current status without probing on every page load.
import { preflight, jsonResponse, errorResponse, requireUserId, corsFor, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { runSelfTest, pruneProbeHistory } from "../_shared/market/selftest.ts";
import { syncEgressUsage, egressSyncStale } from "../_shared/market/egress.ts";

/** NSE cash session, Mon–Fri 09:15–15:30 IST. Must match the client helper in
 *  src/lib/market/feedStatus.ts — the old 15:45 close made the UI and the cron
 *  job disagree about whether the market was open. */
function nseSessionOpen(now = new Date()): boolean {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 555 && mins <= 930;
}


/** IST calendar date (YYYY-MM-DD) for holiday lookups. */
function istDate(now = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/** Exchange holiday — the session-cadence probe must not run at 10-min speed. */
async function isMarketHoliday(svc: ReturnType<typeof svcClient>, now = new Date()): Promise<boolean> {
  const { data, error } = await svc.from("market_holidays")
    .select("holiday_date").eq("exchange", "NSE").eq("holiday_date", istDate(now)).limit(1);
  if (error) { console.error("holiday lookup failed", error.message); return false; }
  return (data ?? []).length > 0;
}

/** Whose Kotak session the cron run should probe with. */
async function ownerUserId(svc: ReturnType<typeof svcClient>): Promise<string | null> {
  const { data } = await svc.from("market_api_settings")
    .select("user_id, session_token_enc, totp_secret_enc, updated_at")
    .order("updated_at", { ascending: false })
    .limit(20);
  const rows = (data ?? []) as Array<{ user_id: string; session_token_enc: string | null; totp_secret_enc: string | null }>;
  return (rows.find((r) => r.session_token_enc)?.user_id
    ?? rows.find((r) => r.totp_secret_enc)?.user_id
    ?? rows[0]?.user_id
    ?? null);
}

/** Skip an hourly tick that lands inside the 10-minute session cadence. */
async function ranRecently(svc: ReturnType<typeof svcClient>, minutes: number): Promise<boolean> {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const { data } = await svc.from("market_surface_probes")
    .select("checked_at").gte("checked_at", since).limit(1);
  return (data ?? []).length > 0;
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  const svc = svcClient();
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const scheduled = String(body?.source ?? "") === "cron" || req.headers.get("x-cron-secret") !== null;
  const action = String(body?.action ?? "");

  let userId: string | null = null;
  if (scheduled) {
    const denied = await requireCronSecret(req);
    if (denied) return denied;
    userId = await ownerUserId(svc);
    if (!userId && action !== "usage-egress") {
      return jsonResponse(req, { ok: true, skipped: "no provider account configured" });
    }
  } else {
    const auth = await requireUserId(req);
    if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
    userId = auth.userId;
  }

  // Egress figure: the Management API is the only source. It rides along here
  // because the project has no free edge-function slots left for a dedicated
  // one. `action: "usage-egress"` is the panel's manual refresh.
  if (action === "usage-egress") {
    const result = await syncEgressUsage(svc);
    return jsonResponse(req, result);
  }

  try {
    const holiday = await isMarketHoliday(svc);
    // A holiday looks like a weekday to a clock-only check, so without this the
    // job would probe every 10 minutes against a closed exchange all day.
    const open = nseSessionOpen() && !holiday;
    // Cadence: every tick runs during the session; outside it the same job
    // collapses to hourly by skipping ticks that follow a recent run. Keyed
    // providers (FMP / Alpha Vantage) have daily call caps, so the fast
    // in-session cadence never probes them.
    const cadence = String(body?.cadence ?? (scheduled ? (open ? "session" : "hourly") : "manual"));
    if (scheduled) {
      // In-session: one run per ~10 min. Off-session: one run per hour.
      const window = open ? 9 : 50;
      if (await ranRecently(svc, window)) {
        return jsonResponse(req, { ok: true, skipped: `already ran within ${window}m` });
      }
    }
    const skipKeyed = cadence === "session";


    const report = await runSelfTest(svc, userId!, { skipKeyed });
    // Keep the status tables bounded — one prune per hourly (off-session) tick.
    let pruned = 0;
    if (scheduled && !open) pruned = await pruneProbeHistory(svc);
    // Refresh the egress figure at most every 6 h on the scheduled path, so the
    // quota panel and the governor stay current without a dedicated cron job.
    let egress: unknown = null;
    if (scheduled && await egressSyncStale(svc, 6)) egress = await syncEgressUsage(svc);
    return jsonResponse(req, { ok: true, cadence, session_open: open, holiday, pruned, egress, ...report });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
