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
import { parseStatementPdf, detectBank } from "./statement-pdf.ts";
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

// Marks a statement failed with an explicit error+reason. Used by every
// early-return path in ingestStatementAttachment so the UI can always show
// a specific reason instead of a mysterious "pending" chip.
async function markStatementFailed(
  svc: SupabaseClient,
  statementId: string,
  error: string,
  reason: string,
): Promise<void> {
  try {
    await svc.from("statements").update({
      parse_status: "failed",
      parse_error: error,
      parse_reason: reason,
    }).eq("id", statementId);
  } catch (e) {
    console.warn("markStatementFailed write failed", e instanceof Error ? e.message : e);
  }
}

async function markStatementSkipped(
  svc: SupabaseClient,
  statementId: string,
  reason: string,
): Promise<void> {
  try {
    await svc.from("statements").update({
      parse_status: "skipped",
      parse_error: null,
      parse_reason: reason,
    }).eq("id", statementId);
  } catch (e) {
    console.warn("markStatementSkipped write failed", e instanceof Error ? e.message : e);
  }
}

// Purges all derived data for a statement so a retry is deterministic:
// same as running the ingest for the first time. Preserves the row identity,
// its links, its source_email_id, and (for Gmail statements) its subject-
// derived statement_date.
export async function purgeStatementDerivedData(
  svc: SupabaseClient,
  statementId: string,
  opts: { keepStatementDate?: boolean } = {},
): Promise<void> {
  await svc.from("transactions").delete().eq("source_statement_id", statementId);
  await svc.from("email_attachments").delete().eq("statement_id", statementId).eq("attachment_type", "statement");
  const patch: Record<string, unknown> = {
    file_path: null,
    transactions_found: 0,
    closing_balance: null,
    total_due: null,
    min_due: null,
    due_date: null,
    period_start: null,
    period_end: null,
    parser_source: null,
    parse_confidence: null,
    parser_confidence: null,
    parse_error: null,
    parse_reason: null,
    parse_status: "pending",
    ai_summary: null,
  };
  if (!opts.keepStatementDate) patch.statement_date = null;
  await svc.from("statements").update(patch).eq("id", statementId);
}

