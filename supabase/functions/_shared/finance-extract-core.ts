// Turn stored finance emails into structured records: transactions,
// statements, EMIs, investments — auto-linked to a card / account / loan when
// possible. Idempotent: safe to re-run on the same email set.
//
// Statement emails additionally get their PDF attachment (if any) downloaded,
// stored in the private statement-pdfs bucket, decrypted with the linked
// card/account's stored password, and parsed for real period/due/balance and
// itemized transaction data — see statement-pdf.ts.

import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ensureAccessToken, extractBody, gapi, listAttachments, downloadAttachment } from "./gmail.ts";
import { isFinanceMail, isFinanceSender, parseFinanceEmail, type Parsed } from "./finance-parsers.ts";
import { parseStatementPdf } from "./statement-pdf.ts";
import { decryptStatementPassword, type StatementPasswordRule } from "./crypto.ts";

const STATEMENT_BUCKET = "statement-pdfs";

export interface ExtractSummary {
  scanned: number;
  transactions: number;
  statements: number;
  skipped: number;
}

async function fetchBody(svc: SupabaseClient, account: any, email: any): Promise<string | null> {
  if (email.body_text) return email.body_text;
  if (email.provider !== "gmail" || !email.external_email_id) return email.snippet ?? null;
  try {
    const token = await ensureAccessToken(svc, account);
    const msg = await gapi(token, `/gmail/v1/users/me/messages/${email.external_email_id}?format=full`);
    const { text, html } = extractBody(msg.payload);
    const body = text ?? (html ? html.replace(/<[^>]+>/g, " ") : null);
    if (body) {
      await svc.from("emails").update({ body_text: text ?? body, body_html: html }).eq("id", email.id);
    }
    return body;
  } catch (e) {
    console.warn("fetchBody failed", e instanceof Error ? e.message : e);
    return email.snippet ?? null;
  }
}

// Fresh format=full fetch to get the message payload (needed for attachment
// listing — the cached body_text path in fetchBody() never retains this).
// Only called for emails already classified as a statement, so the extra
// Gmail API round trip is rare, not per-email.
async function fetchMessagePayload(svc: SupabaseClient, account: any, email: any): Promise<any | null> {
  if (email.provider !== "gmail" || !email.external_email_id) return null;
  try {
    const token = await ensureAccessToken(svc, account);
    const msg = await gapi(token, `/gmail/v1/users/me/messages/${email.external_email_id}?format=full`);
    return msg.payload ?? null;
  } catch (e) {
    console.warn("fetchMessagePayload failed", e instanceof Error ? e.message : e);
    return null;
  }
}

async function resolveLinks(svc: SupabaseClient, userId: string, parsed: Parsed) {
  const links: { financial_account_id?: string | null; credit_card_id?: string | null; loan_id?: string | null; linked_bank_id?: string | null; linked_card_id?: string | null } = {};
  if (!parsed.last4) return links;
  const suffix = `%${parsed.last4}`;
  if (parsed.kind === "transaction" || parsed.kind === "investment") {
    const { data: card } = await svc.from("credit_cards").select("id, bank_id").eq("user_id", userId).ilike("masked_number", suffix).maybeSingle();
    if (card) { links.credit_card_id = card.id; links.linked_card_id = card.id; links.linked_bank_id = card.bank_id ?? null; return links; }
    const { data: acct } = await svc.from("financial_accounts").select("id, bank_id").eq("user_id", userId).ilike("masked_number", suffix).maybeSingle();
    if (acct) { links.financial_account_id = acct.id; links.linked_bank_id = acct.bank_id ?? null; return links; }
  }
  if (parsed.kind === "emi") {
    const { data: loan } = await svc.from("loans").select("id").eq("user_id", userId).ilike("account_number", suffix).maybeSingle();
    if (loan) { links.loan_id = loan.id; return links; }
  }
  return links;
}

