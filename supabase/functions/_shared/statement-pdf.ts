// Bank/credit-card statement PDF parsing: text extraction (via pdfjs-dist,
// handling password-protected PDFs) + bank-specific regex extraction of
// period, due date, totals, and itemized transaction lines.
//
// Regex bodies here are first-pass, tuned against known Indian statement
// boilerplate phrasing (not against real sample PDFs, which weren't
// available at implementation time) — expect iteration once real statements
// flow through. Every parser is defensive: a miss just leaves a field null,
// it never throws.

// deno-lint-ignore no-explicit-any
import { getDocument } from "npm:pdfjs-dist@4/legacy/build/pdf.mjs";

export interface StatementLine {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number;
  txn_type: "debit" | "credit";
}

export interface PdfParseResult {
  ok: boolean;
  period_start: string | null;
  period_end: string | null;
  statement_date: string | null;
  due_date: string | null;
  total_due: number | null;
  closing_balance: number | null;
  lines: StatementLine[];
  error?: string;
}

function emptyResult(overrides: Partial<PdfParseResult> = {}): PdfParseResult {
  return {
    ok: true,
    period_start: null,
    period_end: null,
    statement_date: null,
    due_date: null,
    total_due: null,
    closing_balance: null,
    lines: [],
    ...overrides,
  };
}

const MAX_PAGES = 100;
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — matches upload cap

export async function parseStatementPdf(bytes: Uint8Array, password?: string): Promise<PdfParseResult> {
  try {
    if (bytes.byteLength > MAX_BYTES) {
      return { ok: false, period_start: null, period_end: null, statement_date: null, due_date: null,
        total_due: null, closing_balance: null, lines: [], error: "file_too_large" };
    }
    const doc = await getDocument({ data: bytes, password, disableWorker: true } as any).promise;
    if (doc.numPages > MAX_PAGES) {
      return { ok: false, period_start: null, period_end: null, statement_date: null, due_date: null,
        total_due: null, closing_balance: null, lines: [], error: "too_many_pages" };
    }
    let fullText = "";
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // deno-lint-ignore no-explicit-any
      fullText += content.items.map((it: any) => it.str).join(" ") + "\n";
    }
    return parseStatementText(fullText);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isMissingPassword = /no password given|PasswordException.*NEED_PASSWORD/i.test(msg);
    const isWrongPassword = /incorrect password|PasswordException.*INCORRECT_PASSWORD/i.test(msg) || (/password/i.test(msg) && !isMissingPassword);
    return {
      ok: false,
      period_start: null, period_end: null, statement_date: null, due_date: null,
      total_due: null, closing_balance: null, lines: [],
      error: isMissingPassword ? "password_required" : isWrongPassword ? "wrong_password" : msg,
    };
  }
}

// ---- Date parsing: DD/MM/YYYY, DD-MM-YYYY, "01 Jun 2026" → YYYY-MM-DD ----
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

// ---- Amount parsing: "Rs. 12,345.67", "₹12,345", "INR 12345.00" ----------
const AMOUNT_RX = /(?:INR|Rs\.?|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;

function toAmount(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = raw.match(AMOUNT_RX);
  if (!m) return null;
  return Number(m[1].replace(/,/g, ""));
}

// ---- Generic fallback: works across banks at lower confidence ------------
function genericFallback(text: string): Partial<PdfParseResult> {
  const periodMatch = text.match(
    /statement\s*period\s*[:\s]*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4}|[0-9]{1,2}[\s-]+[A-Za-z]{3,}[\s-]+[0-9]{4})\s*(?:to|-|–)\s*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4}|[0-9]{1,2}[\s-]+[A-Za-z]{3,}[\s-]+[0-9]{4})/i,
  );
  const dueDateMatch = text.match(
    /payment\s*due\s*date\s*[:\s]*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4}|[0-9]{1,2}[\s-]+[A-Za-z]{3,}[\s-]+[0-9]{4})/i,
  );
  const statementDateMatch = text.match(
    /statement\s*date\s*[:\s]*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4}|[0-9]{1,2}[\s-]+[A-Za-z]{3,}[\s-]+[0-9]{4})/i,
  );
  const totalDueMatch = text.match(/total\s*(?:amount\s*)?due\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const closingBalMatch = text.match(/closing\s*balance\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);

  return {
    period_start: periodMatch ? toIsoDate(periodMatch[1]) : null,
    period_end: periodMatch ? toIsoDate(periodMatch[2]) : null,
    due_date: dueDateMatch ? toIsoDate(dueDateMatch[1]) : null,
    statement_date: statementDateMatch ? toIsoDate(statementDateMatch[1]) : null,
    total_due: totalDueMatch ? toAmount(totalDueMatch[0]) : null,
    closing_balance: closingBalMatch ? toAmount(closingBalMatch[0]) : null,
    lines: extractLines(text),
  };
}

