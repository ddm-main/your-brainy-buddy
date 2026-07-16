// Amazon Pay ICICI Bank credit card statement parser.
//
// Layout is unique enough that it needs its own parser (was previously a
// re-export of iciciCardParser, which lost most fields on real PDFs).
// Key quirks:
//   • Currency glyph renders as backtick (`) after pdftotext extraction.
//   • Labels stack above values in a left column:
//       STATEMENT DATE
//         July 1, 2026
//       PAYMENT DUE DATE
//         July 19, 2026
//   • STATEMENT SUMMARY block is a tabular header row followed by a value
//     row (separated by `= + + + -` operator glyphs which we skip).
//   • Transaction rows: `DD/MM/YYYY  SerNo  Description  RewardPts  IntlAmt  Amount [CR]`
//     with a `4315XXXXXXXX6003` card-anchor row that must be skipped.

import type { ParserContext, ParserResult, StatementLine } from "./types.ts";
import { genericExtract, reportMissing } from "./generic.ts";
import { findColumnarBlock, splitCols, stackedValue, toAmount, toIsoDate } from "./shared.ts";

function inferYear(text: string, ctx: ParserContext): number | null {
  if (ctx.statement_year) return ctx.statement_year;
  const m = `${ctx.subject ?? ""} ${text.slice(0, 2000)}`.match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

function cardLast4(text: string): string | null {
  return text.match(/\b\d{4}[X*x]{4,}(\d{4})\b/)?.[1]
    ?? text.match(/\bCredit\s*Card\s*Number\s*\d{2,6}[X*x\s]+(\d{4})\b/i)?.[1]
    ?? null;
}

const SUMMARY_HEADERS = [
  /Total\s*Amount\s*due/i,
  /Previous\s*Balance/i,
  /Purchases\s*\/?\s*Charges/i,
  /Payments?\s*\/?\s*Credits?/i,
];

function summaryFromColumns(text: string): {
  total_due: number | null;
  previous_balance: number | null;
  purchases: number | null;
  cash_advances: number | null;
  payments: number | null;
} {
  const block = findColumnarBlock(text, SUMMARY_HEADERS, 3);
  if (!block) return { total_due: null, previous_balance: null, purchases: null, cash_advances: null, payments: null };
  const pick = (needle: RegExp): number | null => {
    const idx = block.headers.findIndex((h) => needle.test(h));
    if (idx < 0) return null;
    for (const row of block.rows) if (idx < row.length && row[idx]) {
      const val = toAmount(row[idx]);
      if (val != null) return val;
    }
    return null;
  };
  return {
    total_due: pick(/Total\s*Amount\s*due/i),
    previous_balance: pick(/Previous\s*Balance/i),
    purchases: pick(/Purchases/i),
    cash_advances: pick(/Cash\s*Advances?/i),
    payments: pick(/Payments?\s*\/?\s*Credits?/i),
  };
}

// Scan up to `window` non-empty lines below the label and pick the FIRST
// one that yields a real date. Skips the encoded PDF-noise lines that
// ICICI's template renders between STATEMENT DATE and its value.
const DATE_ONELINE = /([A-Za-z]{3,}\s+\d{1,2},\s+\d{4})|(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})|(\d{1,2}\/\d{1,2}\/\d{4})/;
function labeledDate(text: string, label: RegExp, year: number | null, window = 8): string | null {
  const lines = text.split(/\n+/);
  for (let i = 0; i < lines.length; i++) {
    if (!label.test(lines[i])) continue;
    let taken = 0;
    for (let j = i + 1; j < lines.length && taken < window; j++) {
      if (!lines[j].trim()) continue;
      taken++;
      if (label.test(lines[j])) continue;
      const m = lines[j].match(DATE_ONELINE);
      if (m) return toIsoDate(m[0], year);
    }
    return null;
  }
  return null;
}

