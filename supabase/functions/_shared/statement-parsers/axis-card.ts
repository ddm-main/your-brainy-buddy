// Axis Bank credit card statement parser (also base for airtel-axis co-brand).

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

export const axisCardParser = (text: string, ctx: ParserContext): ParserResult => {
  const base = genericExtract(text);
  const stmtDate = text.match(new RegExp(`statement\\s*date\\s*[:\\s]*${DATE.source}`, "i"));
  const dueDate = text.match(new RegExp(`(?:payment\\s*)?due\\s*date\\s*[:\\s]*${DATE.source}`, "i"));
  const totalDue = text.match(/total\s*(?:amount\s*)?(?:due|payment\s*due)\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const minDue = text.match(/minimum\s*(?:amount\s*)?due\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const fields = {
    ...base,
    statement_date: stmtDate ? toIsoDate(stmtDate[1]) : base.statement_date,
    due_date: dueDate ? toIsoDate(dueDate[1]) : base.due_date,
    total_due: totalDue ? toAmount(totalDue[1]) : base.total_due,
    min_due: minDue ? toAmount(minDue[1]) : base.min_due,
  };
  const family = ctx.card_family === "airtel" ? "-airtel" : "";
  const missing = reportMissing(fields, ["statement_date", "due_date", "total_due"]);
  return {
    ok: missing.length === 0,
    fields,
    parser_source: `axis-card${family}`,
    confidence: missing.length === 0 ? 0.85 : 0.55,
    missing_fields: missing,
  };
};

export const airtelAxisCardParser = (text: string, ctx: ParserContext): ParserResult => {
  return axisCardParser(text, { ...ctx, card_family: "airtel" });
};