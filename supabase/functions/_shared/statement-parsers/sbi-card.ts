// SBI Card statement parser — covers BPCL SBI, Cashback SBI, and other
// SBI-issued cards that share the same statement layout. Falls back to the
// generic extractor for line items and any field the SBI-specific regex
// misses.

import type { ParserContext, ParserResult, StatementLine } from "./types.ts";
import { extractLines, genericExtract, reportMissing } from "./generic.ts";
import { inferYear, toAmount, toIsoDate } from "./shared.ts";

const DATE = /([0-9]{1,2}[./-][0-9]{1,2}[./-](?:[0-9]{4}|[0-9]{2})|[0-9]{1,2}[\s-]+[A-Za-z]{3,}(?:[\s-]+(?:[0-9]{4}|[0-9]{2}))?)/;
const AMOUNT_ONLY = /^\s*(?:INR|Rs\.?|₹|`|\(|\)|\s)*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:CR|DR|C|D)?\s*$/i;

function normalizedLines(text: string): string[] {
  return text
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .split(/\n+/)
    .map((line) => line.replace(/\s{2,}/g, " ").trim())
    .filter(Boolean);
}

// SBI masks credit card numbers as `XXXX XXXX XXXX XX##` — only the trailing
// 2 digits are exposed. Anchor on the `Credit Card Number` label to avoid
// pulling `2999` from the fee-waiver line at the bottom of the statement.
function sbiCardLast4(rawText: string): string | null {
  const lines = rawText.replace(/\r/g, "\n").split(/\n+/);
  for (let i = 0; i < lines.length; i++) {
    if (!/\bCredit\s*Card\s*Number\b/i.test(lines[i])) continue;
    for (let j = i + 1; j <= Math.min(lines.length - 1, i + 4); j++) {
      const raw = lines[j].trim();
      if (!raw) continue;
      const m = raw.match(/[X\*]{2,}\s*([0-9]{2,4})\b/i);
      if (m) return m[1];
      const m2 = raw.match(/^\d{4}[X*]+\d{2,4}$/);
      if (m2) return raw.slice(-4);
    }
  }
  // Fallback: full 12-mask form (some SBI variants render `4784XXXXXXXX1234`)
  return rawText.match(/\b\d{4}[X*]{4,}(\d{4})\b/)?.[1] ?? null;
}

function lastDateIn(raw: string, fallbackYear?: number | null): string | null {
  const matches = Array.from(raw.matchAll(new RegExp(DATE.source, "gi")));
  for (let i = matches.length - 1; i >= 0; i--) {
    const iso = toIsoDate(matches[i][1], fallbackYear);
    if (iso) return iso;
  }
  return null;
}

function dateNearLabel(lines: string[], label: RegExp, fallbackYear?: number | null): string | null {
  const idx = lines.findIndex((line) => label.test(line));
  if (idx < 0) return null;
  for (let i = idx; i <= Math.min(lines.length - 1, idx + 3); i++) {
    const iso = lastDateIn(lines[i], fallbackYear);
    if (iso) return iso;
  }
  return null;
}

function amountAfterLabel(lines: string[], label: RegExp): number | null {
  const idx = lines.findIndex((line) => label.test(line));
  if (idx < 0) return null;
  const match = lines[idx].match(label);
  const cursor = (match?.index ?? 0) + (match?.[0]?.length ?? 0);
  const inlineAmount = toAmount(lines[idx].slice(cursor));
  if (inlineAmount !== null) return inlineAmount;
  for (let i = idx + 1; i <= Math.min(lines.length - 1, idx + 5); i++) {
    if (/\b(stmt|statement\s+no|ckyc|credit\s+limit|available|pay\s+now|card\s+number)\b/i.test(lines[i])) continue;
    const amountOnly = lines[i].match(AMOUNT_ONLY);
    if (amountOnly) return toAmount(amountOnly[1]);
  }
  return null;
}

function extractSbiLines(lines: string[], fallbackYear?: number | null): StatementLine[] {
  const out: StatementLine[] = [];
  const seen = new Set<string>();
  const rowStartRx = /^\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,}(?:\s+\d{2,4})?)\s+(.+)$/i;
  const amountTokenRx = /((?:[0-9]{1,3}(?:,[0-9]{2,3})+|[0-9]+)(?:\.[0-9]{2})?)\s*(C|D|Cr|CR|Dr|DR|Credit|Debit)?\b/gi;
  for (const line of lines) {
    const m = line.match(rowStartRx);
    if (!m) continue;
    const date = toIsoDate(m[1], fallbackYear);
    const rest = m[2].trim();
    const tokens = Array.from(rest.matchAll(amountTokenRx));
    if (!tokens.length) continue;
    const token = tokens.find((tok) => tok[2]) ?? tokens[tokens.length - 1];
    const amount = toAmount(token[1]);
    if (!date || amount == null || amount <= 0) continue;
    const description = rest.slice(0, token.index).trim();
    if (!description || /^(date|transaction details|transactions for)/i.test(description)) continue;
    const marker = (token[2] ?? "D").toLowerCase();
    const txn_type = marker === "c" || marker === "cr" || marker === "credit" ? "credit" : "debit";
    const key = `${date}|${amount}|${description.slice(0, 40).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, description, amount, txn_type });
  }
  return out;
}

export const sbiCardParser = (text: string, ctx: ParserContext): ParserResult => {
  const inferredYear = inferYear(text, ctx);
  const base = genericExtract(text, inferredYear);

  const compact = text.replace(/\r/g, "\n").replace(/\u00a0/g, " ");
  const lines = normalizedLines(compact);
  const statementDateMatch = compact.match(new RegExp(`statement\\s*date\\s*[:\\s]*${DATE.source}`, "i"))
    ?? compact.match(new RegExp(`date\\s*of\\s*statement\\s*[:\\s]*${DATE.source}`, "i"));
  const dueDateMatch = compact.match(new RegExp(`(?:payment\\s*)?due\\s*date\\s*[:\\s]*${DATE.source}`, "i"))
    ?? compact.match(new RegExp(`payment\\s*due\\s*on\\s*[:\\s]*${DATE.source}`, "i"));
  // Handle SBI's "NO PAYMENT REQUIRED" sentinel when the card has zero balance.
  const noPaymentRequired = /NO\s*PAYMENT\s*REQUIRED/i.test(compact);
  const totalDueMatch = compact.match(/(?:total\s*(?:amount\s*)?due|total\s*payment\s*due|amount\s*payable)\s*[:\s]*(?:INR|Rs\.?|₹|`)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const minDueMatch = compact.match(/(?:minimum\s*(?:amount\s*)?due|min\.?\s*due)\s*[:\s]*(?:INR|Rs\.?|₹|`)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const periodMatch = compact.match(new RegExp(`(?:statement\\s*)?period\\s*[:\\s]*${DATE.source}\\s*(?:to|-|–)\\s*${DATE.source}`, "i"))
    ?? compact.match(new RegExp(`for\\s+the\\s+period\\s+${DATE.source}\\s*(?:to|-|–)\\s*${DATE.source}`, "i"));
  const creditLimitMatch = compact.match(/credit\s*limit[^\n]*?[:\s]*(?:INR|Rs\.?|₹|`)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const splitStatementDate = dateNearLabel(lines, /\bstatement\s*date\b/i, inferredYear);
  const splitDueDate = dateNearLabel(lines, /\bpayment\s*due\s*date\b|\bdue\s*date\b/i, inferredYear);
  const splitTotalDue = amountAfterLabel(lines, /\btotal\s*(?:amount\s*)?due\b/i);
  const splitMinDue = amountAfterLabel(lines, /\bminimum\s*(?:amount\s*)?due\b|\bmin\.?\s*due\b/i);

  const sbiLines = extractSbiLines(lines, inferredYear);
  const resolvedTotal = (totalDueMatch ? toAmount(totalDueMatch[1]) : null) ?? splitTotalDue ?? base.total_due;
  const resolvedStmtDate = (statementDateMatch ? toIsoDate(statementDateMatch[1], inferredYear) : null) ?? splitStatementDate ?? base.statement_date;
  const last4 = sbiCardLast4(text);

  const fields = {
    ...base,
    statement_date: resolvedStmtDate,
    // NO PAYMENT REQUIRED (zero balance) — treat statement_date as the effective due_date placeholder.
    due_date: (dueDateMatch ? toIsoDate(dueDateMatch[1], inferredYear) : null) ?? splitDueDate ?? (noPaymentRequired ? resolvedStmtDate : base.due_date),
    total_due: noPaymentRequired && resolvedTotal == null ? 0 : resolvedTotal,
    min_due: (minDueMatch ? toAmount(minDueMatch[1]) : null) ?? splitMinDue ?? base.min_due,
    period_start: periodMatch ? toIsoDate(periodMatch[1], inferredYear) : base.period_start,
    period_end: periodMatch ? toIsoDate(periodMatch[2], inferredYear) : base.period_end,
    credit_limit: (creditLimitMatch ? toAmount(creditLimitMatch[1]) : null) ?? base.credit_limit,
    closing_balance: base.closing_balance ?? resolvedTotal,
    card_last4: last4 ?? base.card_last4,
    lines: sbiLines.length ? sbiLines : (base.lines.length ? base.lines : extractLines(compact, inferredYear)),
  };

  const missing = reportMissing(fields, ["statement_date", "due_date", "total_due"]);
  const hay = `${ctx.subject ?? ""} ${text.slice(0, 400)}`.toLowerCase();
  let inferred = ctx.card_family ?? null;
  if (!inferred) {
    if (/bpcl/.test(hay)) inferred = "bpcl";
    else if (/cashback/.test(hay)) inferred = "cashback";
    else if (/simply\s*click|simplyclick/.test(hay)) inferred = "simplyclick";
  }
  const family = inferred ? `-${inferred}` : "";
  return {
    ok: missing.length === 0,
    fields,
    parser_source: `sbi-card${family}`,
    confidence: missing.length === 0 ? 0.85 : 0.6,
    missing_fields: missing,
    matched_labels: {
      statement_date: (statementDateMatch || splitStatementDate) ? "Statement Date" : undefined,
      due_date: (dueDateMatch || splitDueDate) ? "Payment Due Date" : undefined,
      total_due: (totalDueMatch || splitTotalDue) ? "Total Amount Due" : undefined,
      min_due: (minDueMatch || splitMinDue) ? "Minimum Amount Due" : undefined,
      period: periodMatch ? "Statement Period" : undefined,
    },
  };
};
