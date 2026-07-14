// Manually re-run statement-PDF ingestion for one statement — for cases the
// automatic pipeline couldn't resolve on its own: no last-4 in the email
// (so no card/account link, so no password to decrypt with), or a prior
// attempt that failed (e.g. before a password was saved). Optionally
// re-links the statement to a specific card/account first.

import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { svcClient } from "../_shared/gmail.ts";
import { applyParsedStatementResult, ingestStatementAttachment, purgeStatementDerivedData } from "../_shared/finance-extract-core.ts";
import { parseStatementPdf } from "../_shared/statement-pdf.ts";
import { decryptStatementPassword } from "../_shared/crypto.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";
import { z } from "npm:zod";

const limiter = createSlidingWindowLimiter(10, 60_000);
const Body = z.object({
  statement_id: z.string().uuid(),
  credit_card_id: z.string().uuid().nullable().optional(),
  financial_account_id: z.string().uuid().nullable().optional(),
  password: z.string().max(256).optional(),
});

const STATEMENT_BUCKET = "statement-pdfs";

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
  if (!rl.ok) return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }), {
    status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
  });

  try {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return new Response(JSON.stringify({ error: "invalid_input", details: parsed.error.flatten() }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const { statement_id, credit_card_id, financial_account_id, password } = parsed.data;

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

    // Purge all derived data (previous txns, attachment row, parsed fields)
    // so the retry is deterministic — same as the first ingest. Preserves
    // the source_email_id-derived statement_date for Gmail statements.
    const keepDate = !!statement.source_email_id;
    await purgeStatementDerivedData(svc, statement_id, { keepStatementDate: keepDate });

    // Two retry paths:
    //  1. Gmail-sourced statement → re-fetch attachment via Gmail API.
    //  2. Manually-uploaded statement → download from storage and re-parse
    //     with a (possibly newly-supplied) password.
    if (statement.source_email_id) {
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
    } else if (statement.file_path) {
      const { data: blob, error: dlErr } = await svc.storage.from(STATEMENT_BUCKET).download(statement.file_path);
      if (dlErr || !blob) throw dlErr ?? new Error("PDF not found in storage");
      const bytes = new Uint8Array(await blob.arrayBuffer());

      // Password resolution order: explicit override > saved rule on linked entity.
      let pwd: string | undefined = password || undefined;
      let pwdSource: "user" | "saved" | "none" = password ? "user" : "none";
      if (!pwd) {
        if (statement.credit_card_id) {
          const { data: c } = await svc.from("credit_cards").select("statement_password_rule").eq("id", statement.credit_card_id).maybeSingle();
          if (c?.statement_password_rule) {
            try { pwd = await decryptStatementPassword(c.statement_password_rule); pwdSource = "saved"; } catch { /* ignore */ }
          }
        } else if (statement.financial_account_id) {
          const { data: a } = await svc.from("financial_accounts").select("statement_password_rule").eq("id", statement.financial_account_id).maybeSingle();
          if (a?.statement_password_rule) {
            try { pwd = await decryptStatementPassword(a.statement_password_rule); pwdSource = "saved"; } catch { /* ignore */ }
          }
        }
      }

      const result = await parseStatementPdf(bytes, pwd);
      await applyParsedStatementResult(svc, statement.id, uid, {
        credit_card_id: statement.credit_card_id ?? null,
        financial_account_id: statement.financial_account_id ?? null,
        loan_id: statement.loan_id ?? null,
      }, result, statement.file_path, undefined, { passwordSource: pwdSource });
    } else {
      return new Response(JSON.stringify({ error: "statement has no source email or stored PDF to re-parse" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const { data: updated } = await svc.from("statements")
      .select("parse_status, parse_error").eq("id", statement_id).maybeSingle();

    return new Response(JSON.stringify({
      ok: true,
      parse_status: updated?.parse_status ?? null,
      parse_error: updated?.parse_error ?? null,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return sanitizedErrorResponse(err, "Statement retry failed", "finance-retry-statement", cors);
  }
});
