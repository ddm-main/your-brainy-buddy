// HDFC Bank credit card statement parser.
//
// HDFC Millennia/Regalia/Infinia statements use a two-row summary layout
// where pdftotext splits values across multiple lines:
//   Row 1 (5 amounts on ONE operator-separated line):
//     C-,196.33  _  C0.00  +  C7,655.26  +  C0.00  =  C7,459.00
//     → [previous_dues, payments, purchases, finance_charges, TOTAL_DUE]
//   Row 2 (labels stacked, values split across 2 lines):
//     TOTAL CREDIT LIMIT (Including Cash)
//     AVAILABLE CREDIT LIMIT   AVAILABLE CASH LIMIT   MINIMUM DUE   DUE DATE
//     ...
//     C380.00   18 Jul, 2026            ← min + due date (right side)
//     C2,25,000  C2,17,541  C90,000      ← total + avail credit + avail cash
// The rupee glyph often renders as a bare `C` after pdftotext (see
// shared.CURRENCY_PREFIX). Statement Date / Billing Period / Credit Card
// No. live in a right-side key/value block with 2+ space separators.

import type { ParserContext, ParserResult, StatementLine } from "./types.ts";
import { genericExtract, reportMissing } from "./generic.ts";
import { inferYear, splitCols, toAmount, toIsoDate } from "./shared.ts";

function labelValue(text: string, label: RegExp): string | null {
  // Right-column format: `Statement Date       28 Jun, 2026` — label,
  // 2+ spaces, value on the same line.
  const lines = text.split(/\n+/);
  for (const line of lines) {
    const m = line.match(new RegExp(`${label.source}\\s{2,}(.+?)\\s*$`, "i"));
    if (m) return m[1].trim();
    const m2 = line.match(new RegExp(`^\\s*(?:.+?\\s{2,})?${label.source}\\s+(.+?)\\s*$`, "i"));
    if (m2 && m2[1] && !new RegExp(label.source, "i").test(m2[1])) return m2[1].trim();
  }
  return null;
}

function cardLast4(text: string): string | null {
  return text.match(/\bCredit\s*Card\s*No\.?\s+\d{2,6}[X*x\s]+(\d{4})\b/i)?.[1]
    ?? text.match(/\bCard\s*No\.?\s*[:\s]+\d{2,6}[X*x\s]+(\d{4})\b/i)?.[1]
    ?? text.match(/\b\d{6}[X*x]{4,}(\d{4})\b/i)?.[1]
    ?? null;
}

function parseBillingPeriod(raw: string | null, year: number | null): { start: string | null; end: string | null } {
  if (!raw) return { start: null, end: null };
  const m = raw.match(/(\d{1,2}\s+[A-Za-z]{3,}(?:,?\s+\d{2,4})?)\s*(?:-|to|–)\s*(\d{1,2}\s+[A-Za-z]{3,}(?:,?\s+\d{2,4})?)/i);
  if (!m) return { start: null, end: null };
  return { start: toIsoDate(m[1], year), end: toIsoDate(m[2], year) };
}

