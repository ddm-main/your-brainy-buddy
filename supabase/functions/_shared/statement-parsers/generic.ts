// Generic heuristic parser — the fallback used when no bank-specific parser
// is registered (or when the specific parser returns ok=false). Extracts the
// most common Indian bank/card statement fields with permissive regex; every
// missing field is reported back so the dispatcher can log which real parser
// still needs to be filled in.

import type { ParsedStatementFields, ParserContext, ParserResult, StatementLine } from "./types.ts";

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

const DATE_RX = /(\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{1,2}[\s-]+[A-Za-z]{3,}[\s-]+\d{4})/i;
const AMT_RX  = /(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;

function toAmount(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = raw.match(AMT_RX);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const LINE_DATE = /(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,}\s+\d{2,4})/;
const LINE_AMT  = /([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{2})?)\s*(Cr|CR|Dr|DR|\-|\+)?\s*$/;

function normLineDate(raw: string): string | null {
  const s = raw.trim().replace(/\s+/g, " ");
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (m) {
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yr}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{2}|\d{4})$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (mon) return `${yr}-${mon}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

export function extractLines(text: string): StatementLine[] {
  const lines: StatementLine[] = [];
  const chunks = text
    .split(/\n+/)
    .flatMap((ln) => ln.split(new RegExp(`(?=\\s${LINE_DATE.source})`)))
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const dm = chunk.match(new RegExp(`^${LINE_DATE.source}\\s+(.+)$`));
    if (!dm) continue;
    const date = normLineDate(dm[1]);
    if (!date) continue;
    const rest = dm[2];
    const am = rest.match(LINE_AMT);
    if (!am) continue;
    const amount = Number(am[1].replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const desc = rest.slice(0, am.index ?? rest.length).trim();
    if (!desc || desc.length < 2) continue;
    let txn_type: "debit" | "credit" = "debit";
    if (am[2]) {
      const d = am[2].toLowerCase();
      txn_type = d === "cr" || d === "+" ? "credit" : "debit";
    } else if (/\b(refund|reversal|received|credit|salary|interest paid)\b/i.test(desc)) {
      txn_type = "credit";
    }
    const key = `${date}|${amount}|${desc.slice(0, 40).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({ date, description: desc, amount, txn_type });
  }
  return lines;
}

export function genericExtract(text: string): ParsedStatementFields {
  const periodMatch = text.match(new RegExp(`statement\\s*period\\s*[:\\s]*${DATE_RX.source}\\s*(?:to|-|–)\\s*${DATE_RX.source}`, "i"));
  const dueDateMatch = text.match(new RegExp(`payment\\s*due\\s*date\\s*[:\\s]*${DATE_RX.source}`, "i"));
  const statementDateMatch = text.match(new RegExp(`statement\\s*date\\s*[:\\s]*${DATE_RX.source}`, "i"));
  const totalDueMatch = text.match(/total\s*(?:amount\s*)?due\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const minDueMatch = text.match(/(?:minimum\s*(?:amount\s*)?due|min\.?\s*due)\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const closingBalMatch = text.match(/closing\s*balance\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);

  return {
    period_start: periodMatch ? toIsoDate(periodMatch[1]) : null,
    period_end: periodMatch ? toIsoDate(periodMatch[2]) : null,
    statement_date: statementDateMatch ? toIsoDate(statementDateMatch[1]) : null,
    due_date: dueDateMatch ? toIsoDate(dueDateMatch[1]) : null,
    total_due: totalDueMatch ? toAmount(totalDueMatch[0]) : null,
    min_due: minDueMatch ? toAmount(minDueMatch[0]) : null,
    closing_balance: closingBalMatch ? toAmount(closingBalMatch[0]) : null,
    lines: extractLines(text),
  };
}

export function reportMissing(fields: ParsedStatementFields, required: (keyof ParsedStatementFields)[]): string[] {
  const missing: string[] = [];
  for (const k of required) {
    const v = fields[k];
    if (v === null || (Array.isArray(v) && v.length === 0)) missing.push(String(k));
  }
  return missing;
}

export const genericParser = (text: string, _ctx: ParserContext): ParserResult => {
  const fields = genericExtract(text);
  const missing_fields = reportMissing(fields, ["period_start", "period_end", "statement_date"]);
  return {
    ok: missing_fields.length < 3, // at least *some* fields hit
    fields,
    parser_source: "generic",
    confidence: 0.35,
    missing_fields,
  };
};
