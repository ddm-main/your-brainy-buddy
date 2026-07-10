// Turn stored finance emails into structured records: transactions,
// statements, EMIs, investments — auto-linked to a card / account / loan when
// possible. Idempotent: safe to re-run on the same email set.

import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ensureAccessToken, extractBody, gapi } from "./gmail.ts";
import { isFinanceMail, isFinanceSender, parseFinanceEmail, type Parsed } from "./finance-parsers.ts";

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

    // Skip if already extracted (idempotency via unique index).
    const { data: exTx } = await svc.from("transactions").select("id").eq("user_id", em.user_id).eq("source_email_id", em.id).maybeSingle();
    const { data: exSt } = await svc.from("statements").select("id").eq("user_id", em.user_id).eq("source_email_id", em.id).maybeSingle();
    if (exTx || exSt) { skipped++; continue; }

    const body = await fetchBody(svc, account, em);
    const parsed = parseFinanceEmail({ ...em, body_text: body });
    if (!parsed) { skipped++; continue; }

    const links = await resolveLinks(svc, em.user_id, parsed);

    if (parsed.kind === "statement") {
      const { error: se } = await svc.from("statements").insert({
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
      });
      if (!se) statements++;
      else if (!String(se.message).includes("duplicate")) console.warn("statement insert", se.message);
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