function labeledAmount(text: string, label: RegExp, window = 8): number | null {
  const lines = text.split(/\n+/);
  for (let i = 0; i < lines.length; i++) {
    if (!label.test(lines[i])) continue;
    let taken = 0;
    for (let j = i + 1; j < lines.length && taken < window; j++) {
      if (!lines[j].trim()) continue;
      taken++;
      if (label.test(lines[j])) continue;
      const m = lines[j].match(/(?:INR|Rs\.?|₹|`)\s*(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)/i)
        ?? lines[j].match(/^\s*(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*$/);
      if (m) return toAmount(m[1]);
    }
    return null;
  }
  return null;
}

function extractAmazonPayLines(text: string, year: number | null, last4: string | null): StatementLine[] {
  const out: StatementLine[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\n+/).map((l) => l.replace(/\s+$/, ""));
  // Only look inside the transactions block: from `Transaction Details`
  // header (or the first `<card-mask>` anchor) to `IMPORTANT MESSAGES` /
  // `Important information` / end.
  let start = lines.findIndex((l) => /Transaction\s*Details/i.test(l));
  if (start < 0) start = lines.findIndex((l) => /\d{4}[X*x]{4,}\d{4}/.test(l));
  const end = lines.findIndex((l) => /IMPORTANT\s*MESSAGES|Important\s*information|EARNINGS/i.test(l));
  const slice = lines.slice(Math.max(0, start), end > 0 ? end : lines.length);

  // Row: `DD/MM/YYYY  SerialNo  Description  RewardPts   [IntlAmt]  Amount [CR]`
  const rowRx = /^\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(?:(\d{6,})\s+)?(.+?)\s+(?:(\d{1,4})\s+)?(?:(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)\s+)?(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(CR|Cr|CREDIT|DR|Dr)?\s*$/i;
  for (const line of slice) {
    // Skip the card-mask anchor row that Amazon Pay ICICI renders between
    // the header and each cardholder's txns.
    if (last4 && new RegExp(`\\d{4}[X*x]{4,}${last4}`).test(line)) continue;
    if (/^\s*International\s*Spends\b/i.test(line)) continue;
    const m = line.match(rowRx);
    if (!m) continue;
    const date = toIsoDate(m[1], year);
    const amount = toAmount(m[6]);
    if (!date || amount == null) continue;
    const description = m[3].replace(/\s{2,}/g, " ").trim();
    if (!description) continue;
    const marker = (m[7] ?? "").toLowerCase();
    const txn_type: "debit" | "credit" = /cr|credit/.test(marker) || /PAYMENT\s+RECEIVED|CASHBACK|REVERSAL/i.test(description) ? "credit" : "debit";
    const key = `${date}|${amount}|${description.slice(0, 40).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, description, amount, txn_type });
  }
  return out;
}

export const amazonPayIciciParser = (text: string, ctx: ParserContext): ParserResult => {
  const year = inferYear(text, ctx);
  const base = genericExtract(text, year);

  const stmtDate = labeledDate(text, /STATEMENT\s*DATE\s*$/im, year)
    ?? labeledDate(text, /^\s*STATEMENT\s*DATE\b/im, year);
  const dueDate = labeledDate(text, /PAYMENT\s*DUE\s*DATE\s*$/im, year)
    ?? labeledDate(text, /^\s*PAYMENT\s*DUE\s*DATE\b/im, year);
  const summary = summaryFromColumns(text);
  const minDue = labeledAmount(text, /Minimum\s*Amount\s*due\s*$/im)
    ?? labeledAmount(text, /^\s*Minimum\s*Amount\s*due\b/im);
  const totalDue = summary.total_due;
  const previousBalance = summary.previous_balance;

  const creditLimit = labeledAmount(text, /Credit\s*Limit\s*\(Including\s*cash\)/i);

  const last4 = cardLast4(text);
  const txns = extractAmazonPayLines(text, year, last4);

  const fields = {
    ...base,
    statement_date: stmtDate ?? base.statement_date,
    due_date: dueDate ?? base.due_date,
    total_due: totalDue ?? base.total_due,
    min_due: minDue ?? base.min_due,
    credit_limit: creditLimit ?? base.credit_limit,
    card_last4: last4 ?? base.card_last4,
    closing_balance: base.closing_balance ?? totalDue ?? previousBalance,
    lines: txns.length ? txns : base.lines,
  };
  const missing = reportMissing(fields, ["statement_date", "due_date", "total_due"]);
  return {
    ok: missing.length === 0,
    fields,
    parser_source: "amazon-pay-icici",
    confidence: missing.length === 0 ? 0.9 : 0.55,
    missing_fields: missing,
    matched_labels: {
      statement_date: stmtDate ? "STATEMENT DATE" : undefined,
      due_date: dueDate ? "PAYMENT DUE DATE" : undefined,
      total_due: totalDue ? "Total Amount due" : undefined,
      min_due: minDue ? "Minimum Amount due" : undefined,
    },
  };
};

// keep splitCols export for consistency with other parsers
export { splitCols };
