// SBI Card statement parser — covers BPCL SBI, Cashback SBI, and other
// SBI-issued cards that share the same statement layout. Falls back to the
// generic extractor for line items and any field the SBI-specific regex
// misses.

import type { ParserContext, ParserResult, StatementLine } from "./types.ts";
import { extractLines, genericExtract, reportMissing } from "./generic.ts";

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function toIsoDate(raw: string | undefined | null, fallbackYear?: number | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})$/);
  if (m) {
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yr}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{2}|\d{4})$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (mon) return `${yr}-${mon}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})$/);
  if (m && fallbackYear) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${fallbackYear}-${mon}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

function toAmount(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = raw.match(/([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const DATE = /([0-9]{1,2}[./-][0-9]{1,2}[./-](?:[0-9]{4}|[0-9]{2})|[0-9]{1,2}[\s-]+[A-Za-z]{3,}(?:[\s-]+(?:[0-9]{4}|[0-9]{2}))?)/;
const AMOUNT_ONLY = /^\s*(?:INR|Rs\.?|₹|`|\(|\)|\s)*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:CR|DR|C|D)?\s*$/i;

function inferYear(text: string, ctx: ParserContext): number | null {
  if (ctx.statement_year) return ctx.statement_year;
  const hay = `${ctx.subject ?? ""} ${text.slice(0, 1200)}`;
  const full = hay.match(/\b(20\d{2})\b/);
  if (full) return Number(full[1]);
  return null;
}

function normalizedLines(text: string): string[] {
  return text
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .split(/\n+/)
    .map((line) => line.replace(/\s{2,}/g, " ").trim())
    .filter(Boolean);
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
  const inline = lines[idx].slice((lines[idx].match(label)?.index ?? 0) + (lines[idx].match(label)?.[0]?.length ?? 0));
  const inlineAmount = toAmount(inline);
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
  const rowRx = /^\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,}(?:\s+\d{2,4})?)\s+(.+?)\s+((?:[0-9]{1,3}(?:,[0-9]{2,3})+|[0-9]+)(?:\.[0-9]{2})?)\s*(C|D|Cr|CR|Dr|DR|Credit|Debit)\s*$/i;
  for (const line of lines) {
    const m = line.match(rowRx);
    if (!m) continue;
    const date = toIsoDate(m[1], fallbackYear);
    const amount = toAmount(m[3]);
    if (!date || amount == null || amount <= 0) continue;
    const description = m[2].trim();
    if (!description || /^(date|transaction details|transactions for)/i.test(description)) continue;
    const marker = m[4].toLowerCase();
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
  const totalDueMatch = compact.match(/(?:total\s*(?:amount\s*)?due|total\s*payment\s*due|amount\s*payable)\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const minDueMatch = compact.match(/(?:minimum\s*(?:amount\s*)?due|min\.?\s*due)\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const periodMatch = compact.match(new RegExp(`(?:statement\\s*)?period\\s*[:\\s]*${DATE.source}\\s*(?:to|-|–)\\s*${DATE.source}`, "i"))
    ?? compact.match(new RegExp(`for\\s+the\\s+period\\s+${DATE.source}\\s*(?:to|-|–)\\s*${DATE.source}`, "i"));
  const creditLimitMatch = compact.match(/credit\s*limit\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const splitStatementDate = dateNearLabel(lines, /\bstatement\s*date\b/i, inferredYear);
  const splitDueDate = dateNearLabel(lines, /\bpayment\s*due\s*date\b|\bdue\s*date\b/i, inferredYear);
  const splitTotalDue = amountAfterLabel(lines, /\btotal\s*(?:amount\s*)?due\b/i);
  const splitMinDue = amountAfterLabel(lines, /\bminimum\s*(?:amount\s*)?due\b|\bmin\.?\s*due\b/i);

  const sbiLines = extractSbiLines(lines, inferredYear);
  const fields = {
    ...base,
    statement_date: (statementDateMatch ? toIsoDate(statementDateMatch[1], inferredYear) : null) ?? splitStatementDate ?? base.statement_date,
    due_date: (dueDateMatch ? toIsoDate(dueDateMatch[1], inferredYear) : null) ?? splitDueDate ?? base.due_date,
    total_due: (totalDueMatch ? toAmount(totalDueMatch[1]) : null) ?? splitTotalDue ?? base.total_due,
    min_due: (minDueMatch ? toAmount(minDueMatch[1]) : null) ?? splitMinDue ?? base.min_due,
    period_start: periodMatch ? toIsoDate(periodMatch[1], inferredYear) : base.period_start,
    period_end: periodMatch ? toIsoDate(periodMatch[2], inferredYear) : base.period_end,
    // SBI Card statements don't carry a running "closing balance" like an
    // account statement — total_due is the payable amount.
    closing_balance: base.closing_balance ?? (totalDueMatch ? toAmount(totalDueMatch[1]) : null) ?? splitTotalDue,
    lines: sbiLines.length ? sbiLines : (base.lines.length ? base.lines : extractLines(compact, inferredYear)),
  };

  const missing = reportMissing(fields, ["statement_date", "due_date", "total_due"]);
  void creditLimitMatch; // reserved for future card-limit sync
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
