// Manually re-run statement-PDF ingestion for one statement — for cases the
// automatic pipeline couldn't resolve on its own: no last-4 in the email
// (so no card/account link, so no password to decrypt with), or a prior
// attempt that failed (e.g. before a password was saved). Optionally
// re-links the statement to a specific card/account first.

import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { svcClient } from "../_shared/gmail.ts";
import { ingestStatementAttachment } from "../_shared/finance-extract-core.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";

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

  try {
    const { statement_id, credit_card_id, financial_account_id } = await req.json();
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

    if (!statement.source_email_id) {
      return new Response(JSON.stringify({ error: "statement has no source email to re-fetch" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const { data: email, error: emErr } = await svc.from("emails").select("*").eq("id", statement.source_email_id).eq("user_id", uid).maybeSingle();
    if (emErr) throw emErr;
    if (!email) {
      return new Response(JSON.stringify({ error: "source email not found" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const { data: account, error: acErr } = await svc.from("email_accounts").select("*").eq("id", email.account_id).maybeSingle();
    if (acErr) throw acErr;
    if (!account) {
      return new Response(JSON.stringify({ error: "email account not found" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    await ingestStatementAttachment(svc, account, email, statement.id, {
      credit_card_id: statement.credit_card_id ?? null,
      financial_account_id: statement.financial_account_id ?? null,
      loan_id: statement.loan_id ?? null,
    });

    const { data: updated } = await svc.from("statements").select("parse_status").eq("id", statement_id).maybeSingle();

    return new Response(JSON.stringify({ ok: true, parse_status: updated?.parse_status ?? null }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return sanitizedErrorResponse(err, "Statement retry failed", "finance-retry-statement", cors);
  }
});
