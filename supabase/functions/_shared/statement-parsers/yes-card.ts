// YES Bank credit card statement parser — tuned for YES BANK KLICK layouts.
//
// KLICK statements print the summary as a two-row table with no colons after
// labels. PDF text extraction serializes that either as
//   "Total Payment Due  Minimum Payment Due  Statement Period  ..."
//   "26,424.67 Dr       540.00 Dr            17/05/2026 - ..."
// or as label/value pairs interleaved across many lines. Either way a
// pure `label\s*:?\s*value` regex misses. This parser instead:
//   1. Isolates the PAYMENT SUMMARY block (labels + values together).
//   2. Uses non-greedy `[\s\S]{0,N}?` gaps between each label and its
//      value token so column drift doesn't break matching.
//   3. Walks the Account Summary transaction table for line items,
//      preserving the CATEGORY column (or last ALL-CAPS token block on the
//      row) as merchant_category.

import type { ParserContext, ParserResult, StatementLine } from "./types.ts";
import { genericExtract, reportMissing } from "./generic.ts";

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
const DATE_SRC = "(?:\\d{1,2}[./-]\\d{1,2}[./-](?:\\d{4}|\\d{2})|\\d{1,2}[\\s-]+[A-Za-z]{3,}(?:[\\s-]+(?:\\d{4}|\\d{2}))?)";
const AMOUNT_MARKER = /((?:[0-9]{1,3}(?:,[0-9]{2,3})+|[0-9]+)(?:\.[0-9]{2})?)\s*(Dr|DR|Cr|CR|Debit|Credit)\s*$/i;

function toIsoDate(raw: string | undefined | null, fallbackYear?: number | null): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/\s+/g, " ");
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})$/);
  if (m) { const yr = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${yr}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{4}|\d{2})$/);
  if (m) { const mon = MONTHS[m[2].slice(0, 3).toLowerCase()]; const yr = m[3].length === 2 ? `20${m[3]}` : m[3]; if (mon) return `${yr}-${mon}-${m[1].padStart(2, "0")}`; }
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})$/);
  if (m && fallbackYear) { const mon = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mon) return `${fallbackYear}-${mon}-${m[1].padStart(2, "0")}`; }
  return null;
}

