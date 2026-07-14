// Manually re-run statement-PDF ingestion for one statement — for cases the
// automatic pipeline couldn't resolve on its own: no last-4 in the email
// (so no card/account link, so no password to decrypt with), or a prior
// attempt that failed (e.g. before a password was saved). Optionally
// re-links the statement to a specific card/account first.

import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { svcClient } from "../_shared/gmail.ts";
import { ingestStatementAttachment, parseStoredStatementPdf, purgeStatementDerived, resolveLinks } from "../_shared/finance-extract-core.ts";
import { guessBankSlugFromSender, parseFinanceEmail } from "../_shared/finance-parsers.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";

const retryLimiter = createSlidingWindowLimiter(20, 60_000);

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

  const rl = retryLimiter.check(uid);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }), {
      status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
    });
  }

  try {
    const { statement_id, credit_card_id, financial_account_id, password } = await req.json();
    if (!statement_id) {
      return new Response(JSON.stringify({ error: "statement_id required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const svc = svcClient();

    const { data: statement, error: stErr } = await svc.from("statements")
      .select("*").eq("id", statement_id).eq("user_id", uid).maybeSingle();
    if (stErr) throw stErr;
    if (!statement) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Optional re-link — verify ownership of whatever's being linked before
    // writing it onto the statement.
    if (credit_card_id !== undefined || financial_account_id !== undefined) {
      if (credit_card_id) {
        const { data: card } = await svc.from("credit_cards").select("id").eq("id", credit_card_id).eq("user_id", uid).maybeSingle();
        if (!card) return new Response(JSON.stringify({ error: "card not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
      }
      if (financial_account_id) {
        const { data: acct } = await svc.from("financial_accounts").select("id").eq("id", financial_account_id).eq("user_id", uid).maybeSingle();
        if (!acct) return new Response(JSON.stringify({ error: "account not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
      }
      const { error: updErr } = await svc.from("statements").update({
        credit_card_id: credit_card_id ?? null,
        financial_account_id: financial_account_id ?? null,
      }).eq("id", statement_id);
      if (updErr) throw updErr;
      statement.credit_card_id = credit_card_id ?? null;
      statement.financial_account_id = financial_account_id ?? null;
    }

    let email: any = null;
    let account: any = null;
    let links = {
      credit_card_id: statement.credit_card_id ?? null,
      financial_account_id: statement.financial_account_id ?? null,
      loan_id: statement.loan_id ?? null,
      linked_bank_id: statement.linked_bank_id ?? null,
    };

    if (statement.source_email_id) {
      const { data: emailRow, error: emErr } = await svc.from("emails").select("*").eq("id", statement.source_email_id).eq("user_id", uid).maybeSingle();
      if (emErr) throw emErr;
      if (!emailRow) {
        return new Response(JSON.stringify({ error: "source email not found" }), {
          status: 404, headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      email = emailRow;
      const { data: accountRow, error: acErr } = await svc.from("email_accounts").select("*").eq("id", email.account_id).maybeSingle();
      if (acErr) throw acErr;
      if (!accountRow) {
        return new Response(JSON.stringify({ error: "email account not found" }), {
          status: 404, headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      account = accountRow;
      const parsed = parseFinanceEmail({ ...email, body_text: email.body_text ?? email.snippet });
      links = parsed?.kind === "statement"
        ? await resolveLinks(svc, uid, parsed, email)
        : {
          credit_card_id: statement.credit_card_id ?? null,
          financial_account_id: statement.financial_account_id ?? null,
          loan_id: statement.loan_id ?? null,
          linked_bank_id: statement.linked_bank_id ?? null,
        };
      await svc.from("statements").update({
        credit_card_id: links.credit_card_id ?? statement.credit_card_id ?? null,
        financial_account_id: links.financial_account_id ?? statement.financial_account_id ?? null,
        loan_id: links.loan_id ?? statement.loan_id ?? null,
        linked_bank_id: links.linked_bank_id ?? statement.linked_bank_id ?? null,
      }).eq("id", statement.id);

      const handledStored = await parseStoredStatementPdf(svc, statement.id, uid, links, {
        statementFilePath: statement.file_path ?? null,
        password: password ?? null,
        statement_type: (statement.statement_type as any) ?? null,
        bank_slug: guessBankSlugFromSender(email.from_email),
        subject: email.subject ?? null,
        sender: email.from_email ?? null,
      });
      if (!handledStored) {
        // Retry === fresh ingest: wipe derived fields/txns first so a prior
        // wrong-card link or half-parsed run doesn't leak into the new result.
        await purgeStatementDerived(svc, statement.id);
        await ingestStatementAttachment(svc, account, email, statement.id, links, {
          statement_type: (statement.statement_type as any) ?? null,
          bank_slug: guessBankSlugFromSender(email.from_email),
        });
      }
    } else {
      const handledStored = await parseStoredStatementPdf(svc, statement.id, uid, links, {
        statementFilePath: statement.file_path ?? null,
        password: password ?? null,
        statement_type: (statement.statement_type as any) ?? null,
      });
      if (!handledStored) {
        return new Response(JSON.stringify({ error: "statement has no source email or stored PDF to re-parse" }), {
          status: 400, headers: { ...cors, "Content-Type": "application/json" },
        });
      }
    }

    const { data: updated } = await svc.from("statements")
      .select("parse_status, parse_error, parse_reason").eq("id", statement_id).maybeSingle();

    return new Response(JSON.stringify({
      ok: true,
      parse_status: updated?.parse_status ?? null,
      parse_error: updated?.parse_error ?? null,
      parse_reason: updated?.parse_reason ?? null,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return sanitizedErrorResponse(err, "Statement retry failed", "finance-retry-statement", cors);
  }
});
