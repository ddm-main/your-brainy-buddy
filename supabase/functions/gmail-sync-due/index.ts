// Scheduled sync entry point. Called by a pg_cron job every ~15 minutes.
// Iterates accounts whose sync_frequency indicates they are overdue, and runs
// the shared sync routine. No user JWT required — this is a cron-triggered
// endpoint keyed on the caller-supplied CRON_SECRET header for safety.

import { svcClient } from "../_shared/gmail.ts";
import { runGmailSync, frequencyToMinutes } from "../_shared/gmail-sync-core.ts";
import { sanitizeError } from "../_shared/errors.ts";
import { verifyCronSecret } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const bad = await verifyCronSecret(req);
  if (bad) return bad;


  const svc = svcClient();
  const { data: accounts, error } = await svc
    .from("email_accounts")
    .select("*")
    .neq("sync_frequency", "manual")
    .is("paused_at", null);
  if (error) {
    const safe = sanitizeError(error, "Scheduled sync failed to load accounts", "gmail-sync-due");
    return new Response(JSON.stringify(safe), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const now = Date.now();
  const results: Array<Record<string, unknown>> = [];

  for (const a of accounts ?? []) {
    const minutes = frequencyToMinutes(a.sync_frequency);
    if (!minutes) continue;
    if (!a.refresh_token && !a.access_token) continue;

    const last = a.last_synced_at ? new Date(a.last_synced_at).getTime() : 0;
    const dueAt = last + minutes * 60_000;
    if (last && dueAt > now) continue;

    try {
      const r = await runGmailSync(svc, a);
      results.push({ id: a.id, email: a.email_address, ...r });
    } catch (e) {
      const safe = sanitizeError(e, "Scheduled sync failed", `gmail-sync-due:${a.id}`);
      results.push({ id: a.id, email: a.email_address, error: safe.error });
    }
  }

  return new Response(JSON.stringify({ ok: true, ran: results.length, results }), {
    headers: { "Content-Type": "application/json" },
  });
});