function toAmount(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = raw.match(/([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normalizedLines(text: string): string[] {
  return text.replace(/\r/g, "\n").replace(/\u00a0/g, " ").split(/\n+/).map((line) => line.trim()).filter(Boolean);
}

function inferYear(text: string, ctx: ParserContext): number | null {
  if (ctx.statement_year) return ctx.statement_year;
  const m = `${ctx.subject ?? ""} ${text.slice(0, 2000)}`.match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

function cardLast4(text: string): string | null {
  // KLICK shows "Credit Card Number 653036******2605" and also
  // "Card No: 653036******2605" in the table header. Both should parse.
  return text.match(/\bCredit\s*Card\s*Number\s*\d{2,6}[xX*\s-]+(\d{4})\b/i)?.[1]
    ?? text.match(/\bCard\s*No\.?\s*[:#]?\s*\d{2,6}[xX*\s-]+(\d{4})\b/i)?.[1]
    ?? text.match(/YES\s+BANK\s+Card\s+Number\s+\d{2,6}[xX*]+(\d{4})/i)?.[1]
    ?? text.match(/card\s+number\s+\d{2,6}[xX*\s-]+(\d{4})/i)?.[1]
    ?? null;
}

// Slice out the PAYMENT SUMMARY block (labels + values) to constrain
// summary-field regexes. Falls back to a large window from the top when the
// header isn't present verbatim.
function summaryBlock(text: string): string {
  const start = text.search(/PAYMENT\s*SUMMARY/i);
  if (start >= 0) {
    const rest = text.slice(start);
    const endRel = rest.search(/Account\s*Summary|TRANSACTION\s*DETAILS|Previous\s*Balance\s*-\s*Payments/i);
    return endRel > 0 ? rest.slice(0, endRel + 400) : rest.slice(0, 2000);
  }
  return text.slice(0, 3000);
}

// Any of these appearing between a label and the amount indicates that
// PDF text extraction has serialized ANOTHER column's label onto the same
// gap; the amount we would grab belongs to that other column, not ours. The
// non-greedy match then jumps past to the correct value on the next line.
const COMPETING_SUMMARY_LABELS = "(?:Cash\\s*Limit|Available\\s*Credit\\s*Limit|Available\\s*Cash\\s*Limit|Points\\s*Earned|Current\\s*Purchases|Cash\\s*Advance|Other\\s*Mode|Credit\\s*Limit|Statement\\s*Date|Statement\\s*Generation\\s*Date|Payment\\s*Due\\s*Date|Statement\\s*Period|Total\\s*(?:Payment|Amount)\\s*Due|Minimum\\s*(?:Payment|Amount)\\s*Due|Previous\\s*Balance)";

// Modern KLICK-style statements (YES Bank, Airtel Axis, etc.) serialize the
// PAYMENT SUMMARY as a 2-row table: labels row followed by values row, both
// split by 2+ spaces. Extract the label→value pairing positionally so the
// competing-label ambiguity (see COMPETING_SUMMARY_LABELS) never arises.
interface TabularRow { labels: string[]; values: string[]; }
function tabularSummaryRows(block: string): TabularRow[] {
  const lines = block.split(/\n+/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim().length > 0);
  const rows: TabularRow[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const labelHits = [
      /Total\s*(?:Payment|Amount)\s*Due/i,
      /Minimum\s*(?:Payment|Amount)\s*Due/i,
      /Statement\s*Period/i,
      /Payment\s*Due\s*Date/i,
      /Statement\s*(?:Generation\s*)?Date/i,
      /Credit\s*Card\s*Number/i,
      /(?<!Available\s)Credit\s*Limit/i,
      /Available\s*Credit\s*Limit/i,
      /Available\s*Cash\s*Limit/i,
    ].filter((rx) => rx.test(lines[i])).length;
    // A label row has 2+ known summary labels and no digit clusters that
    // look like a value (5+ digits).
    if (labelHits >= 2 && !/\d{5,}/.test(lines[i])) {
      const valueLine = lines[i + 1];
      if (valueLine && /\d/.test(valueLine)) {
        const labels = lines[i].split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
        const values = valueLine.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
        if (labels.length && values.length) rows.push({ labels, values });
      }
    }
  }
  return rows;
}

function lookupTabular(rows: TabularRow[], labelRx: RegExp): string | null {
  for (const row of rows) {
    const idx = row.labels.findIndex((l) => labelRx.test(l));
    if (idx >= 0 && idx < row.values.length) return row.values[idx];
  }
  return null;
}

function summaryAmount(block: string, labelRx: RegExp): number | null {
  // Prefer positional table alignment; fall back to guarded regex.
  const cell = lookupTabular(tabularSummaryRows(block), labelRx);
  const tab = cell ? toAmount(cell) : null;
  if (tab != null) return tab;
  const rx = new RegExp(
    labelRx.source + `(?:(?!${COMPETING_SUMMARY_LABELS})[\\s\\S]){0,400}?([0-9][0-9,]*\\.[0-9]{2})(?:\\s*(?:Dr|Cr|DR|CR))?`,
    "i",
  );
  return toAmount(block.match(rx)?.[1]);
}

function summaryDate(block: string, labelRx: RegExp, fallbackYear?: number | null): string | null {
  const cell = lookupTabular(tabularSummaryRows(block), labelRx);
  if (cell) {
    // The cell may contain the date directly or a date embedded in more text.
    const dm = cell.match(new RegExp(DATE_SRC, "i"));
    const iso = dm ? toIsoDate(dm[0], fallbackYear) : null;
    if (iso) return iso;
  }
  const rx = new RegExp(
    labelRx.source + `(?:(?!${COMPETING_SUMMARY_LABELS})[\\s\\S]){0,400}?(${DATE_SRC})`,
    "i",
  );
  return toIsoDate(block.match(rx)?.[1], fallbackYear);
}

function summaryPeriod(block: string, fallbackYear?: number | null): { start: string | null; end: string | null } {
  // The period value contains a range separator, e.g. "17/05/2026 - 15/06/2026"
  // or "02/06/2026 To 01/07/2026". Try the tabular cell first.
  const cell = lookupTabular(tabularSummaryRows(block), /Statement\s*Period/i);
  if (cell) {
    const rm = cell.match(new RegExp(`(${DATE_SRC})\\s*(?:-|to|–|—|To)\\s*(${DATE_SRC})`, "i"));
    if (rm) return { start: toIsoDate(rm[1], fallbackYear), end: toIsoDate(rm[2], fallbackYear) };
  }
  // Regex fallback: unique range pattern anywhere in the block.
  const rm = block.match(new RegExp(`(${DATE_SRC})\\s*(?:-|to|–|—|To)\\s*(${DATE_SRC})`, "i"));
  return { start: rm ? toIsoDate(rm[1], fallbackYear) : null, end: rm ? toIsoDate(rm[2], fallbackYear) : null };
}

function creditLimit(block: string): number | null {
  const cell = lookupTabular(tabularSummaryRows(block), /(?<!Available\s)Credit\s*Limit/i);
  const tab = cell ? toAmount(cell) : null;
  if (tab != null) return tab;
  const rx = new RegExp(
    `(?<!Available\\s)Credit\\s*Limit(?:(?!Available\\s*Credit\\s*Limit|Available\\s*Cash\\s*Limit|Cash\\s*Limit|Current\\s*Purchases|Cash\\s*Advance|Statement\\s*Date|Statement\\s*Generation\\s*Date|Payment\\s*Due\\s*Date|Total\\s*(?:Payment|Amount)\\s*Due|Minimum\\s*(?:Payment|Amount)\\s*Due)[\\s\\S]){0,300}?([0-9][0-9,]*\\.[0-9]{2})`,
    "i",
  );
  return toAmount(block.match(rx)?.[1]);
}




// YES Bank uses Title Case category headers on some layouts ("Retail Outlet
// Services") and ALL CAPS on others ("JEWELLERY", "FOOD PRODUCTS"). The
// column separator in the raw PDF text is always 2+ spaces. We identify the
// category as the last whitespace-padded token block sitting immediately
// before the trailing amount+marker.
// Category sits at the trailing end of the description string (amount has
// already been sliced off by the caller). Prefer a 2+ space column
// separator; fall back to a trailing ALL-CAPS token block.
const CATEGORY_COL_RX = /\s{2,}([A-Z][A-Za-z0-9 &/]{2,60}[A-Za-z0-9])\s*$/;
const CATEGORY_CAPS_RX = /\s([A-Z][A-Z0-9 &/]{2,40}[A-Z0-9])\s*$/;

function extractYesLines(text: string, fallbackYear?: number | null): StatementLine[] {
  // Keep original spacing here — the 2+ space column separator is the only
  // signal for the merchant-category column in some layouts.
  const rawLines = text.replace(/\r/g, "\n").replace(/\u00a0/g, " ").split(/\n+/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim().length > 0);
  const out: StatementLine[] = [];
  const seen = new Set<string>();
  let pendingDescription: string | null = null;
  let pendingDate: string | null = null;
  let lastIdx = -1;

  // Skip everything above the transaction table header — otherwise the
  // PAYMENT SUMMARY rows (which also contain amounts) get parsed as lines.
  const tableStart = rawLines.findIndex((l) =>
    /^\s*Date\b.*Transaction\s*Details/i.test(l) ||
    /^\s*Card\s*No\s*:/i.test(l) ||
    /^\s*Statement\s*Details\s*$/i.test(l),
  );
  const workingLines = tableStart >= 0 ? rawLines.slice(tableStart + 1) : rawLines;

  const add = (dateRaw: string, restRaw: string, amountRaw: string, marker: string) => {
    const date = toIsoDate(dateRaw, fallbackYear);
    const amount = toAmount(amountRaw);
    if (!date || amount == null || amount <= 0) return;
    const ref = restRaw.match(/\bRef\s*No\s*:?\s*([A-Z0-9-]{6,})/i)?.[1] ?? null;

    // Merge in any pending sub-line (some rows wrap the UPI VPA onto the
    // next line before the category + amount row).
    const merged = pendingDescription ? `${pendingDescription} ${restRaw}` : restRaw;
    // Category: prefer the 2+ space column separator; fall back to the
    // last ALL-CAPS token block.
    let merchant_category: string | null = null;
    let description = merged;
    const colMatch = merged.match(CATEGORY_COL_RX);
    if (colMatch && colMatch.index != null) {
      merchant_category = colMatch[1].trim();
      description = merged.slice(0, colMatch.index).trim() || merged;
    } else {
      const capsMatch = ` ${merged}`.match(CATEGORY_CAPS_RX);
      if (capsMatch && capsMatch.index != null) {
        merchant_category = capsMatch[1].trim();
        // capsMatch.index is offset in the " " + merged prefix; subtract 1.
        description = merged.slice(0, Math.max(0, capsMatch.index - 1)).trim() || merged;
      }
    }
    description = description.replace(/\s*-\s*Ref\s*No\s*:?\s*[A-Z0-9-]*\s*$/i, "").replace(/\s{2,}/g, " ").trim();
    if (ref && !new RegExp(ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(description)) {
      description = `${description} - Ref No: ${ref}`.trim();
    }
    if (!description || /^date\b|transaction details|merchant category|amount|payment summary/i.test(description)) return;
    const txn_type = /cr|credit/i.test(marker) ? "credit" : "debit";
    const key = `${date}|${amount}|${description.slice(0, 48).toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ date, description, amount, txn_type, merchant_category, reference_number: ref });
    lastIdx = out.length - 1;
    pendingDescription = null;
    pendingDate = null;
  };

  for (const line of workingLines) {
    if (/^(credit card statement|page \d+ of|sms |email us|cin\s*:|yes touch|to redeem|important information|payment summary|account summary|previous balance|date\s+transaction\s+details)/i.test(line)) continue;
    // Standalone reference number continuation (attaches to previous txn).
    const refOnly = line.match(/^\s*(RT\d{8,}|[A-Z]{2}\d{8,})\s*$/i)?.[1];
    if (refOnly && lastIdx >= 0 && !out[lastIdx].reference_number) {
      out[lastIdx].reference_number = refOnly;
      continue;
    }
    const startsDate = line.match(new RegExp(`^\\s*(${DATE_SRC})\\s+(.+)$`, "i"));
    if (!startsDate) {
      if (pendingDate) {
        const amountMatch = line.match(AMOUNT_MARKER);
        if (amountMatch && amountMatch.index != null) {
          add(pendingDate, `${pendingDescription ?? ""} ${line.slice(0, amountMatch.index).replace(/\s+$/, "")}`.trim(), amountMatch[1], amountMatch[2]);
          continue;
        }
        if (line.length > 5 && !AMOUNT_MARKER.test(line)) {
          pendingDescription = pendingDescription ? `${pendingDescription} ${line}` : line;
        }
        continue;
      }
      continue;
    }
    const dateRaw = startsDate[1];
    // Preserve original whitespace — the 2+ space column separator is the
    // only signal for the merchant-category column in many KLICK layouts.
    const rest = startsDate[2].replace(/\s+$/, "");
    const amountMatch = rest.match(AMOUNT_MARKER);
    if (!amountMatch || amountMatch.index == null) {
      pendingDescription = pendingDescription ? `${pendingDescription} ${rest}` : rest;
      pendingDate = dateRaw;
      continue;
    }
    add(dateRaw, rest.slice(0, amountMatch.index).replace(/\s+$/, ""), amountMatch[1], amountMatch[2]);
  }
  return out;
}

// Exported so sibling parsers with the same tabular PAYMENT SUMMARY block
// (Airtel Axis co-brand, generic Axis KLICK-style) can reuse the field
// extractors without re-implementing the competing-label guard.
export const yesKlickBlockHelpers = {
  summaryBlock,
  summaryAmount,
  summaryDate,
  summaryPeriod,
  creditLimit,
  cardLast4,
  extractYesLines,
  inferYear,
};

export const yesCardParser = (text: string, ctx: ParserContext): ParserResult => {
  const year = inferYear(text, ctx);
  const base = genericExtract(text, year);
  const block = summaryBlock(text);
  const period = summaryPeriod(block, year);
  const statementDate = summaryDate(block, /Statement\s*(?:Generation\s*)?Date/i, year) ?? base.statement_date;
  const dueDate = summaryDate(block, /Payment\s*Due\s*Date/i, year) ?? base.due_date;
  const totalDue = summaryAmount(block, /Total\s*(?:Payment|Amount)\s*Due/i) ?? base.total_due;
  const minDue = summaryAmount(block, /Minimum\s*(?:Payment|Amount)\s*Due/i) ?? base.min_due;
  const cLimit = creditLimit(block) ?? base.credit_limit;
  const statementLines = extractYesLines(text, year);

  const fields = {
    ...base,
    period_start: period.start ?? base.period_start,
    period_end: period.end ?? base.period_end,
    statement_date: statementDate,
    due_date: dueDate,
    total_due: totalDue,
    min_due: minDue,
    closing_balance: base.closing_balance ?? totalDue,
    credit_limit: cLimit,
    card_last4: cardLast4(text) ?? base.card_last4,
    lines: statementLines.length ? statementLines : base.lines,
  };

  const missing = reportMissing(fields, ["statement_date", "due_date", "total_due"]);
  return {
    ok: missing.length === 0,
    fields,
    parser_source: "yes-card",
    confidence: missing.length === 0 ? 0.9 : 0.6,
    missing_fields: missing,
    matched_labels: {
      statement_date: fields.statement_date ? "Statement Generation Date" : undefined,
      due_date: fields.due_date ? "Payment Due Date" : undefined,
      total_due: fields.total_due ? "Total Payment Due" : undefined,
      min_due: fields.min_due ? "Minimum Payment Due" : undefined,
      period: fields.period_start && fields.period_end ? "Statement Period" : undefined,
    },
  };
};

