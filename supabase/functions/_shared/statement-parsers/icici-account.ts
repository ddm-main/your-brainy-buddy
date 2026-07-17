// ICICI Bank savings/current account statement.
//
// Layout: multi-column table with header
//   DATE  MODE  PARTICULARS  DEPOSITS  WITHDRAWALS  BALANCE
//
// Numeric values are right-aligned under their header word. Historically we
// used a "last two numbers on the anchor line = amount + balance" heuristic,
// but that mis-parses any row whose narrative contains a numeric fragment
// (loan account tags like `XX55381`, UTRs, phone numbers, embedded dates).
// A concrete example that used to break:
//
//   05-06-2026    BIL/Used Car Loan XX55381 EMI Deep    14,905.00    25,184.45
//
// The parser would sometimes pick `25,184.45` (the running balance) as the
// amount and stamp the txn as a credit. We now anchor on the header line
// column positions and bucket each numeric token by its right-edge distance
// to DEPOSITS / WITHDRAWALS / BALANCE — reference numbers embedded in
// PARTICULARS fall outside the tolerance and are ignored.

import type { ParserContext, ParserResult, StatementLine } from "./types.ts";
import { genericExtract, reportMissing } from "./generic.ts";
import { bucketRowByHeader, findHeaderColumns, inferYear, toAmount, toIsoDate } from "./shared.ts";

function accountLast4(text: string): string | null {
  return text.match(/Savings\s*A\/c\s*X{2,}(\d{4})\b/i)?.[1]
    ?? text.match(/Account\s*No\.?\s*[X\-\*]*(\d{4})\b/i)?.[1]
    ?? null;
}

interface AnchorHit {
  lineIndex: number;
  date: string;
  amount: number;
  balance: number | null;
  kind: "debit" | "credit";
  inlineDescription: string;
}

function looksLikeNoise(line: string): boolean {
  if (!line.trim()) return true;
  if (/Page\s+\d+|Sincerely|Team\s+ICICI|^BALANCE\b|^DATE\s+MODE|^Statement\s+of|DEPOSITS\s+WITHDRAWALS/i.test(line)) return true;
  if (/^-+$|^=+$/.test(line.trim())) return true;
  return false;
}

const OPENING_ROW = /\bB\/F\b|\bOpening\s+Balance\b/i;
const TOTAL_ROW = /^\s*Total:?\s*$/i;

