import { describe, it, expect } from "vitest";
import {
  applySkeleton,
  layoutFingerprint,
  synthesizeSkeletonFromResult,
  type SkeletonJson,
} from "../supabase/functions/_shared/statement-skeleton.ts";
import { computeCardPaymentStatus } from "../supabase/functions/_shared/card-payment-status.ts";

describe("statement skeleton", () => {
  it("applySkeleton pulls values via label anchors", () => {
    const skeleton: SkeletonJson = {
      bank_slug: "hdfc",
      statement_type: "card",
      variant: null,
      fields: {
        statement_date: { labels: ["Statement Date"], value_kind: "date" },
        due_date: { labels: ["Payment Due Date"], value_kind: "date" },
        total_due: { labels: ["Total Dues"], value_kind: "amount" },
        min_due: { labels: ["Minimum Amount Due"], value_kind: "amount" },
      },
      txn_header_line: null,
      learned_by: "regex-hdfc-card",
      learned_at: new Date().toISOString(),
    };
    const text = `HDFC Bank Credit Card
      Statement Date 05/07/2026
      Payment Due Date 22/07/2026
      Total Dues Rs. 45,678.90
      Minimum Amount Due Rs. 2,283.94`;
    const r = applySkeleton(text, skeleton);
    expect(r.ok).toBe(true);
    expect(r.statement_date).toBe("2026-07-05");
    expect(r.due_date).toBe("2026-07-22");
    expect(r.total_due).toBe(45678.9);
    expect(r.min_due).toBe(2283.94);
  });

  it("layoutFingerprint is stable across dates, changes with structure", async () => {
    // Amount shape (decimals, commas) must match — fingerprint zeroes
    // digits but keeps punctuation, so 10,000 and 45,678.90 differ. Real
    // PDFs are structurally identical month-to-month.
    const june = `HDFC Bank Credit Card Statement
      Statement Date 05/06/2026
      Payment Due Date 22/06/2026
      Total Dues Rs. 10,000.00
      Card ending 1234`;
    const july = `HDFC Bank Credit Card Statement
      Statement Date 05/07/2026
      Payment Due Date 22/07/2026
      Total Dues Rs. 45,678.90
      Card ending 1234`;
    const diff = `ICICI Bank Credit Card Summary
      Bill Period 06/06/2026 to 05/07/2026
      Amount Payable Rs. 8,910.00`;
    expect(await layoutFingerprint(june)).toBe(await layoutFingerprint(july));
    expect(await layoutFingerprint(june)).not.toBe(await layoutFingerprint(diff));
  });

  it("synthesizeSkeletonFromResult uses matched_labels when provided", () => {
    const s = synthesizeSkeletonFromResult({
      bank_slug: "hdfc",
      statement_type: "card",
      parser_source: "hdfc-card",
      result: {
        ok: true,
        fields: {
          statement_date: "2026-07-05",
          due_date: "2026-07-22",
          total_due: 45678.9,
          min_due: 2283.94,
          period_start: null,
          period_end: null,
          closing_balance: null,
          lines: [],
        },
        parser_source: "hdfc-card",
        confidence: 0.85,
        missing_fields: [],
        matched_labels: {
          statement_date: "Statement Date",
          due_date: "Payment Due Date",
          total_due: "Total Dues",
          min_due: "Minimum Amount Due",
        },
      },
    });
    expect(s.learned_by).toBe("regex-hdfc-card");
    expect(s.fields.statement_date?.labels).toContain("Statement Date");
    expect(s.fields.total_due?.labels).toContain("Total Dues");
    expect(s.fields.due_date?.value_kind).toBe("date");
  });

  it("account statements ignore due/total requirements", async () => {
    const { applySkeleton } = await import("../supabase/functions/_shared/statement-skeleton.ts");
    const skeleton: SkeletonJson = {
      bank_slug: "hdfc",
      statement_type: "account",
      variant: null,
      fields: {
        statement_date: { labels: ["Statement Date"], value_kind: "date" },
        closing_balance: { labels: ["Closing Balance"], value_kind: "amount" },
      },
      txn_header_line: null,
      learned_by: "test",
      learned_at: new Date().toISOString(),
    };
    const text = `HDFC Savings Account
      Statement Date 05/07/2026
      Closing Balance Rs. 1,23,456.00`;
    const r = applySkeleton(text, skeleton);
    expect(r.ok).toBe(true);
    expect(r.due_date).toBeNull();
    expect(r.total_due).toBeNull();
  });
});

describe("card payment lifecycle", () => {
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);

  it("no due date → na", () => {
    expect(computeCardPaymentStatus(null, 0, 100, null)).toBe("na");
  });
  it("future due, nothing paid → pending", () => {
    expect(computeCardPaymentStatus(null, 0, 1000, tomorrow)).toBe("pending");
  });
  it("past due, nothing paid → overdue", () => {
    expect(computeCardPaymentStatus(null, 0, 1000, yesterday)).toBe("overdue");
  });
  it("paid in full → paid", () => {
    expect(computeCardPaymentStatus(null, 1000, 1000, yesterday)).toBe("paid");
  });
  it("partially paid, before due → partial", () => {
    expect(computeCardPaymentStatus(null, 400, 1000, tomorrow)).toBe("partial");
  });
  it("explicit paid persists", () => {
    expect(computeCardPaymentStatus("paid", 0, 1000, yesterday)).toBe("paid");
  });
  it("explicit partial persists", () => {
    expect(computeCardPaymentStatus("partial", 500, 1000, yesterday)).toBe("partial");
  });
});