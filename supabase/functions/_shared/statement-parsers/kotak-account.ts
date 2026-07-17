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
//
// The numeric cells are right-aligned under `Withdrawal (Dr.)`,
// `Deposit (Cr.)` and `Balance`. We bucket each numeric token on the anchor
// row by its right-edge distance to the header word's right-edge — that way
// reference numbers embedded in the narrative (`NEFTINW-1603510570`, UPI
// txn IDs, etc.) can't be misread as amounts.

import type { ParserContext, ParserResult, StatementLine } from "./types.ts";
import { reportMissing } from "./generic.ts";
import { bucketRowByHeader, findHeaderColumns, toAmount, toIsoDate } from "./shared.ts";

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

  const header = findHeaderColumns(text, [
    { name: "withdrawals", pattern: /Withdrawal\s*\(Dr\.?\)/i },
    { name: "deposits",    pattern: /Deposit\s*\(Cr\.?\)/i },
    { name: "balance",     pattern: /\bBalance\b/ },
  ]);

  let openingBalance: number | null = null;
  let closingBalance: number | null = null;
  const out: StatementLine[] = [];
  const seen = new Set<string>();

  const anchorRx = /^\s*(\d{1,4})\s+(\d{1,2}\s+[A-Za-z]{3,}\s+\d{2,4})\s+(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const openMatch = line.match(/Opening\s*Balance.*?([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*$/i);
    if (openMatch) { openingBalance = toAmount(openMatch[1]); continue; }

    const anchor = line.match(anchorRx);
    if (!anchor) {
      // Continuation line — append to the most recent txn's description.
      if (out.length > 0 && !/Page\s+\d+\s+of|Statement\s+Generated|Savings\s+Account\s+Transactions|Chq\/Ref/i.test(line)) {
        out[out.length - 1].description = `${out[out.length - 1].description} ${line.trim()}`.replace(/\s+/g, " ");
      }
      continue;
    }
    const date = toIsoDate(anchor[2], year);
    if (!date) continue;

    let amount: number | null = null;
    let kind: "debit" | "credit" | null = null;
    let balance: number | null = null;
    let descriptionRegion = anchor[3];

    if (header) {
      const bucket = bucketRowByHeader(line, header.columns, { tolerance: 12 });
      const withdrawal = bucket.values.withdrawals ? toAmount(bucket.values.withdrawals) : null;
      const deposit = bucket.values.deposits ? toAmount(bucket.values.deposits) : null;
      balance = bucket.values.balance ? toAmount(bucket.values.balance) : null;
      if (balance != null) closingBalance = balance;
      if (withdrawal != null && deposit == null) { amount = withdrawal; kind = "debit"; }
      else if (deposit != null && withdrawal == null) { amount = deposit; kind = "credit"; }
      else if (withdrawal != null && deposit != null) {
        // Rare: both populated. Prefer the one that isn't equal to the balance.
        if (withdrawal === balance) { amount = deposit; kind = "credit"; }
        else { amount = withdrawal; kind = "debit"; }
      }
      // Trim description to the region before any bucketed amount cell.
      const desc = bucket.descriptionRegion.match(anchorRx);
      if (desc) descriptionRegion = desc[3];
    } else {
      // Fallback: legacy gap heuristic on the numeric tail.
      const numRx = /(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;
      const nums: { val: string; idx: number; end: number }[] = [];
      let m: RegExpExecArray | null;
      while ((m = numRx.exec(anchor[3])) !== null) {
        if (m[1].length < 3 && !m[1].includes(",") && !m[1].includes(".")) continue;
        nums.push({ val: m[1], idx: m.index, end: m.index + m[0].length });
      }
      if (nums.length >= 2) {
        balance = toAmount(nums[nums.length - 1].val);
        amount = toAmount(nums[nums.length - 2].val);
        const gap = nums[nums.length - 1].idx - nums[nums.length - 2].end;
        kind = gap > 15 ? "debit" : "credit";
        descriptionRegion = anchor[3].slice(0, nums[nums.length - 2].idx);
      }
    }

    if (amount == null || kind == null) continue;
    if (balance != null && amount === balance) continue;

    const description = descriptionRegion
      .replace(/\s{2,}/g, " ")
      .replace(/\s+[A-Z0-9\-]{6,}\s*$/i, (s) => s.trim())
      .trim();
    if (!description) continue;
    const key = `${date}|${amount}|${description.slice(0, 40).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, description, amount, txn_type: kind });
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
    confidence: out.length > 0 ? (header ? 0.9 : 0.75) : 0.4,
    missing_fields: missing,
    matched_labels: {
      period: periodStart && periodEnd ? "Account Statement" : undefined,
      closing_balance: closingBalance != null ? "Balance" : undefined,
    },
  };
};
