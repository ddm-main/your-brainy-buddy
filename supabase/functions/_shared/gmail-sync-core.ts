// Shared Gmail sync routine used by both the on-demand `gmail-sync` endpoint
// and the scheduled `gmail-sync-due` cron function. Keeps per-account rules in
// one place so the two callers cannot drift.

import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ensureAccessToken, gapi, parseFrom, parseHeaders } from "./gmail.ts";
import { buildGmailQuery } from "./finance-senders.ts";
import { isFinanceMail } from "./finance-parsers.ts";
import { extractFinanceForAccount } from "./finance-extract-core.ts";
import { sanitizeError } from "./errors.ts";

export type SyncResult =
  | { ok: true; paused?: false; inserted: number; total: number; q: string }
  | { ok: true; paused: true; inserted: 0; total: 0; q: string };

export async function runGmailSync(
  svc: SupabaseClient,
  account: any,
  overrideMax?: number,
): Promise<SyncResult> {
  const q = buildGmailQuery({
    sync_period_days: account.sync_period_days,
    finance_only: account.finance_only,
    use_case: account.use_case,
    finance_sender_filter: account.finance_sender_filter,
    treat_all_as_finance: account.treat_all_as_finance,
  });

  if (account.paused_at) {
    return { ok: true, paused: true, inserted: 0, total: 0, q };
  }

  const maxResults = Math.max(
    1,
    Math.min(500, Number(overrideMax ?? account.max_per_sync ?? 100)),
  );

  await svc
    .from("email_accounts")
    .update({ sync_status: "syncing", last_error: null })
    .eq("id", account.id);

  try {
    const token = await ensureAccessToken(svc, account);
    const ids: { id: string; threadId: string }[] = [];
    let latestHistoryId: string | null = null;
    let pageToken: string | null = null;
    while (ids.length < maxResults) {
      const pageSize = Math.min(500, maxResults - ids.length);
      const page = await gapi(
        token,
        `/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${pageSize}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      );
      ids.push(...(page.messages ?? []));
      latestHistoryId = page.historyId || latestHistoryId;
      pageToken = page.nextPageToken ?? null;
      if (!pageToken) break;
    }
    let inserted = 0;

    for (const m of ids) {
      const { data: existing } = await svc
        .from("emails")
        .select("id")
        .eq("user_id", account.user_id)
        .eq("account_id", account.id)
        .eq("external_email_id", m.id)
        .maybeSingle();
      if (existing) continue;

      const meta = await gapi(
        token,
        `/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`,
      );
      const h = parseHeaders(meta.payload?.headers ?? []);
      const from = parseFrom(h["from"]);
      const receivedAt = meta.internalDate
        ? new Date(Number(meta.internalDate)).toISOString()
        : null;

      const subject = h["subject"] ?? null;
      const snippet = meta.snippet ?? null;
      const financeRelated = isFinanceMail({ from_email: from.email, subject, snippet });

      const { error: insErr } = await svc.from("emails").insert({
        user_id: account.user_id,
        account_id: account.id,
        provider: "gmail",
        external_email_id: m.id,
        thread_id: m.threadId,
        from_name: from.name,
        from_email: from.email,
        subject,
        snippet,
        received_at: receivedAt,
        finance_related: financeRelated,
        category: financeRelated ? "finance" : null,
      });
      if (!insErr) inserted++;
      else if (!String(insErr.message).includes("duplicate"))
        console.warn("insert failed", insErr.message);
    }

    await svc
      .from("email_accounts")
      .update({
        sync_status: "ok",
        last_synced_at: new Date().toISOString(),
        history_id: latestHistoryId,
        last_error: null,
      })
      .eq("id", account.id);

    // Best-effort finance extraction over what we just pulled.
    let extracted = { transactions: 0, statements: 0, scanned: 0 };
    try {
      const r = await extractFinanceForAccount(svc, account, { sinceDays: Math.max(7, Number(account.sync_period_days ?? 30)), limit: Math.max(100, Number(account.max_per_sync ?? 100)) });
      extracted = { transactions: r.transactions, statements: r.statements, scanned: r.scanned };
    } catch (e) {
      console.warn("finance-extract failed:", e instanceof Error ? e.message : e);
    }

    return { ok: true, inserted, total: ids.length, q, extracted } as any;
  } catch (e) {
    // Sanitize what's persisted to last_error (rendered verbatim in the UI),
    // but re-throw the ORIGINAL error — callers' own console.error still
    // needs full detail. Sanitize once, at the human-facing boundary.
    const safe = sanitizeError(e, "Gmail sync failed", `gmail-sync-core:${account.id}`);
    await svc
      .from("email_accounts")
      .update({ sync_status: "error", last_error: safe.error })
      .eq("id", account.id);
    throw e;
  }
}

// How many minutes must have elapsed since last_synced_at before the account
// is due for another automatic sync.
export function frequencyToMinutes(freq: string | null | undefined): number | null {
  switch (freq) {
    case "15m": return 15;
    case "hourly": return 60;
    case "6h": return 360;
    case "daily": return 1440;
    default: return null; // 'manual' or unknown → not scheduled
  }
}