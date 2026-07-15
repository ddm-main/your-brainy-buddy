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
  min_due: number | null;
  closing_balance: number | null;
  lines: StatementLine[];
  parser_source?: string | null;
  parse_confidence?: number | null;
  extracted_text?: string | null;
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
    min_due: null,
    closing_balance: null,
    lines: [],
    parser_source: "generic",
    parse_confidence: 0.35,
    ...overrides,
  };
}

const MAX_PAGES = 100;
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — matches upload cap

export interface PdfTextResult {
  ok: boolean;
  text: string;
  error?: string;
}

// Raw text extraction, factored out so non-bank-statement PDFs (e.g. Groww's
// mutual fund transaction statement, see finance-import-groww) can reuse the
// same pdfjs plumbing without going through the bank-specific regex parsing
// below.
export async function extractPdfText(bytes: Uint8Array, password?: string): Promise<PdfTextResult> {
  try {
    if (bytes.byteLength > MAX_BYTES) return { ok: false, text: "", error: "file_too_large" };
    const doc = await getDocument({ data: bytes, password, disableWorker: true } as any).promise;
    if (doc.numPages > MAX_PAGES) return { ok: false, text: "", error: "too_many_pages" };
    let fullText = "";
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // Preserve statement-table structure: pdfjs emits positioned glyph runs,
      // not reading-order text. Group runs by Y, sort each line by X, and keep
      // wider X gaps as column separators so downstream row regexes see the
      // same table shape that appears visually in the PDF.
      // deno-lint-ignore no-explicit-any
      const lineMap = new Map<number, Array<{ str: string; x: number; width: number }>>();
      const yTolerance = 3;
      for (const item of content.items as any[]) {
        const str = String(item.str ?? "").trim();
        if (!str) continue;
        const transform = item.transform ?? [];
        const x = Number(transform[4] ?? 0);
        const y = Math.round(Number(transform[5] ?? 0) / yTolerance) * yTolerance;
        const width = Number(item.width ?? str.length * 5);
        if (!lineMap.has(y)) lineMap.set(y, []);
        lineMap.get(y)!.push({ str, x, width });
      }
      const pageText = Array.from(lineMap.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([, items]) => {
          items.sort((a, b) => a.x - b.x);
          let line = "";
          for (let j = 0; j < items.length; j++) {
            const cur = items[j];
            if (j > 0) {
              const prev = items[j - 1];
              const gap = cur.x - (prev.x + prev.width);
              line += gap > 18 ? "  " : " ";
            }
            line += cur.str;
          }
          return line.replace(/\s{3,}/g, "  ").trim();
        })
        .filter(Boolean)
        .join("\n");
      fullText += pageText + "\n";
    }
    return { ok: true, text: fullText };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isMissingPassword = /no password given|PasswordException.*NEED_PASSWORD/i.test(msg);
    const isWrongPassword = /incorrect password|PasswordException.*INCORRECT_PASSWORD/i.test(msg) || (/password/i.test(msg) && !isMissingPassword);
    return { ok: false, text: "", error: isMissingPassword ? "password_required" : isWrongPassword ? "wrong_password" : msg };
  }
}

export async function parseStatementPdf(
  bytes: Uint8Array,
  password?: string,
  hint?: { bank_slug?: string | null; card_family?: string | null; statement_type?: "card" | "account" | "loan" | null; subject?: string | null; sender?: string | null },
): Promise<PdfParseResult> {
  const extracted = await extractPdfText(bytes, password);
  if (!extracted.ok) {
    return {
      ok: false,
      period_start: null, period_end: null, statement_date: null, due_date: null,
      total_due: null, min_due: null, closing_balance: null, lines: [],
      error: extracted.error,
    };
  }
  return { ...parseStatementText(extracted.text, hint), extracted_text: extracted.text };
}

