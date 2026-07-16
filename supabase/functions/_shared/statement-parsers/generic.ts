// Generic heuristic parser — fallback used when no bank-specific parser is
// registered. It is deliberately layout-aware because many bank PDFs render
// labels and values in adjacent rows/columns.

import type { ParsedStatementFields, ParserContext, ParserResult, StatementLine } from "./types.ts";

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
const DATE_SRC = "(?:\\d{1,2}[./-]\\d{1,2}[./-](?:\\d{4}|\\d{2})|\\d{1,2}[\\s-]+[A-Za-z]{3,}(?:[\\s-]+(?:\\d{4}|\\d{2}))?|[A-Za-z]{3,}\\s+\\d{1,2},?\\s+(?:\\d{4}|\\d{2}))";
const DATE_RX = new RegExp(`(${DATE_SRC})`, "i");
const AMT_RX = /(?:INR|Rs\.?|₹|`)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;

function toIsoDate(raw: string | undefined | null, fallbackYear?: number | null): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/\s+/g, " ");
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})$/);
  if (m) { const yr = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${yr}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{2}|\d{4})$/);
  if (m) { const mon = MONTHS[m[2].slice(0, 3).toLowerCase()]; const yr = m[3].length === 2 ? `20${m[3]}` : m[3]; if (mon) return `${yr}-${mon}-${m[1].padStart(2, "0")}`; }
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})$/);
  if (m && fallbackYear) { const mon = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mon) return `${fallbackYear}-${mon}-${m[1].padStart(2, "0")}`; }
  m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{2}|\d{4})$/);
  if (m) { const mon = MONTHS[m[1].slice(0, 3).toLowerCase()]; const yr = m[3].length === 2 ? `20${m[3]}` : m[3]; if (mon) return `${yr}-${mon}-${m[2].padStart(2, "0")}`; }
  return null;
}

function toAmount(raw: string | undefined | null): number | null { const m = raw?.match(AMT_RX); if (!m) return null; const n = Number(m[1].replace(/,/g, "")); return Number.isFinite(n) ? n : null; }
function normalizedLines(text: string): string[] { return text.replace(/\r/g, "\n").replace(/\u00a0/g, " ").split(/\n+/).map((line) => line.replace(/\s{2,}/g, " ").trim()).filter(Boolean); }
function allAmounts(raw: string): number[] { const out: number[] = []; for (const m of raw.matchAll(/(?:INR|Rs\.?|₹|`)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi)) { const n = Number(m[1].replace(/,/g, "")); if (Number.isFinite(n) && n > 0) out.push(n); } return out; }
function cardLast4(text: string): string | null {
  return text.match(/(?:card\s*(?:number|no\.?|ending)?|account\s*(?:number|no\.?)?)\s*[:#\-]?\s*(?:\d{2,6})?[xX*\s-]{4,}(\d{4})\b/i)?.[1]
    ?? text.match(/\b(?:ending|ends)\s+(?:in|with)\s+(\d{4})\b/i)?.[1]
    ?? null;
}

const VALUE_CURRENCY = /\b(?:INR|Rs\.?)\b|₹|`/i;
const COMPETING_LABEL = /\b(previous\s+balance|credit\s+limit|available|cash\s+limit|points?|purchases?|payments?|credits?|cash\s+advances?|interest|fees?|charges?|debits?)\b/i;

function dateNearLabel(lines: string[], label: RegExp, fallbackYear?: number | null): string | null {
  const idx = lines.findIndex((line) => label.test(line));
  if (idx < 0) return null;
  for (let i = idx; i <= Math.min(lines.length - 1, idx + 8); i++) for (const m of lines[i].matchAll(new RegExp(DATE_SRC, "gi"))) { const iso = toIsoDate(m[0], fallbackYear); if (iso) return iso; }
  return null;
}

function amountNearLabel(lines: string[], label: RegExp): number | null {
  const idx = lines.findIndex((line) => label.test(line));
  if (idx < 0) return null;
  const m = lines[idx].match(label);
  const inline = lines[idx].slice((m?.index ?? 0) + (m?.[0]?.length ?? 0));
  const inlineAmounts = allAmounts(inline);
  if (inlineAmounts.length && VALUE_CURRENCY.test(inline) && !COMPETING_LABEL.test(inline)) return inlineAmounts[0];
  for (let i = idx + 1; i <= Math.min(lines.length - 1, idx + 7); i++) {
    const line = lines[i];
    if (/^(=|\+|-)+$/.test(line.replace(/\s+/g, ""))) continue;
    if (/\b(statement\s+no|ckyc|credit\s+limit|available\s+credit|available\s+cash|cash\s+limit|pay\s+now|card\s+number)\b/i.test(line)) continue;
    const amounts = allAmounts(line);
    if (amounts.length && (VALUE_CURRENCY.test(line) || /^\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?\s*(?:CR|DR|C|D)?\s*$/i.test(line))) return amounts[0];
  }
  return inlineAmounts.find((n) => n > 0) ?? null;
}

const LINE_DATE_SRC = "(?:\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}|\\d{1,2}\\s+[A-Za-z]{3,}(?:\\s+\\d{2,4})?)";
const LINE_ROW = /^\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,}(?:\s+\d{2,4})?)\s+(.+)$/i;
const LINE_AMT = /((?:[0-9]{1,3}(?:,[0-9]{2,3})+|[0-9]+)(?:\.[0-9]{2})?)\s*(Cr|CR|Dr|DR|Debit|Credit|C|D|\-|\+)?\s*$/i;
const TYPED_AMT = /((?:[0-9]{1,3}(?:,[0-9]{2,3})+|[0-9]+)(?:\.[0-9]{2})?)\s*(Cr|CR|Dr|DR|Debit|Credit|C|D)\b/gi;

export function extractLines(text: string, fallbackYear?: number | null): StatementLine[] {
  const lines: StatementLine[] = [];
  const rawLines = text.replace(/\r/g, "\n").split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const chunks = rawLines.flatMap((ln) => ln.replace(new RegExp(`\\s+(?=${LINE_DATE_SRC}\\s+)`, "g"), "\n").split(/\n+/)).map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const addFromChunk = (chunk: string) => {
    const dm = chunk.match(LINE_ROW); if (!dm) return;
    const date = toIsoDate(dm[1], fallbackYear); if (!date) return;
    const rest = dm[2]; const typed = Array.from(rest.matchAll(TYPED_AMT)); const t = typed.at(-1);
    let am = t ? Object.assign([t[0], t[1], t[2]], { index: t.index ?? 0, input: rest }) as RegExpMatchArray : rest.match(LINE_AMT) as RegExpMatchArray | null;
    if (!am) return; const amount = Number(am[1].replace(/,/g, "")); if (!Number.isFinite(amount) || amount <= 0) return;
    const desc = rest.slice(0, am.index ?? rest.length).trim(); if (!desc || desc.length < 2) return;
    const d = String(am[2] ?? "").toLowerCase();
    const txn_type: "debit" | "credit" = d === "cr" || d === "credit" || d === "c" || d === "+" || (!d && /\b(refund|reversal|received|credit|salary|interest paid)\b/i.test(desc)) ? "credit" : "debit";
    const key = `${date}|${amount}|${desc.slice(0, 40).toLowerCase()}`; if (seen.has(key)) return;
    seen.add(key); lines.push({ date, description: desc, amount, txn_type });
  };
  for (const chunk of chunks) addFromChunk(chunk);
  if (lines.length === 0) for (const line of rawLines) addFromChunk(line);
  return lines;
}

export function genericExtract(text: string, fallbackYear?: number | null): ParsedStatementFields {
  const lines = normalizedLines(text);
  const periodMatch = text.match(new RegExp(`statement\\s*period\\s*[:\\s]*${DATE_RX.source}\\s*(?:to|-|–)\\s*${DATE_RX.source}`, "i"));
  const dueDateMatch = text.match(new RegExp(`payment\\s*due\\s*date\\s*[:\\s]*${DATE_RX.source}`, "i"));
  const statementDateMatch = text.match(new RegExp(`statement\\s*date\\s*[:\\s]*${DATE_RX.source}`, "i"));
  const totalDueMatch = text.match(/total\s*(?:amount\s*)?dues?\s*[:\s]*(?:INR|Rs\.?|₹|`)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const minDueMatch = text.match(/(?:minimum\s*(?:amount\s*)?due|min\.?\s*due)\s*[:\s]*(?:INR|Rs\.?|₹|`)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const closingBalMatch = text.match(/closing\s*balance\s*[:\s]*(?:INR|Rs\.?|₹|`)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const creditLimitMatch = text.match(/credit\s*limit\s*[:\s]*(?:INR|Rs\.?|₹|`)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const splitStatementDate = dateNearLabel(lines, /\b(statement\s*date|date\s*of\s*statement)\b/i, fallbackYear);
  const splitDueDate = dateNearLabel(lines, /\b(payment\s*due\s*date|due\s*date|payment\s*due\s*on)\b/i, fallbackYear);
  const splitTotalDue = amountNearLabel(lines, /\b(total\s*(?:amount\s*)?dues?|total\s*payment\s*due|amount\s*payable)\b/i);
  const splitMinDue = amountNearLabel(lines, /\b(minimum\s*(?:amount\s*)?due|min\.?\s*(?:amount\s*)?due|minimum\s+payment\s+due)\b/i);
  const splitClosing = amountNearLabel(lines, /\b(closing\s*balance|total\s*outstanding|current\s*balance)\b/i);
  return {
    period_start: periodMatch ? toIsoDate(periodMatch[1], fallbackYear) : null,
    period_end: periodMatch ? toIsoDate(periodMatch[2], fallbackYear) : null,
    statement_date: (statementDateMatch ? toIsoDate(statementDateMatch[1], fallbackYear) : null) ?? splitStatementDate,
    due_date: (dueDateMatch ? toIsoDate(dueDateMatch[1], fallbackYear) : null) ?? splitDueDate,
    total_due: (totalDueMatch ? toAmount(totalDueMatch[0]) : null) ?? splitTotalDue,
    min_due: (minDueMatch ? toAmount(minDueMatch[0]) : null) ?? splitMinDue,
    closing_balance: (closingBalMatch ? toAmount(closingBalMatch[0]) : null) ?? splitClosing,
    credit_limit: creditLimitMatch ? toAmount(creditLimitMatch[0]) : null,
    card_last4: cardLast4(text),
    lines: extractLines(text, fallbackYear),
  };
}

export function reportMissing(fields: ParsedStatementFields, required: (keyof ParsedStatementFields)[]): string[] {
  const missing: string[] = [];
  for (const k of required) { const v = fields[k]; if (v === null || (Array.isArray(v) && v.length === 0)) missing.push(String(k)); }
  return missing;
}

export const genericParser = (text: string, ctx: ParserContext): ParserResult => {
  const fields = genericExtract(text, ctx.statement_year ?? null);
  const required: (keyof ParsedStatementFields)[] = ctx.statement_type === "card" ? ["statement_date", "due_date", "total_due"] : ["period_start", "period_end", "statement_date"];
  const missing_fields = reportMissing(fields, required);
  return { ok: missing_fields.length === 0, fields, parser_source: "generic", confidence: missing_fields.length === 0 ? 0.65 : 0.35, missing_fields,
    matched_labels: { statement_date: fields.statement_date ? "Statement Date" : undefined, due_date: fields.due_date ? "Payment Due Date" : undefined, total_due: fields.total_due ? "Total Amount Due" : undefined, min_due: fields.min_due ? "Minimum Amount Due" : undefined, closing_balance: fields.closing_balance ? "Closing Balance" : undefined, period: fields.period_start && fields.period_end ? "Statement Period" : undefined } };
};
