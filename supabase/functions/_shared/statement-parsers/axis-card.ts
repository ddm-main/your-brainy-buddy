// Axis Bank credit card statement parser (also base for airtel-axis co-brand).
//
// Modern Axis/Airtel-Axis statements (2025+) use a two-row PAYMENT SUMMARY
// table with no colons after labels — the same tabular layout as YES Bank
// KLICK. We reuse the KLICK block helpers so both parsers stay in lockstep.
// Legacy colon-per-label layouts still resolve through the genericExtract
// fallback.

import type { ParserContext, ParserResult } from "./types.ts";
import { genericExtract, reportMissing } from "./generic.ts";
import { yesKlickBlockHelpers } from "./yes-card.ts";

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
function toIsoDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
  }
  return null;
}
function toAmount(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = raw.match(/([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}
const DATE = /([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4}|[0-9]{1,2}[\s-]+[A-Za-z]{3,}[\s-]+[0-9]{4})/;

export const axisCardParser = (text: string, ctx: ParserContext): ParserResult => {
  const year = yesKlickBlockHelpers.inferYear(text, ctx);
  const base = genericExtract(text, year);

  // 1) Tabular PAYMENT SUMMARY block — modern layout (Airtel Axis, KLICK
  //    co-brands). Falls through to legacy label-with-colon regexes when the
  //    block-based extractor returns null.
  const block = yesKlickBlockHelpers.summaryBlock(text);
  const period = yesKlickBlockHelpers.summaryPeriod(block, year);
  const blockStmtDate = yesKlickBlockHelpers.summaryDate(block, /Statement\s*(?:Generation\s*)?Date/i, year);
  const blockDueDate = yesKlickBlockHelpers.summaryDate(block, /Payment\s*Due\s*Date/i, year);
  const blockTotalDue = yesKlickBlockHelpers.summaryAmount(block, /Total\s*(?:Payment|Amount)\s*Due/i);
  const blockMinDue = yesKlickBlockHelpers.summaryAmount(block, /Minimum\s*(?:Payment|Amount)\s*Due/i);
  const blockCreditLimit = yesKlickBlockHelpers.creditLimit(block);
  const blockLast4 = yesKlickBlockHelpers.cardLast4(text);
  const blockLines = yesKlickBlockHelpers.extractYesLines(text, year);

  // 2) Legacy label-with-colon regexes as a last-resort fallback.
  const stmtDate = text.match(new RegExp(`statement\\s*date\\s*[:\\s]*${DATE.source}`, "i"));
  const dueDate = text.match(new RegExp(`(?:payment\\s*)?due\\s*date\\s*[:\\s]*${DATE.source}`, "i"));
  const totalDue = text.match(/total\s*(?:amount\s*)?(?:due|payment\s*due)\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const minDue = text.match(/minimum\s*(?:amount\s*)?due\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);

  const fields = {
    ...base,
    period_start: period.start ?? base.period_start,
    period_end: period.end ?? base.period_end,
    statement_date: blockStmtDate ?? (stmtDate ? toIsoDate(stmtDate[1]) : base.statement_date),
    due_date: blockDueDate ?? (dueDate ? toIsoDate(dueDate[1]) : base.due_date),
    total_due: blockTotalDue ?? (totalDue ? toAmount(totalDue[1]) : base.total_due),
    min_due: blockMinDue ?? (minDue ? toAmount(minDue[1]) : base.min_due),
    credit_limit: blockCreditLimit ?? base.credit_limit,
    card_last4: blockLast4 ?? base.card_last4,
    lines: blockLines.length ? blockLines : base.lines,
  };
  const family = ctx.card_family === "airtel" ? "-airtel" : "";
  const missing = reportMissing(fields, ["statement_date", "due_date", "total_due"]);
  return {
    ok: missing.length === 0,
    fields,
    parser_source: `axis-card${family}`,
    confidence: missing.length === 0 ? 0.88 : 0.55,
    missing_fields: missing,
    matched_labels: {
      statement_date: fields.statement_date ? "Statement Date" : undefined,
      due_date: fields.due_date ? "Payment Due Date" : undefined,
      total_due: fields.total_due ? "Total Payment Due" : undefined,
      min_due: fields.min_due ? "Minimum Due" : undefined,
      period: fields.period_start && fields.period_end ? "Statement Period" : undefined,
    },
  };
};

export const airtelAxisCardParser = (text: string, ctx: ParserContext): ParserResult => {
  return axisCardParser(text, { ...ctx, card_family: "airtel" });
};
