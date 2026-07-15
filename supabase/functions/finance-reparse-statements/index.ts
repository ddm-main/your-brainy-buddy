// Authenticated maintenance endpoint: re-parse every unresolved statement for
// the current user. It prefers already-stored statement PDFs, and only falls
// back to Gmail re-fetch when no stored PDF exists. No rows/columns are dropped.

import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { svcClient } from "../_shared/gmail.ts";
import { ingestStatementAttachment, parseStoredStatementPdf, resolveLinks } from "../_shared/finance-extract-core.ts";
import { guessBankSlugFromSender, parseFinanceEmail } from "../_shared/finance-parsers.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";

const limiter = createSlidingWindowLimiter(3, 60_000);

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);

  const auth = await requireUserId(req);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const uid = auth.userId;

  const rl = limiter.check(uid);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }), {
      status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const sinceDays = Math.max(1, Math.min(3650, Number(body?.since_days ?? 3650)));
    const includeIncompleteParsed = body?.include_incomplete_parsed !== false;
    // Keep batch small — PDF parsing is CPU-heavy and edge workers cap at ~2s
    // wall-clock per invocation. Frontend loops until remaining_after == 0.
    const cap = Math.max(1, Math.min(10, Number(body?.limit ?? 3)));
    const DEADLINE_MS = 1_600;
    const startedAt = Date.now();
    const cutoff = new Date(Date.now() - sinceDays * 86400_000).toISOString();

    const svc = svcClient();
    const { data: unresolvedRows, error } = await svc.from("statements")
      .select("id, user_id, statement_type, source_email_id, file_path, parse_status, credit_card_id, financial_account_id, loan_id, linked_bank_id, learn_attempts")
      .eq("user_id", uid)
      .in("parse_status", ["pending", "failed", "skipped"])
      .gte("created_at", cutoff)
      .order("updated_at", { ascending: true, nullsFirst: true })
      .limit(cap);
    if (error) throw error;

    let rows = unresolvedRows ?? [];
    if (includeIncompleteParsed && rows.length < cap) {
      // Only CARD statements have a lifecycle to reconcile. Accounts are
      // info-only, so treating an account row as "incomplete" for missing
      // due_date/total_due would loop forever. Drop the 3-attempt cap —
      // instead, only requeue if we haven't tried in the last 24 hours.
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
      const { data: incompleteRows, error: incompleteErr } = await svc.from("statements")
        .select("id, user_id, statement_type, source_email_id, file_path, parse_status, credit_card_id, financial_account_id, loan_id, linked_bank_id, learn_attempts")
        .eq("user_id", uid)
        .eq("parse_status", "parsed")
        .eq("statement_type", "card")
        .gte("created_at", cutoff)
        .or(`last_learn_at.is.null,last_learn_at.lt.${twentyFourHoursAgo}`)
        .or("statement_date.is.null,due_date.is.null,total_due.is.null,transactions_found.eq.0")
        .order("updated_at", { ascending: true, nullsFirst: true })
        .limit(cap - rows.length);
      if (incompleteErr) throw incompleteErr;
      rows = [...rows, ...(incompleteRows ?? [])];
    }

    let parsed = 0;
    let failed = 0;
    let stillUnresolved = 0;
    let processed = 0;
    const results: Array<Record<string, unknown>> = [];

    for (const st of rows ?? []) {
      if (Date.now() - startedAt > DEADLINE_MS) break;
      processed++;

      try {
        let email: any = null;
        let account: any = null;
        let links = {
          credit_card_id: st.credit_card_id ?? null,
          financial_account_id: st.financial_account_id ?? null,
          loan_id: st.loan_id ?? null,
          linked_bank_id: st.linked_bank_id ?? null,
        };

        if (st.source_email_id) {
          const { data: em } = await svc.from("emails").select("*").eq("id", st.source_email_id).eq("user_id", uid).maybeSingle();
          email = em;
          if (email) {
            const parsedEmail = parseFinanceEmail({ ...email, body_text: email.body_text ?? email.snippet });
            if (parsedEmail?.kind === "statement") {
              const refreshed = await resolveLinks(svc, uid, parsedEmail, email);
              links = {
                credit_card_id: refreshed.credit_card_id ?? links.credit_card_id,
                financial_account_id: refreshed.financial_account_id ?? links.financial_account_id,
                loan_id: refreshed.loan_id ?? links.loan_id,
                linked_bank_id: refreshed.linked_bank_id ?? links.linked_bank_id,
              };
              await svc.from("statements").update({
                statement_type: parsedEmail.statement_type,
                credit_card_id: links.credit_card_id,
                financial_account_id: links.financial_account_id,
                loan_id: links.loan_id,
                linked_bank_id: links.linked_bank_id,
              }).eq("id", st.id);
            }
            const { data: acct } = await svc.from("email_accounts").select("*").eq("id", email.account_id).maybeSingle();
            account = acct;
          }
        }

        // "parsed-but-incomplete" cards need a real re-learn, not another
        // regex pass. Force LLM path. Bump both learn_attempts (audit) and
        // last_learn_at (throttle).
        const forceRelearn = st.parse_status === "parsed";
        if (forceRelearn) {
          await svc.from("statements")
            .update({
              learn_attempts: (st.learn_attempts ?? 0) + 1,
              last_learn_at: new Date().toISOString(),
            })
            .eq("id", st.id);
        }

        const storedHandled = await parseStoredStatementPdf(svc, st.id, uid, links, {
          statementFilePath: st.file_path ?? null,
          statement_type: (st.statement_type as any) ?? null,
          bank_slug: guessBankSlugFromSender(email?.from_email),
          subject: email?.subject ?? null,
          sender: email?.from_email ?? null,
          force_relearn: forceRelearn,
        });

        if (!storedHandled && email && account) {
          await ingestStatementAttachment(svc, account, email, st.id, links, {
            statement_type: (st.statement_type as any) ?? null,
            bank_slug: guessBankSlugFromSender(email.from_email),
            force_relearn: forceRelearn,
          });
        } else if (!storedHandled) {
          await svc.from("statements").update({
            parse_status: "failed",
            parse_error: "no_pdf_available",
            parse_reason: "No stored PDF or source email is available for this statement.",
          }).eq("id", st.id);
        }

        const { data: updated } = await svc.from("statements")
          .select("parse_status, parse_error, transactions_found")
          .eq("id", st.id).maybeSingle();
        if (updated?.parse_status === "parsed") parsed++;
        else stillUnresolved++;
        results.push({ id: st.id, parse_status: updated?.parse_status ?? null, parse_error: updated?.parse_error ?? null, transactions_found: updated?.transactions_found ?? 0 });
      } catch (e) {
        failed++;
        stillUnresolved++;
        const msg = e instanceof Error ? e.message : String(e);
        await svc.from("statements").update({ parse_status: "failed", parse_error: "reparse_crashed", parse_reason: msg }).eq("id", st.id);
        results.push({ id: st.id, parse_status: "failed", parse_error: "reparse_crashed" });
      }
    }

    // Count unresolved rows still remaining beyond this batch so the caller
    // knows whether to invoke again.
    const { count: unresolvedRemaining } = await svc.from("statements")
      .select("id", { count: "exact", head: true })
      .eq("user_id", uid)
      .in("parse_status", ["pending", "failed", "skipped"])
      .gte("created_at", cutoff);

    let incompleteRemaining = 0;
    if (includeIncompleteParsed) {
      const { count } = await svc.from("statements")
        .select("id", { count: "exact", head: true })
        .eq("user_id", uid)
        .eq("parse_status", "parsed")
        .eq("statement_type", "card")
        .gte("created_at", cutoff)
        .or("statement_date.is.null,due_date.is.null,total_due.is.null,transactions_found.eq.0");
      incompleteRemaining = count ?? 0;
    }

    return new Response(JSON.stringify({
      ok: true,
      scanned: processed,
      parsed,
      failed,
      still_unresolved: stillUnresolved,
      remaining_after: (unresolvedRemaining ?? 0) + incompleteRemaining,
      results,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return sanitizedErrorResponse(err, "Statement reparse failed", "finance-reparse-statements", cors);
  }
});