export const iciciAccountParser = (text: string, ctx: ParserContext): ParserResult => {
  const year = inferYear(text, ctx);
  const base = genericExtract(text, year);

  const lines = text.split(/\n+/).map((l) => l.replace(/\s+$/, ""));

  // Period: "for the period June 01, 2026 - June 30, 2026"
  const periodMatch = text.match(/for\s+the\s+period\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})\s*(?:-|to|–)\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i);
  const periodStart = periodMatch ? toIsoDate(periodMatch[1], year) : base.period_start;
  const periodEnd = periodMatch ? toIsoDate(periodMatch[2], year) : base.period_end;

  // Locate the tri-column header so we can bucket amounts by column position.
  const header = findHeaderColumns(text, [
    { name: "deposits",    pattern: /\bDEPOSITS\b/ },
    { name: "withdrawals", pattern: /\bWITHDRAWALS\b/ },
    { name: "balance",     pattern: /\bBALANCE\b/ },
  ]);

  const anchorRx = /^\s*(\d{1,2}-\d{1,2}-\d{4})\s+(.*)$/;

  // Pass 1: identify anchor rows.
  const anchors: AnchorHit[] = [];
  let closingBalance: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(anchorRx);
    if (!m) continue;
    const date = toIsoDate(m[1], year);
    if (!date) continue;
    if (TOTAL_ROW.test(m[2])) continue;

    // Column-anchored path (preferred).
    if (header) {
      const bucket = bucketRowByHeader(line, header.columns);
      const deposit = bucket.values.deposits ? toAmount(bucket.values.deposits) : null;
      const withdrawal = bucket.values.withdrawals ? toAmount(bucket.values.withdrawals) : null;
      const balance = bucket.values.balance ? toAmount(bucket.values.balance) : null;
      if (balance != null) closingBalance = balance;

      // Opening balance / B/F row: balance only, no amount cell. Skip.
      if (deposit == null && withdrawal == null) continue;
      // Defensive: some templates emit both — trust withdrawal-side when the
      // narrative starts with `BIL/` (bill pay) or `UPI/…/Paid`, else deposit.
      let amount: number | null = null;
      let kind: "debit" | "credit" = "debit";
      if (withdrawal != null && deposit == null) {
        amount = withdrawal; kind = "debit";
      } else if (deposit != null && withdrawal == null) {
        amount = deposit; kind = "credit";
      } else if (withdrawal != null && deposit != null) {
        // Extremely rare — pick whichever isn't equal to the balance.
        if (withdrawal === balance) { amount = deposit; kind = "credit"; }
        else { amount = withdrawal; kind = "debit"; }
      }
      if (amount == null) continue;
      // Guardrail: never emit amount === balance (that's a mis-bucket).
      if (balance != null && amount === balance) continue;

      const inlineDescription = bucket.descriptionRegion
        .replace(anchorRx, "$2")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (OPENING_ROW.test(inlineDescription)) continue;
      anchors.push({ lineIndex: i, date, amount, balance, kind, inlineDescription });
      continue;
    }

    // Fallback: no header found → legacy heuristic. Numeric tail on the row.
    const rest = m[2];
    const numRx = /(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;
    const nums: { val: string; idx: number; end: number }[] = [];
    let nm: RegExpExecArray | null;
    while ((nm = numRx.exec(rest)) !== null) {
      if (nm[1].length < 3 && !nm[1].includes(",") && !nm[1].includes(".")) continue;
      nums.push({ val: nm[1], idx: nm.index, end: nm.index + nm[0].length });
    }
    if (nums.length < 2) continue;
    const balance = toAmount(nums[nums.length - 1].val);
    const amount = toAmount(nums[nums.length - 2].val);
    if (amount == null || balance == null) continue;
    if (amount === balance) continue;
    closingBalance = balance;
    const gap = nums[nums.length - 1].idx - nums[nums.length - 2].end;
    const kind: "debit" | "credit" = gap > 12 ? "credit" : "debit";
    const inlineDescription = rest.slice(0, nums[nums.length - 2].idx).replace(/\s{2,}/g, " ").trim();
    if (OPENING_ROW.test(inlineDescription)) continue;
    anchors.push({ lineIndex: i, date, amount, balance, kind, inlineDescription });
  }

  // Pass 2: back-fill descriptions from lines above each anchor + forward
  // continuation lines (indented narratives immediately following).
  const out: StatementLine[] = [];
  const seen = new Set<string>();
  for (let k = 0; k < anchors.length; k++) {
    const cur = anchors[k];
    const prev = k > 0 ? anchors[k - 1] : null;
    const preceding: string[] = [];
    const upperBound = prev ? prev.lineIndex : -1;
    for (let j = cur.lineIndex - 1; j > upperBound; j--) {
      const raw = lines[j];
      if (!raw.trim()) break;
      if (looksLikeNoise(raw)) break;
      if (/^\s*[\d.,\-\s]+\s*$/.test(raw)) break;
      preceding.unshift(raw.trim());
    }
    const following: string[] = [];
    const nextIdx = k + 1 < anchors.length ? anchors[k + 1].lineIndex : lines.length;
    for (let j = cur.lineIndex + 1; j < nextIdx; j++) {
      const raw = lines[j];
      if (!raw.trim()) continue;
      if (looksLikeNoise(raw)) continue;
      if (/^\s*[\d.,\-\s]+\s*$/.test(raw)) continue;
      following.push(raw.trim());
    }
    const desc = [...preceding, cur.inlineDescription, ...following]
      .filter(Boolean)
      .join(" ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!desc || TOTAL_ROW.test(desc) || OPENING_ROW.test(desc)) continue;
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
    confidence: fields.lines.length > 0 ? (header ? 0.92 : 0.75) : 0.5,
    missing_fields: missing,
    matched_labels: {
      period: periodStart && periodEnd ? "for the period" : undefined,
      closing_balance: closingBalance != null ? "Balance" : undefined,
    },
  };
};
