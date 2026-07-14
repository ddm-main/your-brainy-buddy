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
import { isFinanceMail, isFinanceSender, parseFinanceEmail, guessBankSlugFromSender, unwrapForwarded, type Parsed } from "./finance-parsers.ts";
import { parseStatementPdfWithPasswords } from "./statement-pdf.ts";
import { decryptStatementPassword, encryptStatementPassword, type StatementPasswordRule } from "./crypto.ts";

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
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("fetchMessagePayload failed", msg);
    // Bubble a distinct sentinel up so the caller can persist a diagnostic
    // parse_error instead of silently leaving the row 'pending' forever.
    throw new Error(`gmail_fetch_failed: ${msg}`);
  }
}

function digitsOnly(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

function suffixMatches(savedMasked: string | null | undefined, parsedLast4: string | null | undefined): boolean {
  const saved = digitsOnly(savedMasked);
  const parsed = digitsOnly(parsedLast4);
  if (!saved || !parsed) return false;
  return saved.endsWith(parsed) || parsed.endsWith(saved);
}

function normWords(v: string | null | undefined): string[] {
  return (v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !["your", "card", "credit", "monthly", "statement", "bank", "ltd", "the"].includes(w));
}

function bankMatches(bankName: string | null | undefined, slug: string | null): boolean {
  if (!bankName || !slug) return false;
  const a = bankName.toLowerCase();
  const b = slug.toLowerCase();
  return a.includes(b) || b.includes(a.replace(/\s+bank$/, ""));
}

function subjectTokenScore(subject: string | null | undefined, entityName: string | null | undefined): number {
  const hay = new Set(normWords(subject));
  return normWords(entityName).reduce((score, w) => score + (hay.has(w) ? 1 : 0), 0);
}

async function findBankId(svc: SupabaseClient, userId: string, bankSlug: string | null): Promise<string | null> {
  if (!bankSlug) return null;
  const { data: banks } = await svc.from("banks").select("id, name").eq("user_id", userId);
  const match = (banks ?? []).find((b: any) => bankMatches(b.name, bankSlug));
  return match?.id ?? null;
}

export async function resolveLinks(svc: SupabaseClient, userId: string, parsed: Parsed, email?: any) {
  const links: { financial_account_id?: string | null; credit_card_id?: string | null; loan_id?: string | null; linked_bank_id?: string | null; linked_card_id?: string | null } = {};
  const bankSlug = guessBankSlugFromSender(email?.from_email);
  const linkedBankId = await findBankId(svc, userId, bankSlug);
  if (linkedBankId) links.linked_bank_id = linkedBankId;

  if (parsed.kind === "statement") {
    const subject = email?.subject ?? "";
    if (parsed.statement_type === "card") {
      const { data: cards } = await svc.from("credit_cards")
        .select("id, bank_id, card_name, masked_number, banks(name)")
        .eq("user_id", userId);
      let best: any = null;
      let bestScore = 0;
      for (const card of cards ?? []) {
        let score = 0;
        if (suffixMatches(card.masked_number, parsed.last4)) score += 8;
        if (bankMatches(card.banks?.name, bankSlug)) score += 4;
        score += subjectTokenScore(subject, card.card_name) * 2;
        if (/cashback/i.test(subject) && /cashback/i.test(card.card_name)) score += 5;
        if (/bpcl/i.test(subject) && /bpcl/i.test(card.card_name)) score += 5;
        if (score > bestScore) { bestScore = score; best = card; }
      }
      if (best && bestScore >= 5) {
        links.credit_card_id = best.id;
        links.linked_card_id = best.id;
        links.linked_bank_id = best.bank_id ?? links.linked_bank_id ?? null;
        return links;
      }
    } else if (parsed.statement_type === "account") {
      const { data: accounts } = await svc.from("financial_accounts")
        .select("id, bank_id, nickname, masked_number, source_email, banks(name)")
        .eq("user_id", userId);
      let best: any = null;
      let bestScore = 0;
      for (const acct of accounts ?? []) {
        let score = 0;
        if (suffixMatches(acct.masked_number, parsed.last4)) score += 8;
        if (bankMatches(acct.banks?.name, bankSlug)) score += 4;
        if (acct.source_email && email?.from_email && String(email.from_email).toLowerCase().includes(String(acct.source_email).toLowerCase())) score += 4;
        score += subjectTokenScore(subject, acct.nickname) * 2;
        if (score > bestScore) { bestScore = score; best = acct; }
      }
      if (best && bestScore >= 5) {
        links.financial_account_id = best.id;
        links.linked_bank_id = best.bank_id ?? links.linked_bank_id ?? null;
        return links;
      }
    }
    return links;
  }

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

// User-defined default candidates, stored in jarvis_memory under
// topic='finance.statement_password_candidates' as a JSON array of strings.
// Tried after the saved per-entity password but before giving up.
export async function loadPasswordCandidates(svc: SupabaseClient, userId: string): Promise<string[]> {
  try {
    const { data } = await svc.from("jarvis_memory")
      .select("content").eq("user_id", userId).eq("topic", "finance.statement_password_candidates").maybeSingle();
    if (!data?.content) return [];
    const parsed = JSON.parse(data.content);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch { return []; }
}

// After a successful rotation, persist the winning password onto the linked
// card/account so subsequent statements decrypt on the first attempt without
// re-cycling the candidate list.
export async function saveWinningPassword(
  svc: SupabaseClient,
  links: { financial_account_id?: string | null; credit_card_id?: string | null },
  winning: string,
): Promise<void> {
  const table = links.credit_card_id ? "credit_cards" : links.financial_account_id ? "financial_accounts" : null;
  const id = links.credit_card_id ?? links.financial_account_id ?? null;
  if (!table || !id) return;
  try {
    const { data } = await svc.from(table).select("statement_password_rule").eq("id", id).maybeSingle();
    if (data?.statement_password_rule) return; // don't overwrite an existing rule
    const rule = await encryptStatementPassword(winning);
    await svc.from(table).update({ statement_password_rule: rule }).eq("id", id);
  } catch (e) {
    console.warn("saveWinningPassword failed", e instanceof Error ? e.message : e);
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
  links: { financial_account_id?: string | null; credit_card_id?: string | null; loan_id?: string | null; linked_bank_id?: string | null },
  opts: { statement_type?: "card" | "account" | "loan" | null; bank_slug?: string | null } = {},
): Promise<void> {
  let payload: any = null;
  try {
    payload = await fetchMessagePayload(svc, account, email);
  } catch (e) {
    // Persist a real reason so the UI surfaces "reconnect Gmail" / retry
    // instead of showing a permanently 'pending' row.
    const msg = e instanceof Error ? e.message : String(e);
    await svc.from("statements").update({
      parse_status: "failed",
      parse_error: msg.startsWith("gmail_fetch_failed") ? "gmail_fetch_failed" : "gmail_fetch_failed",
      parse_reason: msg,
    }).eq("id", statementId);
    return;
  }
  if (!payload) return; // provider not gmail — leave alone

  const pdfAttachment = listAttachments(payload).find((a) =>
    a.mimeType === "application/pdf" || /\.pdf$/i.test(a.filename ?? "")
  );
  if (!pdfAttachment) {
    // Confirmed fact: this statement email has no PDF attached (e.g. a
    // "login to view" notification, common for many banks). Mark 'skipped'
    // with a distinct parse_error so the UI can offer an "Attach PDF"
    // action — the user knows exactly which row needs a manual upload.
    await svc.from("statements").update({
      parse_status: "pending",
      parse_error: "no_pdf_attachment_login_required",
    }).eq("id", statementId);
    return;
  }

  let bytes: Uint8Array;
  try {
    const token = await ensureAccessToken(svc, account);
    bytes = await downloadAttachment(token, email.external_email_id, pdfAttachment.attachmentId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("downloadAttachment failed", msg);
    await svc.from("statements").update({
      parse_status: "failed",
      parse_error: "attachment_download_failed",
      parse_reason: msg,
    }).eq("id", statementId);
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

  // Password rotation: saved rule → user's default candidates → no-password.
  // resolveStatementPassword needs a resolved link (card/account) to fetch
  // the saved rule — call it *now*, after the row has been (re)linked at
  // insert/update time in the caller, so first-time statements whose links
  // were only resolvable at that step still get their saved password.
  const savedPwd = await resolveStatementPassword(svc, email.user_id, links);
  const candidates = await loadPasswordCandidates(svc, email.user_id);
  const ordered = [savedPwd, ...candidates].filter((x): x is string => typeof x === "string" && x.length > 0);
  const rotation = await parseStatementPdfWithPasswords(bytes, ordered, {
    bank_slug: opts.bank_slug ?? null,
    statement_type: opts.statement_type ?? null,
  });
  if (rotation.result.ok && rotation.winning_password && !savedPwd) {
    // Persist the winner so future statements for this card/account skip the loop.
    await saveWinningPassword(svc, links, rotation.winning_password);
  }
  await applyParsedStatementResult(svc, statementId, email.user_id, links, rotation.result, storagePath, attRow.id);
}

// Deterministic post-parse enrichment: normalize the raw merchant string
// coming from a statement line, guess a category from a small keyword map,
// and infer payment_mode from the description shape. No LLM — keeps the
// tail of applyParsedStatementResult fast + free.
function enrich(description: string, txnType: "debit" | "credit"): {
  merchant: string;
  category: string | null;
  payment_mode: string | null;
} {
  const raw = description.trim();
  // Strip common trailing card refs, city codes, POS terminal ids, and
  // padding characters that make merchants look different across rows.
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
  links: { financial_account_id?: string | null; credit_card_id?: string | null; loan_id?: string | null; linked_bank_id?: string | null },
  result: import("./statement-pdf.ts").PdfParseResult,
  storagePath: string | null,
  attachmentId?: string,
): Promise<void> {
  if (!result.ok) {
    // Persist the parser's error message so the UI can show a reason
    // (e.g. "wrong_or_missing_password") instead of an opaque "failed" chip.
    await svc.from("statements").update({
      parse_status: "failed",
      parse_error: result.error ?? "unknown_parse_error",
      file_path: storagePath,
    }).eq("id", statementId);
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
    parse_error: null, // clear any previous failure
    transactions_found: result.lines.length,
    file_path: storagePath,
      parser_source: result.parser_source ?? "generic",
      parse_confidence: result.parse_confidence ?? null,
      credit_card_id: links.credit_card_id ?? null,
      financial_account_id: links.financial_account_id ?? null,
      loan_id: links.loan_id ?? null,
      linked_bank_id: links.linked_bank_id ?? null,
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
    // Forwarded-mail unwrap: dedicated forwarding inboxes (07statement@…)
    // show only the user as `from:`, so pull the original headers out of
    // the quoted forward block first. Use the unwrapped view for detection.
    const outerBody = em.body_text ?? em.snippet ?? null;
    const unwrapped = unwrapForwarded({ ...em, body_text: outerBody });
    const detectionView = {
      ...em,
      from_email: unwrapped.from_email ?? em.from_email,
      from_name: unwrapped.from_name ?? em.from_name,
      subject: unwrapped.subject ?? em.subject,
      body_text: unwrapped.body_text ?? outerBody,
    };
    const treatAll = !!account?.treat_all_as_finance;
    const looksFinance = treatAll || em.finance_related || isFinanceMail(detectionView) || isFinanceSender(detectionView.from_email);
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
      const body = await fetchBody(svc, account, em);
      const unwrappedRe = unwrapForwarded({ ...em, body_text: body });
      const parseView = { ...em, ...unwrappedRe, body_text: unwrappedRe.body_text ?? body };
      const parsedExisting = parseFinanceEmail(parseView);
      const refreshedLinks = parsedExisting?.kind === "statement"
        ? await resolveLinks(svc, em.user_id, parsedExisting, parseView)
        : {
          credit_card_id: exSt.credit_card_id,
          financial_account_id: exSt.financial_account_id,
          loan_id: exSt.loan_id,
        };
      if (parsedExisting?.kind === "statement") {
        const finalCard = refreshedLinks.credit_card_id ?? exSt.credit_card_id ?? null;
        const finalAcct = refreshedLinks.financial_account_id ?? exSt.financial_account_id ?? null;
        const finalLoan = refreshedLinks.loan_id ?? exSt.loan_id ?? null;
        const hasEntity = !!(finalCard || finalAcct || finalLoan);
        // Only clear parse_error when we have a real entity link now; don't
        // clobber a more specific prior error (e.g. wrong_or_missing_password)
        // with a generic "unlinked" reason.
        const patch: Record<string, unknown> = {
          statement_type: parsedExisting.statement_type,
          credit_card_id: finalCard,
          financial_account_id: finalAcct,
          loan_id: finalLoan,
          linked_bank_id: (refreshedLinks as any).linked_bank_id ?? null,
        };
        if (hasEntity) patch.parse_error = null;
        await svc.from("statements").update(patch).eq("id", exSt.id);
      }
      if (exSt.parse_status === "pending" || exSt.parse_status === "failed" || exSt.parse_status === "skipped") {
        await ingestStatementAttachment(svc, account, em, exSt.id, refreshedLinks, {
          statement_type: (parsedExisting?.kind === "statement" ? parsedExisting.statement_type : null),
          bank_slug: guessBankSlugFromSender(parseView.from_email ?? em.from_email),
        });
      }
      skipped++;
      continue;
    }

    const body = await fetchBody(svc, account, em);
    const unwrappedNew = unwrapForwarded({ ...em, body_text: body });
    const parseView = { ...em, ...unwrappedNew, body_text: unwrappedNew.body_text ?? body };
    const parsed = parseFinanceEmail(parseView);
    if (!parsed) { skipped++; continue; }

    const links = await resolveLinks(svc, em.user_id, parsed, parseView);


    // Guess the issuing bank from the sender domain — used for display when
    // no card/account link resolves. Also useful for downstream filtering.
    let linkedBankId: string | null = null;
    const bankSlug = guessBankSlugFromSender(parseView.from_email ?? em.from_email);
    linkedBankId = await findBankId(svc, em.user_id, bankSlug);

    if (!linkedBankId && (links as any).linked_bank_id) linkedBankId = (links as any).linked_bank_id;

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
        linked_bank_id: linkedBankId,
        source: "email",
        confidence: parsed.confidence,
        parse_error: links.credit_card_id || links.financial_account_id || links.loan_id ? null : "unlinked_no_entity_match",
      }).select("id").single();
      if (!se && newStatement) {
        statements++;
        await ingestStatementAttachment(svc, account, em, newStatement.id, links, {
          statement_type: parsed.statement_type,
          bank_slug: bankSlug,
        });
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