// For a statement, links.credit_card_id / links.financial_account_id may be
// unresolved (statement emails don't always carry a last4 the way alert
// emails do) — so this also falls back to matching the statement's own
// statement_type against the account/card that most recently expects a
// statement in this period. Keep it simple for now: only decrypt when a
// link was already resolved via last4; unresolved links mean parsing runs
// without a password (works fine for non-protected PDFs, fails clearly with
// wrong_or_missing_password otherwise, which is surfaced as parse_status).
async function resolveStatementPassword(
  svc: SupabaseClient,
  userId: string,
  links: { financial_account_id?: string | null; credit_card_id?: string | null },
): Promise<string | undefined> {
  const table = links.credit_card_id ? "credit_cards" : links.financial_account_id ? "financial_accounts" : null;
  const id = links.credit_card_id ?? links.financial_account_id ?? null;
  if (!table || !id) return undefined;
  const { data } = await svc.from(table).select("statement_password_rule").eq("user_id", userId).eq("id", id).maybeSingle();
  const rule = data?.statement_password_rule as StatementPasswordRule | null | undefined;
  if (!rule) return undefined;
  try {
    return await decryptStatementPassword(rule);
  } catch (e) {
    console.warn("decryptStatementPassword failed", e instanceof Error ? e.message : e);
    return undefined;
  }
}

function safeName(filename: string): string {
  return filename.replace(/[^\w.\-]/g, "_").slice(0, 80);
}