// ---- Generic line-item extraction ----------------------------------------
// Indian bank/card statement rows almost universally follow:
//   <date>  <description...>  <amount>  [Dr|Cr|CR|DR|- |+]
// with variable whitespace. We split the extracted page text into "sentence"
// candidates on the date anchor, then pull description + amount + direction.
// Anything the regex doesn't confidently match is dropped — false positives
// here poison reconciliation, so we bias toward precision over recall.
const LINE_DATE = /(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,}\s+\d{2,4})/;
const LINE_AMT  = /([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{2})?)\s*(Cr|CR|Dr|DR|\-|\+)?\s*$/;

function normLineDate(raw: string): string | null {
  // Handle 2-digit years by pinning to 2000+.
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
  // Split on newlines *and* on inline date anchors so multi-txn-per-line
  // rows (common when pdfjs collapses table cells to one string) still work.
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
    // Direction: explicit Cr/Dr wins; then trailing +/-, else default debit.
    let txn_type: "debit" | "credit" = "debit";
    if (am[2]) {
      const d = am[2].toLowerCase();
      if (d === "cr" || d === "+") txn_type = "credit";
      else txn_type = "debit";
    } else if (/\b(refund|reversal|received|credit|salary|interest paid)\b/i.test(desc)) {
      txn_type = "credit";
    }
    // Dedup within a single statement (same date+amount+desc-prefix).
    const key = `${date}|${amount}|${desc.slice(0, 40).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({ date, description: desc, amount, txn_type });
  }
  return lines;
}

// ---- Per-bank parsers ------------------------------------------------------
// Each extends the generic fallback with the same field extraction — banks
// share broadly similar "Statement Period" / "Total Amount Due" phrasing, so
// the fallback regex already covers most cases. These entries exist as the
// place to add bank-specific itemized-transaction-line parsing once real
// sample statements are available to tune the line-item regex against.

function parseAxisStatement(text: string): Partial<PdfParseResult> {
  return genericFallback(text);
}
function parseIciciStatement(text: string): Partial<PdfParseResult> {
  return genericFallback(text);
}
function parseHdfcStatement(text: string): Partial<PdfParseResult> {
  return genericFallback(text);
}

const BANK_PARSERS: Record<string, (text: string) => Partial<PdfParseResult>> = {
  axis: parseAxisStatement,
  icici: parseIciciStatement,
  hdfc: parseHdfcStatement,
};

function detectBank(text: string): string | null {
  if (/axis\s*bank/i.test(text)) return "axis";
  if (/icici\s*bank/i.test(text)) return "icici";
  if (/hdfc\s*bank/i.test(text)) return "hdfc";
  return null;
}

export function parseStatementText(text: string): PdfParseResult {
  const bank = detectBank(text);
  const parser = bank ? BANK_PARSERS[bank] : null;
  const partial = parser ? parser(text) : genericFallback(text);
  return emptyResult(partial);
}
