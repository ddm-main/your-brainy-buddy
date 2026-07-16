// ICICI Bank savings/current account statement.
//
// Layout: multi-column table with header
//   DATE  MODE  PARTICULARS  DEPOSITS  WITHDRAWALS  BALANCE
// Particulars often wrap across 2-3 lines. pdftotext -layout emits some
// rows with the description BEFORE the anchor row (date + amount + balance
// on a line by themselves) because the ICICI PDF stacks narratives above
// numeric columns visually. We therefore run a two-pass extraction:
//   Pass 1: identify anchor rows (start with `DD-MM-YYYY`, end with a
//           numeric balance token).
//   Pass 2: back-fill each anchor's description from the immediately
//           preceding non-anchor, non-empty lines that don't belong to a
//           previous anchor's forward continuation.

import type { ParserContext, ParserResult, StatementLine } from "./types.ts";
import { genericExtract, reportMissing } from "./generic.ts";
import { inferYear, toAmount, toIsoDate } from "./shared.ts";

function accountLast4(text: string): string | null {
  return text.match(/Savings\s*A\/c\s*X{2,}(\d{4})\b/i)?.[1]
    ?? text.match(/Account\s*No\.?\s*[X\-\*]*(\d{4})\b/i)?.[1]
    ?? null;
}

interface AnchorHit {
  lineIndex: number;
  date: string;
  amount: number;
  balance: number;
  kind: "debit" | "credit";
  inlineDescription: string;
}

function looksLikeNoise(line: string): boolean {
  if (!line.trim()) return true;
  if (/Page\s+\d+|Sincerely|Team\s+ICICI|^BALANCE\b|^DATE\s+MODE|^Statement\s+of|DEPOSITS\s+WITHDRAWALS/i.test(line)) return true;
  if (/^-+$|^=+$/.test(line.trim())) return true;
  return false;
}

export const iciciAccountParser = (text: string, ctx: ParserContext): ParserResult => {
  const year = inferYear(text, ctx);
  const base = genericExtract(text, year);

  const lines = text.split(/\n+/).map((l) => l.replace(/\s+$/, ""));

  // Period: "for the period June 01, 2026 - June 30, 2026"
  const periodMatch = text.match(/for\s+the\s+period\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})\s*(?:-|to|–)\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i);
  const periodStart = periodMatch ? toIsoDate(periodMatch[1], year) : base.period_start;
  const periodEnd = periodMatch ? toIsoDate(periodMatch[2], year) : base.period_end;

  const anchorRx = /^\s*(\d{1,2}-\d{1,2}-\d{4})\s+(.*)$/;
  const numRx = /(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;

  // Pass 1: identify anchor rows.
  const anchors: AnchorHit[] = [];
  let closingBalance: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(anchorRx);
    if (!m) continue;
    const date = toIsoDate(m[1], year);
    if (!date) continue;
    const rest = m[2];
    const nums: { val: string; idx: number; end: number }[] = [];
    let nm: RegExpExecArray | null;
    numRx.lastIndex = 0;
    while ((nm = numRx.exec(rest)) !== null) {
      // Skip stray single-digit / 2-digit tokens that appear in narrative text.
      if (nm[1].length < 3 && !nm[1].includes(",") && !nm[1].includes(".")) continue;
      nums.push({ val: nm[1], idx: nm.index, end: nm.index + nm[0].length });
    }
    if (nums.length < 2) {
      // Special case: opening balance row `01-06-2026   B/F   1,10,015.32`
      // is not a real txn — skip it (its number tail is a single value).
      continue;
    }
    const balance = toAmount(nums[nums.length - 1].val);
    const amount = toAmount(nums[nums.length - 2].val);
    if (amount == null || balance == null) continue;
    closingBalance = balance;
    // Column heuristic: DEPOSITS is left of WITHDRAWALS; the amount-to-balance
    // horizontal gap is larger when the amount landed in the DEPOSITS column.
    const gap = nums[nums.length - 1].idx - nums[nums.length - 2].end;
    const kind: "debit" | "credit" = gap > 12 ? "credit" : "debit";
    const inlineDescription = rest.slice(0, nums[nums.length - 2].idx).replace(/\s{2,}/g, " ").trim();
    anchors.push({ lineIndex: i, date, amount, balance, kind, inlineDescription });
  }

  // Pass 2: back-fill descriptions from lines above each anchor that don't
  // belong to an earlier anchor's forward continuation, plus any forward
  // continuation lines (indented narratives immediately following).
  const out: StatementLine[] = [];
  const seen = new Set<string>();
  for (let k = 0; k < anchors.length; k++) {
    const cur = anchors[k];
    const prev = k > 0 ? anchors[k - 1] : null;
    const preceding: string[] = [];
    // Walk upward from cur.lineIndex - 1 until we hit the previous anchor
    // or a "hard" boundary (blank, noise, header).
    const upperBound = prev ? prev.lineIndex : -1;
    for (let j = cur.lineIndex - 1; j > upperBound; j--) {
      const raw = lines[j];
      if (!raw.trim()) break;
      if (looksLikeNoise(raw)) break;
      // Numeric-only lines belong to the previous anchor's amount column.
      if (/^\s*[\d.,\-\s]+\s*$/.test(raw)) break;
      preceding.unshift(raw.trim());
    }
    // Forward continuation lines: indented narratives right after the anchor
    // that carry the merchant reference. Stop at the next anchor / noise.
    const following: string[] = [];
    const nextIdx = k + 1 < anchors.length ? anchors[k + 1].lineIndex : lines.length;
    for (let j = cur.lineIndex + 1; j < nextIdx; j++) {
      const raw = lines[j];
      if (!raw.trim()) continue;
      if (looksLikeNoise(raw)) continue;
      // Numeric-only line — skip (leftover balance column artifact).
      if (/^\s*[\d.,\-\s]+\s*$/.test(raw)) continue;
      following.push(raw.trim());
    }
    const desc = [...preceding, cur.inlineDescription, ...following]
      .filter(Boolean)
      .join(" ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!desc || /^Total:?\s*$/i.test(desc) || /^B\/F\s*$/i.test(desc)) continue;
    const key = `${cur.date}|${cur.amount}|${desc.slice(0, 40).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date: cur.date, description: desc, amount: cur.amount, txn_type: cur.kind });
  }

  const fields = {
    ...base,
    period_start: periodStart,
    period_end: periodEnd,
    statement_date: base.statement_date ?? periodEnd,
    closing_balance: closingBalance ?? base.closing_balance,
    card_last4: accountLast4(text) ?? base.card_last4,
    lines: out.length ? out : base.lines,
  };
  const missing = reportMissing(fields, ["period_start", "period_end"]);
  return {
    ok: missing.length === 0 && fields.lines.length > 0,
    fields,
    parser_source: "icici-account",
    confidence: fields.lines.length > 0 ? 0.85 : 0.5,
    missing_fields: missing,
    matched_labels: {
      period: periodStart && periodEnd ? "for the period" : undefined,
      closing_balance: closingBalance != null ? "Balance" : undefined,
    },
  };
};