// Downloads the statement's first PDF attachment (if any), stores it in the
// private statement-pdfs bucket, parses it (decrypting with the linked
// card/account's stored password when available), and writes the results
// back onto the statements row + itemized transactions. Never throws — a
// parse failure just leaves parse_status='failed' and the sync run
// continues with the next email.
export async function ingestStatementAttachment(
  svc: SupabaseClient,
  account: any,
  email: any,
  statementId: string,
  links: { financial_account_id?: string | null; credit_card_id?: string | null; loan_id?: string | null },
): Promise<void> {
  const payload = await fetchMessagePayload(svc, account, email);
  if (!payload) return; // transient fetch failure — leave 'pending', retried next sync

  const pdfAttachment = listAttachments(payload).find((a) => a.mimeType === "application/pdf");
  if (!pdfAttachment) {
    // Confirmed fact: this statement email has no PDF attached (e.g. a
    // "login to view" notification, common for many banks). Not an error —
    // mark 'skipped' so the UI shows a resolved state instead of a
    // perpetually stuck "pending", and so this statement isn't retried
    // forever by the caller's pending/failed retry check.
    await svc.from("statements").update({ parse_status: "skipped" }).eq("id", statementId);
    return;
  }

  let bytes: Uint8Array;
  try {
    const token = await ensureAccessToken(svc, account);
    bytes = await downloadAttachment(token, email.external_email_id, pdfAttachment.attachmentId);
  } catch (e) {
    console.warn("downloadAttachment failed", e instanceof Error ? e.message : e);
    return;
  }

  const storagePath = `${email.user_id}/${email.id}/${pdfAttachment.attachmentId}-${safeName(pdfAttachment.filename)}`;
  const { error: upErr } = await svc.storage.from(STATEMENT_BUCKET).upload(storagePath, bytes, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (upErr) {
    console.warn("statement PDF upload failed", upErr.message);
    return;
  }

  // Retries (a statement stuck at pending/failed getting reprocessed, or a
  // manual retry after the user adds a password) must not pile up duplicate
  // email_attachments rows for the same email+statement — reuse the
  // existing row if one is already there.
  const attFields = {
    file_name: pdfAttachment.filename,
    mime: pdfAttachment.mimeType,
    storage_path: storagePath,
    byte_size: bytes.length,
    attachment_type: "statement",
    parse_status: "pending",
  };
  const { data: existingAtt } = await svc.from("email_attachments")
    .select("id").eq("email_id", email.id).eq("statement_id", statementId).limit(1).maybeSingle();

  let attRow: { id: string } | null;
  if (existingAtt) {
    const { data, error } = await svc.from("email_attachments").update(attFields).eq("id", existingAtt.id).select("id").single();
    if (error) { console.warn("email_attachments update failed", error.message); return; }
    attRow = data;
  } else {
    const { data, error } = await svc.from("email_attachments").insert({
      user_id: email.user_id, email_id: email.id, statement_id: statementId, ...attFields,
    }).select("id").single();
    if (error) { console.warn("email_attachments insert failed", error.message); return; }
    attRow = data;
  }
  if (!attRow) return;

  const password = await resolveStatementPassword(svc, email.user_id, links);
  const result = await parseStatementPdf(bytes, password);
  await applyParsedStatementResult(svc, statementId, email.user_id, links, result, storagePath, attRow.id);
}

// Shared tail of statement ingestion, reused by both the Gmail-attachment
// path above and the manual-upload edge function (finance-upload-statement)
// — writes the parse result onto the statements/email_attachments rows and
// inserts itemized transactions with the same dedup-against-email-alerts
// logic. attachmentId is optional since a manual upload may not create an
// email_attachments row.
export async function applyParsedStatementResult(
  svc: SupabaseClient,
  statementId: string,
  userId: string,
  links: { financial_account_id?: string | null; credit_card_id?: string | null; loan_id?: string | null },
  result: import("./statement-pdf.ts").PdfParseResult,
  storagePath: string | null,
  attachmentId?: string,
): Promise<void> {
  if (!result.ok) {
    await svc.from("statements").update({ parse_status: "failed" }).eq("id", statementId);
    if (attachmentId) await svc.from("email_attachments").update({ parse_status: "failed" }).eq("id", attachmentId);
    return;
  }

  await svc.from("statements").update({
    period_start: result.period_start,
    period_end: result.period_end,
    statement_date: result.statement_date,
    due_date: result.due_date,
    total_due: result.total_due,
    closing_balance: result.closing_balance,
    parse_status: "parsed",
    transactions_found: result.lines.length,
    file_path: storagePath,
  }).eq("id", statementId);
  if (attachmentId) await svc.from("email_attachments").update({ parse_status: "parsed" }).eq("id", attachmentId);

  const idCol = links.credit_card_id ? "credit_card_id" : links.financial_account_id ? "financial_account_id" : null;
  const idVal = links.credit_card_id ?? links.financial_account_id ?? null;

  for (const line of result.lines) {
    // Dedup against an already-extracted source='email' transaction for the
    // same real-world charge (account/card + date + amount). If found,
    // upgrade it to source='statement' rather than inserting a duplicate —
    // the statement line is the more authoritative record.
    let existingId: string | null = null;
    if (idCol && idVal) {
      const { data: existing } = await svc.from("transactions")
        .select("id, source")
        .eq("user_id", userId)
        .eq(idCol, idVal)
        .eq("txn_date", line.date)
        .eq("amount", line.amount)
        .maybeSingle();
      if (existing) existingId = existing.id;
    }

    if (existingId) {
      await svc.from("transactions").update({
        source: "statement",
        source_statement_id: statementId,
        confidence_score: 0.85,
      }).eq("id", existingId);
    } else {
      const { error: te } = await svc.from("transactions").insert({
        user_id: userId,
        txn_date: line.date,
        amount: line.amount,
        txn_type: line.txn_type,
        merchant: line.description,
        source: "statement",
        source_statement_id: statementId,
        credit_card_id: links.credit_card_id ?? null,
        financial_account_id: links.financial_account_id ?? null,
        loan_id: links.loan_id ?? null,
        confidence_score: 0.85,
      });
      if (te && !String(te.message).includes("duplicate")) console.warn("statement txn insert", te.message);
    }
  }
}

export async function extractFinanceForAccount(
  svc: SupabaseClient,
  account: any,
  opts: { sinceDays?: number; limit?: number } = {},
): Promise<ExtractSummary> {
  const sinceDays = Math.max(1, Math.min(365, opts.sinceDays ?? 30));
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const cutoff = new Date(Date.now() - sinceDays * 86400_000).toISOString();

  const { data: candidates, error } = await svc
    .from("emails")
    .select("id, user_id, account_id, provider, external_email_id, from_email, from_name, subject, snippet, body_text, received_at, finance_related")
    .eq("account_id", account.id)
    .eq("user_id", account.user_id)
    .gte("received_at", cutoff)
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  let transactions = 0, statements = 0, skipped = 0;

  for (const em of candidates ?? []) {
    // Auto-tag finance_related on first pass so future filters are cheap.
    const looksFinance = em.finance_related || isFinanceMail(em) || isFinanceSender(em.from_email);
    if (!looksFinance) { skipped++; continue; }
    if (!em.finance_related) {
      await svc.from("emails").update({ finance_related: true, category: "finance" }).eq("id", em.id);
    }

    // Skip if already extracted (idempotency via unique index) — except a
    // statement stuck at parse_status='pending'/'failed', which gets
    // retried. Covers rows from before this pipeline existed (always
    // 'pending', never processed) and rows that failed transiently (e.g. no
    // password set at the time of first attempt).
    const { data: exTx } = await svc.from("transactions").select("id").eq("user_id", em.user_id).eq("source_email_id", em.id).maybeSingle();
    const { data: exSt } = await svc.from("statements")
      .select("id, parse_status, credit_card_id, financial_account_id, loan_id")
      .eq("user_id", em.user_id).eq("source_email_id", em.id).maybeSingle();
    if (exTx) { skipped++; continue; }
    if (exSt) {
      if (exSt.parse_status === "pending" || exSt.parse_status === "failed") {
        await ingestStatementAttachment(svc, account, em, exSt.id, {
          credit_card_id: exSt.credit_card_id,
          financial_account_id: exSt.financial_account_id,
          loan_id: exSt.loan_id,
        });
      }
      skipped++;
      continue;
    }

    const body = await fetchBody(svc, account, em);
    const parsed = parseFinanceEmail({ ...em, body_text: body });
    if (!parsed) { skipped++; continue; }

    const links = await resolveLinks(svc, em.user_id, parsed);

    if (parsed.kind === "statement") {
      const { data: newStatement, error: se } = await svc.from("statements").insert({
        user_id: em.user_id,
        statement_type: parsed.statement_type,
        statement_date: parsed.statement_date,
        period_start: parsed.period_start,
        period_end: parsed.period_end,
        source_email_id: em.id,
        credit_card_id: links.credit_card_id ?? null,
        financial_account_id: links.financial_account_id ?? null,
        loan_id: links.loan_id ?? null,
        source: "email",
        confidence: parsed.confidence,
      }).select("id").single();
      if (!se && newStatement) {
        statements++;
        await ingestStatementAttachment(svc, account, em, newStatement.id, links);
      } else if (se && !String(se.message).includes("duplicate")) {
        console.warn("statement insert", se.message);
      }
    } else {
      const { error: te } = await svc.from("transactions").insert({
        user_id: em.user_id,
        txn_date: parsed.txn_date,
        amount: parsed.amount,
        txn_type: parsed.txn_type,
        merchant: parsed.merchant,
        category: parsed.category,
        reference_number: parsed.reference_number,
        source: "email",
        source_email_id: em.id,
        confidence_score: parsed.confidence,
        financial_account_id: links.financial_account_id ?? null,
        credit_card_id: links.credit_card_id ?? null,
        loan_id: links.loan_id ?? null,
      });
      if (!te) transactions++;
      else if (!String(te.message).includes("duplicate")) console.warn("txn insert", te.message);
    }

    // Enrich the source email with bank/card links.
    if (links.linked_bank_id || links.linked_card_id) {
      await svc.from("emails").update({
        linked_bank_id: links.linked_bank_id ?? null,
        linked_card_id: links.linked_card_id ?? null,
      }).eq("id", em.id);
    }
  }

  return { scanned: candidates?.length ?? 0, transactions, statements, skipped };
}