// Try a list of candidate passwords in order (plus a no-password attempt if
// the PDF might be unprotected). Returns the parse result of the first
// candidate that successfully decrypts + parses, and the winning password so
// callers can persist it. If every candidate fails on password specifically,
// the last wrong_password result is returned. If a non-password error occurs
// (corrupt PDF, too many pages), it's returned immediately.
export interface PasswordRotationResult {
  result: PdfParseResult;
  winning_password: string | null; // null = unprotected PDF succeeded
  tried: number;
}
export async function parseStatementPdfWithPasswords(
  bytes: Uint8Array,
  candidates: (string | null | undefined)[],
  hint?: { bank_slug?: string | null; card_family?: string | null; statement_type?: "card" | "account" | "loan" | null; subject?: string | null; sender?: string | null },
): Promise<PasswordRotationResult> {
  // Dedup, preserve order; try explicit/saved/user candidates first, then a
  // no-password attempt. This avoids treating protected statements as
  // unresolved before known bank/card passwords are exhausted.
  const seen = new Set<string>();
  const ordered: (string | null)[] = [];
  const pushCandidate = (v: string | null | undefined) => {
    const key = v == null ? "__none__" : v;
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(v ?? null);
  };
  for (const c of candidates) if (c) pushCandidate(c);
  pushCandidate(null);

  let lastFailure: PdfParseResult | null = null;
  let tried = 0;
  for (const pwd of ordered) {
    tried++;
    const r = await parseStatementPdf(bytes, pwd ?? undefined, hint);
    if (r.ok) {
      return { result: r, winning_password: pwd ?? null, tried };
    }
    // Non-password error → stop trying.
    if (r.error && r.error !== "wrong_password" && r.error !== "password_required") {
      return { result: r, winning_password: null, tried };
    }
    lastFailure = r;
  }
  return {
    result: lastFailure ?? { ok: false, period_start: null, period_end: null, statement_date: null, due_date: null, total_due: null, min_due: null, closing_balance: null, lines: [], error: "wrong_or_missing_password" },
    winning_password: null,
    tried,
  };
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
const AMOUNT_RX = /(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;

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
    parser_source: "generic",
    parse_confidence: 0.35,
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

// ---- Per-bank parsing (delegated to statement-parsers registry) ---------
import { dispatchStatementParser } from "./statement-parsers/index.ts";
import { parseSubjectPeriod } from "./subject-period.ts";


export function parseStatementText(text: string, hint?: { bank_slug?: string | null; card_family?: string | null; statement_type?: "card" | "account" | "loan" | null; subject?: string | null; sender?: string | null }): PdfParseResult {
  const yearMatch = `${hint?.subject ?? ""} ${text.slice(0, 1500)}`.match(/\b(20\d{2})\b/);
  const r = dispatchStatementParser(text, {
    bank_slug: hint?.bank_slug ?? null,
    card_family: hint?.card_family ?? null,
    statement_type: hint?.statement_type ?? null,
    subject: hint?.subject ?? null,
    sender: hint?.sender ?? null,
    statement_year: yearMatch ? Number(yearMatch[1]) : null,
  });

  // Subject-line rescue: fill only missing period/statement_date fields.
  const subjectHit = parseSubjectPeriod(hint?.subject ?? null);
  const period_start = r.fields.period_start ?? subjectHit.period_start;
  const period_end = r.fields.period_end ?? subjectHit.period_end;
  let statement_date = r.fields.statement_date ?? subjectHit.statement_date;
  // Account statements are dated at period end; default when still missing.
  if (!statement_date && period_end && hint?.statement_type !== "card") {
    statement_date = period_end;
  }

  const enriched = {
    ...r.fields,
    period_start,
    period_end,
    statement_date,
  };

  const required: Array<string> = hint?.statement_type === "card"
    ? ["statement_date", "due_date", "total_due"]
    : ["statement_date"];
  const missing = new Set(
    r.missing_fields.filter((k) => {
      const v = (enriched as any)[k];
      return v === null || (Array.isArray(v) && v.length === 0);
    }),
  );
  for (const key of required) {
    const value = (enriched as any)[key];
    if (value === null || (Array.isArray(value) && value.length === 0)) missing.add(key);
  }
  const ok = required.every((key) => {
    const value = (enriched as any)[key];
    return !(value === null || (Array.isArray(value) && value.length === 0));
  });
  return emptyResult({
    ok,
    period_start: enriched.period_start,
    period_end: enriched.period_end,
    statement_date: enriched.statement_date,
    due_date: enriched.due_date,
    total_due: enriched.total_due,
    min_due: enriched.min_due,
    closing_balance: enriched.closing_balance,
    lines: enriched.lines,
    parser_source: r.parser_source,
    parse_confidence: r.confidence,
    error: ok ? undefined : `missing_fields:${Array.from(missing).join(",")}`,
  });
}


