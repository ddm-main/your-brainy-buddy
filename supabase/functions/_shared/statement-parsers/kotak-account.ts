// Kotak Mahindra Bank savings account statement parser.
//
// Layout (from a real Kotak `Account Statement`):
//   Account Statement
//   01 Jun 2026 - 30 Jun 2026
//   Account No. 3112929894    Account Type Savings
//   IFSC Code KKBK0001765
//   Savings Account Transactions
//   #   Date         Description    Chq/Ref. No.   Withdrawal (Dr.)  Deposit (Cr.)  Balance
//   -   -            Opening Balance ...                                                  21,400.67
//   1   01 Jun 2026  NEFT ... DEEPAK  NEFTINW-...                            10,000.00    31,400.67
//   ...
// Some rows wrap description across 2 lines — the anchor row (with the row
// number and a balance value in the last column) carries the amount.

import type { ParserContext, ParserResult, StatementLine } from "./types.ts";
import { reportMissing } from "./generic.ts";
import { toAmount, toIsoDate } from "./shared.ts";

function inferYear(text: string, ctx: ParserContext): number | null {
  if (ctx.statement_year) return ctx.statement_year;
  const m = `${ctx.subject ?? ""} ${text.slice(0, 2000)}`.match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

function accountLast4(text: string): string | null {
  const m = text.match(/Account\s*No\.?\s*(\d{4,20})/i);
  return m ? m[1].slice(-4) : null;
}

export const kotakAccountParser = (text: string, ctx: ParserContext): ParserResult => {
  const year = inferYear(text, ctx);
  const lines = text.split(/\n+/).map((l) => l.replace(/\s+$/, ""));

  // Period: `Account Statement DD MMM YYYY - DD MMM YYYY`
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  for (let i = 0; i < lines.length - 1; i++) {
    if (/Account\s*Statement/i.test(lines[i])) {
      const combined = `${lines[i]} ${lines[i + 1]}`.replace(/\s+/g, " ");
      const rm = combined.match(/(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})\s*(?:-|to|–)\s*(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})/i);
      if (rm) {
        periodStart = toIsoDate(rm[1], year);
        periodEnd = toIsoDate(rm[2], year);
        break;
      }
    }
  }

  let openingBalance: number | null = null;
  let closingBalance: number | null = null;
  const out: StatementLine[] = [];
  const seen = new Set<string>();

  // Anchor row: <serial> <date> <description...> [<ref>] <amount(dr|cr)> <balance>
  // We accept either withdrawal or deposit in a single amount cell — the
  // preceding column layout separates them by 2+ spaces so we can identify
  // the correct one by counting numeric cells at the end.
  const anchorRx = /^\s*(\d{1,4})\s+(\d{1,2}\s+[A-Za-z]{3,}\s+\d{2,4})\s+(.+)$/;

  const parseNumericTail = (rest: string): { desc: string; amount: number | null; balance: number | null; kind: "debit" | "credit" | null } => {
    // Extract all numeric tokens; the last is balance, the second-to-last
    // is the amount. Description is everything before the first numeric
    // token in the tail (accounting for ref-no tokens like `UPI-...` or
    // `NEFTINW-...` which are alphanumeric).
    const numRx = /(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;
    const nums: { val: string; idx: number; end: number }[] = [];
    let m: RegExpExecArray | null;
    numRx.lastIndex = 0;
    while ((m = numRx.exec(rest)) !== null) {
      // filter fragments that are only 1 or 2 digits (part of ref numbers)
      if (m[1].length < 3 && !m[1].includes(",") && !m[1].includes(".")) continue;
      nums.push({ val: m[1], idx: m.index, end: m.index + m[0].length });
    }
    if (nums.length === 0) return { desc: rest.trim(), amount: null, balance: null, kind: null };
    const balance = toAmount(nums[nums.length - 1].val);
    let amount: number | null = null;
    let kind: "debit" | "credit" | null = null;
    if (nums.length >= 2) {
      amount = toAmount(nums[nums.length - 2].val);
      // Kind: withdrawal column is left of deposit column in the header.
      // Use gap heuristic — if the amount cell is far from the balance cell
      // (>10 spaces), the middle deposit column was blank → withdrawal.
      const amtCell = nums[nums.length - 2];
      const balCell = nums[nums.length - 1];
      const gap = balCell.idx - amtCell.end;
      // Withdrawal (Dr) column is closer to description than Deposit (Cr).
      // Empirically in Kotak layout: dr column ends ~col 100, cr column at ~col 118,
      // balance at ~col 135. If gap between amount and balance > 15, amount is dr.
      kind = gap > 15 ? "debit" : "credit";
    }
    const desc = rest.slice(0, nums[nums.length - (nums.length >= 2 ? 2 : 1)].idx).trim();
    return { desc, amount, balance, kind };
  };

  let pendingWrap = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { pendingWrap = ""; continue; }
    // Opening balance row
    const openMatch = line.match(/Opening\s*Balance.*?([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*$/i);
    if (openMatch) { openingBalance = toAmount(openMatch[1]); pendingWrap = ""; continue; }

    const anchor = line.match(anchorRx);
    if (!anchor) {
      // Continuation line — append to pendingWrap for the most recent txn.
      if (out.length > 0 && !/Page\s+\d+\s+of|Statement\s+Generated|Savings\s+Account\s+Transactions|Chq\/Ref/i.test(line)) {
        out[out.length - 1].description = `${out[out.length - 1].description} ${line.trim()}`.replace(/\s+/g, " ");
      }
      continue;
    }
    const date = toIsoDate(anchor[2], year);
    if (!date) continue;
    const { desc, amount, balance, kind } = parseNumericTail(anchor[3]);
    if (amount == null || kind == null) continue;
    if (balance != null) closingBalance = balance;
    const description = desc.replace(/\s{2,}/g, " ").replace(/\s+[A-Z0-9-]{6,}\s*$/i, (s) => s.trim()).trim();
    if (!description) continue;
    const key = `${date}|${amount}|${description.slice(0, 40).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      description,
      amount,
      txn_type: kind,
    });
  }

  const fields = {
    period_start: periodStart,
    period_end: periodEnd,
    statement_date: periodEnd,
    due_date: null,
    total_due: null,
    min_due: null,
    closing_balance: closingBalance ?? openingBalance,
    credit_limit: null,
    card_last4: accountLast4(text),
    lines: out,
  };
  const missing = reportMissing(fields, ["period_start", "period_end"]);
  return {
    ok: missing.length === 0 && out.length > 0,
    fields,
    parser_source: "kotak-account",
    confidence: out.length > 0 ? 0.85 : 0.4,
    missing_fields: missing,
    matched_labels: {
      period: periodStart && periodEnd ? "Account Statement" : undefined,
      closing_balance: closingBalance != null ? "Balance" : undefined,
    },
  };
};