// Downloads the statement's first PDF attachment (if any), stores it in the
// private statement-pdfs bucket, parses it (decrypting with the linked
// card/account's stored password when available), and writes the results
// back onto the statements row + itemized transactions. Never throws — every
// failure persists a specific parse_error + parse_reason so the UI can show
// exactly why a row is stuck.
export async function ingestStatementAttachment(
  svc: SupabaseClient,
  account: any,
  email: any,
  statementId: string,
  links: { financial_account_id?: string | null; credit_card_id?: string | null; loan_id?: string | null },
): Promise<void> {
  try {
    const payload = await fetchMessagePayload(svc, account, email);
    if (!payload) {
      await markStatementFailed(svc, statementId, "gmail_payload_empty", "Gmail message payload could not be fetched — check email account connectivity.");
      return;
    }

    const pdfAttachment = listAttachments(payload).find((a) => a.mimeType === "application/pdf");
    if (!pdfAttachment) {
      // Statement email with no PDF attached (typical "login to view" alert).
      // Not a hard failure — user can manually attach a PDF via the UI.
      await markStatementSkipped(svc, statementId, "no_pdf_attachment_login_required");
      return;
    }

    let bytes: Uint8Array;
    try {
      const token = await ensureAccessToken(svc, account);
      bytes = await downloadAttachment(token, email.external_email_id, pdfAttachment.attachmentId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("downloadAttachment failed", msg);
      await markStatementFailed(svc, statementId, "attachment_download_failed", msg.slice(0, 240));
      return;
    }

    const storagePath = `${email.user_id}/${email.id}/${pdfAttachment.attachmentId}-${safeName(pdfAttachment.filename)}`;
    const { error: upErr } = await svc.storage.from(STATEMENT_BUCKET).upload(storagePath, bytes, {
      contentType: "application/pdf",
      upsert: true,
    });
    if (upErr) {
      console.warn("statement PDF upload failed", upErr.message);
      await markStatementFailed(svc, statementId, "pdf_upload_failed", upErr.message.slice(0, 240));
      return;
    }

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

    let attRow: { id: string } | null = null;
    if (existingAtt) {
      const { data, error } = await svc.from("email_attachments").update(attFields).eq("id", existingAtt.id).select("id").single();
      if (error) {
        console.warn("email_attachments update failed", error.message);
        await markStatementFailed(svc, statementId, "attachment_row_write_failed", error.message.slice(0, 240));
        return;
      }
      attRow = data;
    } else {
      const { data, error } = await svc.from("email_attachments").insert({
        user_id: email.user_id, email_id: email.id, statement_id: statementId, ...attFields,
      }).select("id").single();
      if (error) {
        console.warn("email_attachments insert failed", error.message);
        await markStatementFailed(svc, statementId, "attachment_row_write_failed", error.message.slice(0, 240));
        return;
      }
      attRow = data;
    }
    if (!attRow) {
      await markStatementFailed(svc, statementId, "attachment_row_missing", "email_attachments row was not returned after upsert.");
      return;
    }

    const password = await resolveStatementPassword(svc, email.user_id, links);
    const passwordSource: "saved" | "none" = password ? "saved" : "none";
    const result = await parseStatementPdf(bytes, password);
    await applyParsedStatementResult(svc, statementId, email.user_id, links, result, storagePath, attRow.id, { passwordSource });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("ingestStatementAttachment crashed", msg);
    await markStatementFailed(svc, statementId, "ingest_crashed", msg.slice(0, 240));
  }
}

// Human-friendly reason for each parser error code.
function reasonForError(err: string | undefined): string {
  if (!err) return "unknown_parse_error";
  if (err === "password_required") return "PDF is password-protected — provide the password and retry.";
  if (err === "wrong_password") return "The stored password did not unlock the PDF. Update it and retry.";
  if (err === "file_too_large") return "PDF exceeds the 20 MB parser limit.";
  if (err === "too_many_pages") return "PDF has more than 100 pages — parser limit reached.";
  if (err === "stored_password_unreadable") return "Stored statement password could not be decrypted. Re-enter it and retry.";
  return err.slice(0, 240);
}

function enrich(description: string, txnType: "debit" | "credit"): {
  merchant: string;
  category: string | null;
  payment_mode: string | null;
} {
  const raw = description.trim();
  let merchant = raw
    .replace(/\s+(?:POS|ATM|NEFT|IMPS|RTGS|UPI|ECOM)\b.*$/i, "")
    .replace(/\s+X{2,}\d{2,}\b.*$/i, "")
    .replace(/\s+\*{2,}\d{2,}\b.*$/i, "")
    .replace(/\s+\d{6,}$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!merchant) merchant = raw;

  const hay = raw.toLowerCase();
  const CATEGORIES: Array<[RegExp, string]> = [
    [/\b(swiggy|zomato|dominos|kfc|mcdonald|starbucks|cafe|restaurant|food)\b/, "Food & Dining"],
    [/\b(uber|ola|rapido|indigo|vistara|air ?india|irctc|redbus|makemytrip|goibibo)\b/, "Travel"],
    [/\b(amazon|flipkart|myntra|ajio|meesho|nykaa)\b/, "Shopping"],
    [/\b(bigbasket|blinkit|zepto|dmart|grocery|instamart)\b/, "Groceries"],
    [/\b(netflix|spotify|prime|hotstar|youtube|apple\.com\/bill)\b/, "Subscriptions"],
    [/\b(bses|adani|tata power|electric|water|gas|jio|airtel|vi |vodafone|bsnl|broadband)\b/, "Utilities"],
    [/\b(apollo|medplus|pharm|clinic|hospital|diagnostic|1mg|pharmeasy)\b/, "Health"],
    [/\b(rent|maintenance|society|housing)\b/, "Housing"],
    [/\b(emi|loan|installment)\b/, "EMI & Loans"],
    [/\b(sip|mutual fund|nps|invest|zerodha|groww|upstox)\b/, "Investments"],
    [/\b(salary|payroll|credit interest|refund|reversal|cashback)\b/, txnType === "credit" ? "Income" : "Refunds"],
    [/\b(atm|cash withdrawal)\b/, "Cash"],
  ];
  const category = CATEGORIES.find(([rx]) => rx.test(hay))?.[1] ?? null;

  let payment_mode: string | null = null;
  if (/\bupi\b|@[a-z]/i.test(raw)) payment_mode = "UPI";
  else if (/\b(neft|imps|rtgs)\b/i.test(raw)) payment_mode = "Bank Transfer";
  else if (/\bpos\b|\bcard\b|\becom\b|\b(visa|mastercard|rupay)\b/i.test(raw)) payment_mode = "Card";
  else if (/\batm\b|\bcash\b/i.test(raw)) payment_mode = "Cash";
  else if (/\bauto[- ]?debit\b|\bsi\b|\bstanding instruction\b/i.test(raw)) payment_mode = "Auto-debit";

  return { merchant, category, payment_mode };
}

export async function applyParsedStatementResult(
  svc: SupabaseClient,
  statementId: string,
  userId: string,
  links: { financial_account_id?: string | null; credit_card_id?: string | null; loan_id?: string | null },
  result: import("./statement-pdf.ts").PdfParseResult,
  storagePath: string | null,
  attachmentId?: string,
  meta: { passwordSource?: "saved" | "user" | "none" } = {},
): Promise<void> {
  if (!result.ok) {
    await svc.from("statements").update({
      parse_status: "failed",
      parse_error: result.error ?? "unknown_parse_error",
      parse_reason: reasonForError(result.error),
      file_path: storagePath,
    }).eq("id", statementId);
    if (attachmentId) await svc.from("email_attachments").update({ parse_status: "failed" }).eq("id", attachmentId);
    return;
  }

  const bank = result.bank ?? null;
  const confidence = result.confidence ?? (bank ? 0.85 : 0.5);
  const parseReason = meta.passwordSource === "user"
    ? "parsed_with_user_password"
    : meta.passwordSource === "saved"
      ? "parsed_with_saved_password"
      : "parsed_no_password";

  await svc.from("statements").update({
    period_start: result.period_start,
    period_end: result.period_end,
    statement_date: result.statement_date,
    due_date: result.due_date,
    total_due: result.total_due,
    min_due: result.min_due ?? null,
    closing_balance: result.closing_balance,
    parse_status: "parsed",
    parse_error: null,
    parse_reason: parseReason,
    parser_source: bank,
    parser_confidence: confidence,
    transactions_found: result.lines.length,
    file_path: storagePath,
  }).eq("id", statementId);
  if (attachmentId) await svc.from("email_attachments").update({ parse_status: "parsed" }).eq("id", attachmentId);

  const idCol = links.credit_card_id ? "credit_card_id" : links.financial_account_id ? "financial_account_id" : null;
  const idVal = links.credit_card_id ?? links.financial_account_id ?? null;

  for (const line of result.lines) {
    let existingId: string | null = null;
    if (idCol && idVal) {
      const { data: existing } = await svc.from("transactions")
        .select("id, source")
        .eq("user_id", userId)
        .eq(idCol, idVal)
        .eq("txn_date", line.date)
        .eq("amount", line.amount)
        .limit(1)
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
      const en = enrich(line.description, line.txn_type);
      const { error: te } = await svc.from("transactions").insert({
        user_id: userId,
        txn_date: line.date,
        amount: line.amount,
        txn_type: line.txn_type,
        merchant: en.merchant,
        category: en.category,
        payment_mode: en.payment_mode,
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

// Re-export for callers that want to detect the bank from PDF text.
export { detectBank };

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
    const looksFinance = em.finance_related || isFinanceMail(em) || isFinanceSender(em.from_email);
    if (!looksFinance) { skipped++; continue; }
    if (!em.finance_related) {
      await svc.from("emails").update({ finance_related: true, category: "finance" }).eq("id", em.id);
    }

    const { data: exTx } = await svc.from("transactions").select("id").eq("user_id", em.user_id).eq("source_email_id", em.id).maybeSingle();
    const { data: exSt } = await svc.from("statements")
      .select("id, parse_status, parse_reason, credit_card_id, financial_account_id, loan_id")
      .eq("user_id", em.user_id).eq("source_email_id", em.id).maybeSingle();
    if (exTx) { skipped++; continue; }
    if (exSt) {
      // Retry on pending / failed, and on 'skipped' rows that have no
      // explicit reason yet (backfill) — otherwise skipped rows that were
      // resolved as "no PDF attachment" stay put.
      const shouldRetry =
        exSt.parse_status === "pending" ||
        exSt.parse_status === "failed" ||
        (exSt.parse_status === "skipped" && !exSt.parse_reason);
      if (shouldRetry) {
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

    if (links.linked_bank_id || links.linked_card_id) {
      await svc.from("emails").update({
        linked_bank_id: links.linked_bank_id ?? null,
        linked_card_id: links.linked_card_id ?? null,
      }).eq("id", em.id);
    }
  }

  return { scanned: candidates?.length ?? 0, transactions, statements, skipped };
}
