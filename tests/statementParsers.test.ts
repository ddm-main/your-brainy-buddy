import { describe, it, expect } from "vitest";
import { dispatchStatementParser } from "../supabase/functions/_shared/statement-parsers/index.ts";

describe("statement parsers", () => {
  it("sbi-card extracts due date + family from subject", () => {
    const text = `SBI Card Statement
      Statement Date : 05/07/2026
      Payment Due Date : 25/07/2026
      Total Amount Due : Rs. 12,345.67
      Minimum Amount Due : Rs. 618.00`;
    const r = dispatchStatementParser(text, { bank_slug: "sbi", statement_type: "card", subject: "Your BPCL SBI Card statement" });
    expect(r.parser_source).toContain("sbi-card");
    expect(r.parser_source).toContain("bpcl");
    expect(r.fields.total_due).toBe(12345.67);
    expect(r.fields.min_due).toBe(618);
    expect(r.fields.due_date).toBe("2026-07-25");
  });

  it("sbi-card parses ungrouped transaction rows", () => {
    const text = `SBI Card Statement
      Statement Date : 05/07/2026
      Payment Due Date : 25/07/2026
      Total Payment Due : Rs. 12345.67
      Minimum Amount Due : Rs. 618.00
      02/06/2026 AMAZON SELLER SERVICES 1299.00 Dr
      04/06/2026 PAYMENT RECEIVED 5000.00 Cr`;
    const r = dispatchStatementParser(text, { bank_slug: "sbi", statement_type: "card", subject: "Your CASHBACK SBI Card Monthly Statement" });
    expect(r.parser_source).toContain("sbi-card");
    expect(r.fields.total_due).toBe(12345.67);
    expect(r.fields.lines).toHaveLength(2);
    expect(r.fields.lines[0].amount).toBe(1299);
    expect(r.fields.lines[1].txn_type).toBe("credit");
  });

  it("sbi-card parses month-only rows using statement year", () => {
    const text = `SBI Card Statement
      Statement Date : 01 Mar 2026
      Payment Due Date : 21 Mar 2026
      Total Payment Due : Rs. 6,652.00
      Minimum Amount Due : Rs. 332.60
      28 Feb AMAZON SELLER SERVICES 1,299.00 Dr
      02 Mar PAYMENT RECEIVED 5,000.00 Cr`;
    const r = dispatchStatementParser(text, { bank_slug: "sbi", statement_type: "card", subject: "Your CASHBACK SBI Card Monthly Statement -Mar 2026" });
    expect(r.parser_source).toContain("sbi-card");
    expect(r.fields.min_due).toBe(332.6);
    expect(r.fields.lines).toHaveLength(2);
    expect(r.fields.lines[0].date).toBe("2026-02-28");
    expect(r.fields.lines[1].txn_type).toBe("credit");
  });

  it("sbi-card is selected from sbicard sender without bank slug", () => {
    const text = `Statement Date : 05/07/2026
      Payment Due Date : 25/07/2026
      Total Amount Due : Rs. 12,345.67`;
    const r = dispatchStatementParser(text, { sender: "Statements@sbicard.com", statement_type: "card" });
    expect(r.parser_source).toContain("sbi-card");
  });

  it("sbi-card handles dot dates and trailing balance columns", () => {
    const text = `SBI Card Statement
      Statement Date : 05.07.2026
      Payment Due Date : 25.07.2026
      Total Amount Due : Rs. 12,345.67
      05.07.2026 AMAZON PAY INDIA 1,299.00 Dr 45,231.00
      06.07.2026 CASHBACK CREDIT 199.00 Cr 45,032.00`;
    const r = dispatchStatementParser(text, { sender: "Statements@sbicard.com", statement_type: "card" });
    expect(r.fields.due_date).toBe("2026-07-25");
    expect(r.fields.lines).toHaveLength(2);
    expect(r.fields.lines[0].amount).toBe(1299);
    expect(r.fields.lines[1].txn_type).toBe("credit");
  });

  it("sbi-card parses real extracted SBI layout with split labels and D/C rows", () => {
    const text = `GSTIN of SBI Card : 06AAECS5981K1ZV  Stmt/Debit Note/Credit Note/Tax Invoice
DEEPAK DONGARE  Credit Card Number
XXXX XXXX XXXX XX14
*Total Amount Due ( Rs. )
2,444.00
:
**Minimum Amount Due ( Rs. )
STMT No.  : A25090088247
200.00
Credit Limit ( Rs. )  Cash Limit ( Rs. )  Statement Date
76,000.00  22,000.00  01 Sep 2025
Available Credit Limit ( Rs. )  Available Cash Limit ( Rs. )  Payment Due Date
73,556.48  22,000.00  21 Sep 2025
Transaction Details
Date  Amount ( Rs. )
for Statement Period: 02 Aug 25 to 01 Sep 25
01 Aug 25 CARD CASHBACK CREDIT  2,729.00 C
TRANSACTIONS FOR DEEPAK DONGARE
02 Aug 25 FLIPKART M  Banglore IN  188.00 D
08 Aug 25 Flipkart  Banglore IN  953.00 D
20 Aug 25 EATCLUB BRANDS PRIVATE NOIDA  IN  135.00 D`;
    const r = dispatchStatementParser(text, { sender: "Statements@sbicard.com", statement_type: "card", subject: "Your CASHBACK SBI Card Monthly Statement -Sep 2025" });
    expect(r.ok).toBe(true);
    expect(r.parser_source).toContain("sbi-card-cashback");
    expect(r.fields.total_due).toBe(2444);
    expect(r.fields.min_due).toBe(200);
    expect(r.fields.statement_date).toBe("2025-09-01");
    expect(r.fields.due_date).toBe("2025-09-21");
    expect(r.fields.period_start).toBe("2025-08-02");
    expect(r.fields.period_end).toBe("2025-09-01");
    expect(r.fields.lines).toHaveLength(4);
    expect(r.fields.lines[0].txn_type).toBe("credit");
    expect(r.fields.lines[1].amount).toBe(188);
    expect(r.fields.lines[3].description).toContain("EATCLUB");
  });

  it("hdfc-card extracts dues", () => {
    const text = `HDFC Bank Credit Card Statement
      Statement Date 05/07/2026
      Payment Due Date 22/07/2026
      Total Dues Rs. 45,678.90
      Minimum Amount Due Rs. 2,283.94`;
    const r = dispatchStatementParser(text, { bank_slug: "hdfc", statement_type: "card" });
    expect(r.parser_source).toBe("hdfc-card");
    expect(r.fields.total_due).toBe(45678.9);
    expect(r.fields.due_date).toBe("2026-07-22");
  });

  it("icici-card handles CR refunds and period range", () => {
    const text = `ICICI Bank Credit Card
      Statement Period : 06/06/2026 to 05/07/2026
      Due Date : 22/07/2026
      Total Amount due : Rs. 8,910.00`;
    const r = dispatchStatementParser(text, { bank_slug: "icici", statement_type: "card" });
    expect(r.parser_source).toContain("icici-card");
    expect(r.fields.total_due).toBe(8910);
    expect(r.fields.period_start).toBe("2026-06-06");
  });

  it("amazon-pay-icici flagged via subject", () => {
    const text = `Amazon Pay ICICI Bank Credit Card
      Statement Period : 06/06/2026 to 05/07/2026
      Due Date : 22/07/2026
      Total Amount due : Rs. 3,200.00`;
    const r = dispatchStatementParser(text, { subject: "Your Amazon Pay ICICI Bank Statement", statement_type: "card" });
    expect(r.parser_source).toBe("amazon-pay-icici");
  });

  it("axis-card produces axis-card parser_source", () => {
    const text = `Axis Bank Credit Card Statement
      Statement Date 05/07/2026
      Payment Due Date 22/07/2026
      Total Payment Due Rs. 5,432.10
      Minimum Due Rs. 271.60`;
    const r = dispatchStatementParser(text, { bank_slug: "axis", statement_type: "card" });
    expect(r.parser_source).toContain("axis-card");
    expect(r.fields.total_due).toBe(5432.1);
  });

  it("dispatcher picks bank from subject when no slug given", () => {
    const text = `Statement Date 05/07/2026
      Payment Due Date 22/07/2026
      Total Dues Rs. 100.00`;
    const r = dispatchStatementParser(text, { subject: "HDFC Bank Credit Card Statement", statement_type: "card" });
    expect(r.parser_source).toBe("hdfc-card");
  });
});