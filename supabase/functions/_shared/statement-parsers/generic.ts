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

const DATE_RX = /(\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})|\d{1,2}[\s-]+[A-Za-z]{3,}(?:[\s-]+(?:\d{4}|\d{2}))?)/i;
const AMT_RX  = /(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;

function toAmount(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = raw.match(AMT_RX);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const LINE_DATE_SRC = "(?:\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}|\\d{1,2}\\s+[A-Za-z]{3,}(?:\\s+\\d{2,4})?)";
const LINE_ROW = /^\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,}(?:\s+\d{2,4})?)\s+(.+)$/i;
const LINE_AMT  = /((?:[0-9]{1,3}(?:,[0-9]{2,3})+|[0-9]+)(?:\.[0-9]{2})?)\s*(Cr|CR|Dr|DR|Debit|Credit|C|D|\-|\+)?\s*$/i;
const TYPED_AMT = /((?:[0-9]{1,3}(?:,[0-9]{2,3})+|[0-9]+)(?:\.[0-9]{2})?)\s*(Cr|CR|Dr|DR|Debit|Credit|C|D)\b/gi;

function normLineDate(raw: string, fallbackYear?: number | null): string | null {
  const s = raw.trim().replace(/\s+/g, " ");
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})$/);
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
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})$/);
  if (m && fallbackYear) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${fallbackYear}-${mon}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

export function extractLines(text: string, fallbackYear?: number | null): StatementLine[] {
  const lines: StatementLine[] = [];
  const rawLines = text
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks = rawLines
    .flatMap((ln) => ln.replace(new RegExp(`\\s+(?=${LINE_DATE_SRC}\\s+)`, "g"), "\n").split(/\n+/))
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const addFromChunk = (chunk: string) => {
    const dm = chunk.match(LINE_ROW);
    if (!dm) return;
    const date = normLineDate(dm[1], fallbackYear);
    if (!date) return;
    const rest = dm[2];
    const typed = Array.from(rest.matchAll(TYPED_AMT));
    const t = typed.at(-1);
    let am = t
      ? Object.assign([t[0], t[1], t[2]], { index: t.index ?? 0, input: rest }) as RegExpMatchArray
      : null;
    if (!am) {
      am = rest.match(LINE_AMT) as RegExpMatchArray | null;
    }
    if (!am) return;
    const amount = Number(am[1].replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) return;
    const desc = rest.slice(0, am.index ?? rest.length).trim();
    if (!desc || desc.length < 2) return;
    let txn_type: "debit" | "credit" = "debit";
    if (am[2]) {
      const d = am[2].toLowerCase();
      txn_type = d === "cr" || d === "credit" || d === "c" || d === "+" ? "credit" : "debit";
    } else if (/\b(refund|reversal|received|credit|salary|interest paid)\b/i.test(desc)) {
      txn_type = "credit";
    }
    const key = `${date}|${amount}|${desc.slice(0, 40).toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push({ date, description: desc, amount, txn_type });
  };
  for (const chunk of chunks) {
    addFromChunk(chunk);
  }
  if (lines.length === 0) for (const line of rawLines) addFromChunk(line);
  return lines;
}

export function genericExtract(text: string, fallbackYear?: number | null): ParsedStatementFields {
  const periodMatch = text.match(new RegExp(`statement\\s*period\\s*[:\\s]*${DATE_RX.source}\\s*(?:to|-|–)\\s*${DATE_RX.source}`, "i"));
  const dueDateMatch = text.match(new RegExp(`payment\\s*due\\s*date\\s*[:\\s]*${DATE_RX.source}`, "i"));
  const statementDateMatch = text.match(new RegExp(`statement\\s*date\\s*[:\\s]*${DATE_RX.source}`, "i"));
  const totalDueMatch = text.match(/total\s*(?:amount\s*)?due\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const minDueMatch = text.match(/(?:minimum\s*(?:amount\s*)?due|min\.?\s*due)\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const closingBalMatch = text.match(/closing\s*balance\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);

  return {
    period_start: periodMatch ? toIsoDate(periodMatch[1], fallbackYear) : null,
    period_end: periodMatch ? toIsoDate(periodMatch[2], fallbackYear) : null,
    statement_date: statementDateMatch ? toIsoDate(statementDateMatch[1], fallbackYear) : null,
    due_date: dueDateMatch ? toIsoDate(dueDateMatch[1], fallbackYear) : null,
    total_due: totalDueMatch ? toAmount(totalDueMatch[0]) : null,
    min_due: minDueMatch ? toAmount(minDueMatch[0]) : null,
    closing_balance: closingBalMatch ? toAmount(closingBalMatch[0]) : null,
    lines: extractLines(text, fallbackYear),
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

export const genericParser = (text: string, ctx: ParserContext): ParserResult => {
  const fields = genericExtract(text, ctx.statement_year ?? null);
  const missing_fields = reportMissing(fields, ["period_start", "period_end", "statement_date"]);
  return {
    ok: missing_fields.length < 3, // at least *some* fields hit
    fields,
    parser_source: "generic",
    confidence: 0.35,
    missing_fields,
  };
};
