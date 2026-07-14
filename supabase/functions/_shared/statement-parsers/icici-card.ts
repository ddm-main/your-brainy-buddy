// ICICI Bank credit card statement parser.

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
  return m ? Number(m[1].replace(/,/g, "")) : null;
}
const DATE = /([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4}|[0-9]{1,2}[\s-]+[A-Za-z]{3,}[\s-]+[0-9]{4})/;

export const iciciCardParser = (text: string, ctx: ParserContext): ParserResult => {
  const base = genericExtract(text);
  const period = text.match(new RegExp(`statement\\s*period\\s*[:\\s]*${DATE.source}\\s*(?:to|-|–)\\s*${DATE.source}`, "i"));
  const dueDate = text.match(new RegExp(`(?:payment\\s*)?due\\s*date\\s*[:\\s]*${DATE.source}`, "i"));
  const totalDue = text.match(/total\s*amount\s*due\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const minDue = text.match(/minimum\s*amount\s*due\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const stmtDate = text.match(new RegExp(`statement\\s*date\\s*[:\\s]*${DATE.source}`, "i"));

  const fields = {
    ...base,
    period_start: period ? toIsoDate(period[1]) : base.period_start,
    period_end: period ? toIsoDate(period[2]) : base.period_end,
    due_date: dueDate ? toIsoDate(dueDate[1]) : base.due_date,
    total_due: totalDue ? toAmount(totalDue[1]) : base.total_due,
    min_due: minDue ? toAmount(minDue[1]) : base.min_due,
    statement_date: stmtDate ? toIsoDate(stmtDate[1]) : (base.statement_date ?? (period ? toIsoDate(period[2]) : null)),
  };
  const family = ctx.card_family ? `-${ctx.card_family}` : "";
  const missing = reportMissing(fields, ["due_date", "total_due"]);
  return {
    ok: missing.length === 0,
    fields,
    parser_source: `icici-card${family}`,
    confidence: missing.length === 0 ? 0.85 : 0.55,
    missing_fields: missing,
  };
};