// Row-1: find the operator-separated line whose LAST currency amount sits
// after an `=` — that value is the total amount due.
// Real HDFC pdfjs output (Millennia):
//   `C -,196.33  C 0.00  +  C 7,655.26  +  C 0.00  = C 7,459.00`
// The `-,196.33` (previous-dues credit) may or may not attach cleanly to the
// currency prefix, and the `_` separator can wrap onto its own line, so we
// intentionally do NOT require both `_` AND `=`.
function extractRow1(text: string): { previous: number | null; payments: number | null; purchases: number | null; finance: number | null; total_due: number | null } {
  const amountAll = /(?:C|₹|`|Rs\.?)\s*(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi;
  const lines = text.split(/\n+/);
  let bestLine: string | null = null;
  let bestIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/=/.test(l)) continue;
    const hits = l.match(amountAll) ?? [];
    if (hits.length < 3) continue;
    // "Past Dues / OVER LIMIT / CURRENT DUES" bucket row also has amounts
    // but no `=` — the `=/hits>=3` combo is unique to the row-1 summary.
    if (/OVER\s*LIMIT|3\s*MONTHS\b|Past\s*Dues/i.test(l)) continue;
    bestLine = l; bestIdx = i; break;
  }
  if (!bestLine) return { previous: null, payments: null, purchases: null, finance: null, total_due: null };
  const amounts: number[] = [];
  for (const m of bestLine.matchAll(amountAll)) {
    const n = toAmount(m[1]);
    if (n !== null) amounts.push(n);
  }
  // Total = the amount following `=`. Find it explicitly rather than
  // trusting position, since previous-dues can be split off to its own line.
  const eqIdx = bestLine.lastIndexOf("=");
  const tail = eqIdx >= 0 ? bestLine.slice(eqIdx) : bestLine;
  const tailMatch = tail.match(/(?:C|₹|`|Rs\.?)\s*(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const total_due = tailMatch ? toAmount(tailMatch[1]) : (amounts.length ? amounts[amounts.length - 1] : null);
  // Try to recover previous-dues from earlier line if 4 amounts on the row.
  if (amounts.length === 4 && bestIdx > 0) {
    for (let i = bestIdx - 1; i >= Math.max(0, bestIdx - 3); i--) {
      if (!lines[i].trim()) continue;
      const prev = lines[i].match(/(?:C|₹|`|Rs\.?)\s*(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
      if (prev) { amounts.unshift(toAmount(prev[1]) ?? 0); break; }
      break;
    }
  }
  return {
    previous: amounts.length >= 5 ? amounts[0] : null,
    payments: amounts.length >= 5 ? amounts[1] : (amounts.length >= 4 ? amounts[0] : null),
    purchases: amounts.length >= 5 ? amounts[2] : (amounts.length >= 4 ? amounts[1] : null),
    finance: amounts.length >= 5 ? amounts[3] : (amounts.length >= 4 ? amounts[2] : null),
    total_due,
  };
}

function extractTotalDueNearSummary(text: string): number | null {
  const lines = text.split(/\n+/);
  const amountAll = /(?:C|₹|`|Rs\.?)\s*(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi;
  for (let i = 0; i < lines.length; i++) {
    if (!/\bTOTAL\s+AMOUNT\s+DUE\b/i.test(lines[i])) continue;
    for (let j = i; j <= Math.min(lines.length - 1, i + 8); j++) {
      const line = lines[j];
      const eqIdx = line.lastIndexOf("=");
      if (eqIdx >= 0) {
        const m = line.slice(eqIdx).match(/(?:C|₹|`|Rs\.?)\s*(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
        const v = toAmount(m?.[1] ?? null);
        if (v !== null) return v;
      }
      const vals = Array.from(line.matchAll(amountAll))
        .map((m) => toAmount(m[1]))
        .filter((v): v is number => v !== null);
      if (vals.length >= 4) return vals[vals.length - 1];
    }
  }
  return null;
}

// Row-2 anchors: find each label individually and scan a small window
// (same line + following 4 non-empty lines) for the appropriate value.
function anchoredAmount(text: string, label: RegExp, opts: { max?: number; min?: number } = {}): number | null {
  const lines = text.split(/\n+/);
  for (let i = 0; i < lines.length; i++) {
    if (!label.test(lines[i])) continue;
    // Same line, to the right of the label.
    const inline = lines[i].replace(label, "");
    const inlineAmt = inline.match(/(?:C|₹|`|Rs\.?)\s*(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
    if (inlineAmt) {
      const v = toAmount(inlineAmt[1]);
      if (v !== null && (opts.max == null || v <= opts.max) && (opts.min == null || v >= opts.min)) return v;
    }
    // Following lines. HDFC may print min-due/due-date first and the credit
    // limits one row lower, so keep a wider window and filter by min/max.
    let taken = 0;
    for (let j = i + 1; j < lines.length && taken < 8; j++) {
      if (!lines[j].trim()) continue;
      taken++;
      // Skip lines that are themselves the OTHER labels' header text (all-caps only).
      if (/^[A-Z\s\(\)\/]+$/.test(lines[j]) && !/[0-9]/.test(lines[j])) continue;
      for (const m of lines[j].matchAll(/(?:C|₹|`|Rs\.?)\s*(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi)) {
        const v = toAmount(m[1]);
        if (v == null) continue;
        if (opts.max != null && v > opts.max) continue;
        if (opts.min != null && v < opts.min) continue;
        return v;
      }
    }
    return null;
  }
  return null;
}

function anchoredDate(text: string, label: RegExp, year: number | null): string | null {
  const lines = text.split(/\n+/);
  const dateRx = /(\d{1,2}\s+[A-Za-z]{3,},?\s+\d{2,4}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/;
  for (let i = 0; i < lines.length; i++) {
    if (!label.test(lines[i])) continue;
    const inline = lines[i].replace(label, "").match(dateRx);
    if (inline) return toIsoDate(inline[1], year);
    let taken = 0;
    for (let j = i + 1; j < lines.length && taken < 4; j++) {
      if (!lines[j].trim()) continue;
      taken++;
      const m = lines[j].match(dateRx);
      if (m) return toIsoDate(m[1], year);
    }
    return null;
  }
  return null;
}

function extractHdfcLines(text: string, year: number | null): StatementLine[] {
  const out: StatementLine[] = [];
  const seen = new Set<string>();
  // Fold standalone `l` / `●` / `•` marker lines (HDFC's payment-indicator
  // glyph, sometimes emitted on its own line by pdfjs) into the previous
  // txn line so rowRx can consume them cleanly.
  const raw = text.split(/\n+/).map((l) => l.trim());
  const folded: string[] = [];
  for (const line of raw) {
    if (!line) continue;
    if (/^[l●•]\s*$/i.test(line) && folded.length) {
      folded[folded.length - 1] = `${folded[folded.length - 1]} ${line}`;
    } else {
      folded.push(line);
    }
  }
  const lines = folded;
  const rowRx = /^(\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s*\|?\s*\d{1,2}:\d{2})?\s+(?:(EMI)\s+)?(.+?)\s+(?:C|₹|Rs\.?|INR|`)\s*(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:l|●|\u2022)?\s*(Cr|CR|Credit)?\s*$/i;
  const cardholderAnchor = /\bCKYC\s*ID\b|\bDEEPAK\s+DONGARE\s*\[/i;
  for (const line of lines) {
    if (cardholderAnchor.test(line)) continue;
    const m = line.match(rowRx);
    if (!m) continue;
    const date = toIsoDate(m[1], year);
    const amount = toAmount(m[4]);
    if (!date || amount == null) continue;
    const description = m[3].trim();
    if (!description) continue;
    const txn_type = m[5] || /\bREFUND|CASHBACK|REWARD|CREDIT\b/i.test(description) ? "credit" : "debit";
    const key = `${date}|${amount}|${description.slice(0, 40).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, description, amount, txn_type });
  }
  return out;
}

export const hdfcCardParser = (text: string, ctx: ParserContext): ParserResult => {
  const year = inferYear(text, ctx);
  const base = genericExtract(text, year);

  const row1 = extractRow1(text);
  // Minimum due is small (never above 5 lakh for a personal card); this
  // ceiling stops us from grabbing the AVAILABLE CASH LIMIT amount when
  // pdftotext orders it before the MIN DUE value.
  const minDue = anchoredAmount(text, /\bMINIMUM\s*DUE\b(?!\s*S)/i, { max: 500000 });
  // Credit limits are always ≥ ₹10k for personal cards; this floor skips
  // MIN DUE (~C380) that pdftotext may emit above the limits row.
  const creditLimit = anchoredAmount(text, /\bTOTAL\s*CREDIT\s*LIMIT\b/i, { min: 10000 })
    ?? anchoredAmount(text, /\bCREDIT\s*LIMIT\b(?!\s*S)/i, { min: 10000 });
  const dueDate = anchoredDate(text, /\bDUE\s*DATE\b/i, year);

  const stmtDateRaw = labelValue(text, /Statement\s*Date/);
  const billingRaw = labelValue(text, /Billing\s*Period/);
  const stmtDate = (stmtDateRaw ? toIsoDate(stmtDateRaw, year) : null)
    ?? anchoredDate(text, /\bStatement\s*Date\b/i, year);
  const period = parseBillingPeriod(billingRaw, year);
  const totalDue = row1.total_due ?? extractTotalDueNearSummary(text);

  const last4 = cardLast4(text);
  const hdfcLines = extractHdfcLines(text, year);

  const fields = {
    ...base,
    statement_date: stmtDate ?? base.statement_date,
    due_date: dueDate ?? base.due_date,
    total_due: totalDue ?? base.total_due,
    min_due: minDue ?? base.min_due,
    credit_limit: creditLimit ?? base.credit_limit,
    period_start: period.start ?? base.period_start,
    period_end: period.end ?? base.period_end,
    closing_balance: base.closing_balance ?? totalDue,
    card_last4: last4 ?? base.card_last4,
    lines: hdfcLines.length ? hdfcLines : base.lines,
  };
  const missing = reportMissing(fields, ["statement_date", "due_date", "total_due"]);
  return {
    ok: missing.length === 0,
    fields,
    parser_source: "hdfc-card",
    confidence: missing.length === 0 ? 0.9 : 0.55,
    missing_fields: missing,
    matched_labels: {
      statement_date: stmtDate ? "Statement Date" : undefined,
      due_date: dueDate ? "DUE DATE" : undefined,
      total_due: totalDue != null ? "TOTAL AMOUNT DUE" : undefined,
      min_due: minDue != null ? "MINIMUM DUE" : undefined,
      period: period.start && period.end ? "Billing Period" : undefined,
    },
  };
};

// re-export splitCols to keep test imports stable (was previously imported here in some places)
export { splitCols };
