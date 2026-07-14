// SBI Card statement parser — covers BPCL SBI, Cashback SBI, and other
// SBI-issued cards that share the same statement layout. Falls back to the
// generic extractor for line items and any field the SBI-specific regex
// misses.

import type { ParserContext, ParserResult } from "./types.ts";
import { genericExtract, reportMissing } from "./generic.ts";

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
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const DATE = /([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4}|[0-9]{1,2}[\s-]+[A-Za-z]{3,}[\s-]+[0-9]{4})/;

export const sbiCardParser = (text: string, ctx: ParserContext): ParserResult => {
  const base = genericExtract(text);

  const statementDateMatch = text.match(new RegExp(`statement\\s*date\\s*[:\\s]*${DATE.source}`, "i"));
  const dueDateMatch = text.match(new RegExp(`(?:payment\\s*)?due\\s*date\\s*[:\\s]*${DATE.source}`, "i"));
  const totalDueMatch = text.match(/total\s*(?:amount\s*)?due\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const minDueMatch = text.match(/(?:minimum\s*amount\s*due|min\.?\s*due)\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const periodMatch = text.match(new RegExp(`(?:statement\\s*)?period\\s*[:\\s]*${DATE.source}\\s*(?:to|-|–)\\s*${DATE.source}`, "i"));
  const creditLimitMatch = text.match(/credit\s*limit\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);

  const fields = {
    ...base,
    statement_date: statementDateMatch ? toIsoDate(statementDateMatch[1]) : base.statement_date,
    due_date: dueDateMatch ? toIsoDate(dueDateMatch[1]) : base.due_date,
    total_due: totalDueMatch ? toAmount(totalDueMatch[1]) : base.total_due,
    min_due: minDueMatch ? toAmount(minDueMatch[1]) : base.min_due,
    period_start: periodMatch ? toIsoDate(periodMatch[1]) : base.period_start,
    period_end: periodMatch ? toIsoDate(periodMatch[2]) : base.period_end,
    // SBI Card statements don't carry a running "closing balance" like an
    // account statement — total_due is the payable amount.
    closing_balance: base.closing_balance ?? (totalDueMatch ? toAmount(totalDueMatch[1]) : null),
  };

  const missing = reportMissing(fields, ["statement_date", "due_date", "total_due"]);
  void creditLimitMatch; // reserved for future card-limit sync
  const family = ctx.card_family ? `-${ctx.card_family}` : "";
  return {
    ok: missing.length === 0,
    fields,
    parser_source: `sbi-card${family}`,
    confidence: missing.length === 0 ? 0.85 : 0.6,
    missing_fields: missing,
  };
};
