import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchStatementParser } from "../supabase/functions/_shared/statement-parsers/index.ts";
import { detectBank } from "../supabase/functions/_shared/statement-parsers/index.ts";
import { parseSubjectPeriod } from "../supabase/functions/_shared/subject-period.ts";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/statements", name), "utf8");

describe("statement parsers — real PDF fixtures", () => {
  it("sbi-cashback: anchors last4 on the Credit Card Number label, not footer '2999'", () => {
    const r = dispatchStatementParser(fixture("sbi-cashback.txt"), { bank_slug: "sbi", statement_type: "card", subject: "SBI Cashback statement" });
    expect(r.ok).toBe(true);
    expect(r.fields.card_last4).toBe("14");
    expect(r.fields.total_due).toBe(4389);
    expect(r.fields.min_due).toBe(100);
    expect(r.fields.due_date).toBe("2026-07-21");
    expect(r.fields.credit_limit).toBe(76000);
  });
  it("sbi-bpcl: last4 = 62 and NO PAYMENT REQUIRED zeroes the total", () => {
    const r = dispatchStatementParser(fixture("sbi-bpcl.txt"), { bank_slug: "sbi", statement_type: "card", subject: "SBI BPCL statement" });
    expect(r.fields.card_last4).toBe("62");
    expect(r.fields.total_due).toBe(0);
  });
  it("hdfc-millennia: extracts total / min / credit limit from the 2-row columnar summary", () => {
    const r = dispatchStatementParser(fixture("hdfc-millennia.txt"), { bank_slug: "hdfc", statement_type: "card", subject: "HDFC Millennia" });
    expect(r.ok).toBe(true);
    expect(r.fields.total_due).toBe(7459);
    expect(r.fields.min_due).toBe(380);
    expect(r.fields.credit_limit).toBe(225000);
    expect(r.fields.due_date).toBe("2026-07-18");
  });
  it("hdfc-millennia (real pdf.js output): extracts all 3 transactions from Jun-2026 fixture", () => {
    const r = dispatchStatementParser(
      fixture("raw/hdfc-millennia-jun2026-pdfjs.txt"),
      { bank_slug: "hdfc", statement_type: "card", subject: "Fwd: Your HDFC Bank - Millennia Credit Card Statement - June-2026" },
    );
    expect(r.ok).toBe(true);
    expect(r.fields.due_date).toBe("2026-07-18");
    expect(r.fields.total_due).toBe(7459);
    expect(r.fields.lines).toHaveLength(3);
    const amounts = r.fields.lines.map((l) => l.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([30, 2505.46, 5119.8]);
    const dates = r.fields.lines.map((l) => l.date).sort();
    expect(dates).toEqual(["2026-05-31", "2026-05-31", "2026-06-07"]);
    // Descriptions include the merchant even when the EMI badge is present.
    expect(r.fields.lines.some((l) => /DMART AVENUE SUPERMART/i.test(l.description))).toBe(true);
    expect(r.fields.lines.some((l) => /AVENUE FOOD PLAZA/i.test(l.description))).toBe(true);
    expect(r.fields.lines.some((l) => /Turtlemint/i.test(l.description))).toBe(true);
  });
  it("icici-credit-card: does NOT leak Oct 26, 2023 footer date into due_date", () => {
    const r = dispatchStatementParser(fixture("icici-credit-card.txt"), { bank_slug: "icici", statement_type: "card", subject: "ICICI credit card" });
    expect(r.ok).toBe(true);
    expect(r.fields.due_date).toBe("2026-07-19");
    expect(r.fields.due_date).not.toBe("2025-10-26");
    expect(r.fields.total_due).toBe(678);
    expect(r.fields.min_due).toBe(100);
    expect(r.fields.credit_limit).toBe(440000);
  });
  it("amazon-pay-icici fixture: same footer-date guard", () => {
    const r = dispatchStatementParser(fixture("amazon-pay-icici.txt"), { subject: "Your Amazon Pay ICICI Bank Statement", statement_type: "card" });
    expect(r.fields.due_date).toBe("2026-07-19");
    expect(r.fields.due_date).not.toBe("2025-10-26");
  });
  it("icici-savings: back-fills descriptions from lines above the anchor row", () => {
    const r = dispatchStatementParser(fixture("icici-savings.txt"), { bank_slug: null, statement_type: null, subject: "ICICI Bank Statement" });
    expect(r.fields.lines.length).toBeGreaterThanOrEqual(12);
    expect(r.fields.closing_balance).toBe(23683.39);
  });
});

// End-to-end fixtures captured from Deepak's real bank/card PDFs (2026-07):
// see tests/fixtures/statements/pdf/ for the encrypted source and
// tests/fixtures/statements/raw/ for the pdftotext -layout output used
// here. If a bank changes its template, regenerate the raw file with:
//   qpdf --password=<pwd> --decrypt in.pdf out.pdf && pdftotext -layout out.pdf raw/<name>.txt
describe("statement parsers — captured real PDFs", () => {
  const raw = (name: string) => readFileSync(join(__dirname, "fixtures/statements/raw", name), "utf8");

  it("sbi-cashback (real)", () => {
    const r = dispatchStatementParser(raw("180519944814_SBI_Cashback_CreditCard.txt"), { bank_slug: "sbi", statement_type: "card", subject: "SBI Cashback statement" });
    expect(r.ok).toBe(true);
    expect(r.fields.statement_date).toBe("2026-07-01");
    expect(r.fields.due_date).toBe("2026-07-21");
    expect(r.fields.total_due).toBe(4389);
    expect(r.fields.lines.length).toBeGreaterThan(10);
  });
  it("sbi-bpcl (real)", () => {
    const r = dispatchStatementParser(raw("180519946662_SBI_CreditCard_BPCL.txt"), { bank_slug: "sbi", statement_type: "card", subject: "SBI BPCL statement" });
    expect(r.ok).toBe(true);
    expect(r.fields.statement_date).toBe("2026-07-02");
    expect(r.fields.total_due).toBe(0);
    expect(r.fields.card_last4).toBe("62");
  });
  it("hdfc-millennia (real)", () => {
    const r = dispatchStatementParser(raw("DEEP1805_HDFC_CreditCard.txt"), { bank_slug: "hdfc", statement_type: "card", subject: "HDFC Millennia" });
    expect(r.ok).toBe(true);
    expect(r.fields.statement_date).toBe("2026-06-28");
    expect(r.fields.due_date).toBe("2026-07-18");
    expect(r.fields.total_due).toBe(7459);
    expect(r.fields.card_last4).toBe("6560");
    expect(r.fields.lines.length).toBeGreaterThan(0);
  });
  it("yes-klick (real)", () => {
    const r = dispatchStatementParser(raw("DEEP1805_YesBank_CreditCard.txt"), { bank_slug: "yes", statement_type: "card", subject: "YES Bank Klick" });
    expect(r.ok).toBe(true);
    expect(r.fields.total_due).toBe(17930.32);
    expect(r.fields.due_date).toBe("2026-07-21");
    expect(r.fields.lines.length).toBeGreaterThanOrEqual(60);
  });
  it("amazon-pay-icici (real)", () => {
    const r = dispatchStatementParser(raw("deep1805_ICICI_CreditCard.txt"), { statement_type: "card", subject: "Amazon Pay ICICI Bank Statement" });
    expect(r.ok).toBe(true);
    expect(r.fields.statement_date).toBe("2026-07-01");
    expect(r.fields.due_date).toBe("2026-07-19");
    expect(r.fields.total_due).toBe(678);
    expect(r.fields.card_last4).toBe("6003");
  });
  it("axis-airtel (real)", () => {
    const r = dispatchStatementParser(raw("DEEP1805_AxisBank.txt"), { bank_slug: "axis", statement_type: "card", subject: "Airtel Axis Bank" });
    expect(r.ok).toBe(true);
    expect(r.fields.total_due).toBe(26424.67);
    expect(r.fields.due_date).toBe("2026-07-05");
    expect(r.fields.lines.length).toBeGreaterThan(100);
  });
  it("icici-savings (real)", () => {
    const r = dispatchStatementParser(raw("deep1805_ICICIBANK.txt"), { statement_type: "account", subject: "ICICI Bank Statement" });
    expect(r.ok).toBe(true);
    expect(r.fields.card_last4).toBe("3037");
    expect(r.fields.lines.length).toBeGreaterThan(10);
  });
  it("kotak-savings (real)", () => {
    const r = dispatchStatementParser(raw("deep1805_KotakBank.txt"), { statement_type: "account", subject: "Kotak Bank Statement" });
    expect(r.ok).toBe(true);
    expect(r.fields.lines.length).toBeGreaterThan(30);
  });
});

describe("statement parsers", () => {
  it("yes-card parses YES Bank Klick statement fields and merchant categories", () => {
    const text = `Credit Card Statement
YES BANK KLICK
Overview  Statement Summary
Statement for YES BANK Card Number 3561XXXXXXXX0337
Statement Period:  Credit Limit:
02/06/2026 To 01/07/2026  Rs. 2,79,000.00  Current Purchases / Cash Advance
Statement Date : 01/07/2026
Rs. 2,60,909.68  Rs. 17,930.32 Dr
Total Amount Due:  Cash Limit:  Points Earned : 0
Rs. 17,930.32  Rs. 0.00
Minimum Amount Due:  Available Cash Limit:  Rs. 32,773.82 Cr
Rs. 358.61  Rs. 0.00
Payment Due Date: 21/07/2026  Other Mode
Statement Details
Date  Transaction Details  Merchant Category  Amount (Rs.)
01/06/2026 UPI_MR SAGAR SAGAR SK IND - Ref No: RT261530396001420000495  Retail Outlet Services  100.00 Dr
02/06/2026 UPI_HERO WINES IND - Ref No: RT261540397001480000126  Miscellaneous Stores  240.00 Dr
06/06/2026 UPI_KIWI SUBSCRIPTION EE IND - Ref No: RT261570396000340000825 Business Services  1,178.82 Dr`;
    const r = dispatchStatementParser(text, { subject: "Fwd: Your YES_BANK_Klick Credit Card E-Statement", statement_type: "card" });
    expect(r.ok).toBe(true);
    expect(r.parser_source).toBe("yes-card");
    expect(r.fields.card_last4).toBe("0337");
    expect(r.fields.period_start).toBe("2026-06-02");
    expect(r.fields.period_end).toBe("2026-07-01");
    expect(r.fields.statement_date).toBe("2026-07-01");
    expect(r.fields.due_date).toBe("2026-07-21");
    expect(r.fields.total_due).toBe(17930.32);
    expect(r.fields.min_due).toBe(358.61);
    expect(r.fields.credit_limit).toBe(279000);
    expect(r.fields.lines).toHaveLength(3);
    expect(r.fields.lines[0].merchant_category).toBe("Retail Outlet Services");
    expect(r.fields.lines[1].reference_number).toBe("RT261540397001480000126");
  });

  it("axis-card parses Airtel Axis Rupay KLICK-style tabular layout (no colons, Dr/Cr markers, ALL-CAPS categories)", () => {
    // pdftotext output from an Airtel Axis Bank Rupay Credit Card statement
    // (June 2026 cycle). Modern Axis co-brand statements use the same
    // two-row PAYMENT SUMMARY table as YES Bank KLICK — labels row followed
    // by values row, no colons, Dr/Cr markers on amounts.
    const text = `Airtel Axis Bank Rupay Credit Card
DEEPAK SUBHASH DONGARE
PAYMENT SUMMARY
Total Payment Due   Minimum Payment Due   Statement Period          Payment Due Date  Statement Generation Date
26,424.67 Dr        540.00 Dr             17/05/2026 - 15/06/2026   05/07/2026        15/06/2026
Credit Card Number  Credit Limit  Available Credit Limit  Available Cash Limit
653036******2605    155,000.00    128,575.33              15,500.00
Account Summary
Date  Transaction Details  Merchant Category  Amount (Rs.)
Card No:  653036******2605       Name  DEEPAK SUBHASH DONGARE
16/05/2026 UPI/ALANKAR JEWELLERS/Q274311760@YBL/8425062561  JEWELLERY  12,100.00 Dr
17/05/2026 UPI/NANEKAR DAIRY/PAYTMQR6FHY00@PTYS/8425062561  FOOD PRODUCTS  60.00 Dr
18/05/2026 FUEL CASHBACK REBATES  8.87 Cr
20/05/2026 UPI/KAVITA PRAVIN KATE/Q053860584@YBL/842506256  UTILITIES  10.00 Dr
22/05/2026 UPI/LEELA RANJEET CHOUDHARY/Q744880675@YBL/8425  SERVICES  20.00 Dr`;
    const r = dispatchStatementParser(text, { subject: "Fwd: Airtel Axis Bank Rupay Credit Card ending XX05 - June 2026", statement_type: "card" });
    expect(r.parser_source).toBe("axis-card-airtel");
    expect(r.fields.card_last4).toBe("2605");
    expect(r.fields.period_start).toBe("2026-05-17");
    expect(r.fields.period_end).toBe("2026-06-15");
    expect(r.fields.statement_date).toBe("2026-06-15");
    expect(r.fields.due_date).toBe("2026-07-05");
    expect(r.fields.total_due).toBe(26424.67);
    expect(r.fields.min_due).toBe(540);
    expect(r.fields.credit_limit).toBe(155000);
    expect(r.fields.lines.length).toBeGreaterThanOrEqual(5);
    expect(r.fields.lines[0].merchant_category).toBe("JEWELLERY");
    expect(r.fields.lines[0].amount).toBe(12100);
    expect(r.fields.lines[0].txn_type).toBe("debit");
    // Cashback credit row parsed as credit
    const cashback = r.fields.lines.find((l) => /CASHBACK/i.test(l.description));
    expect(cashback?.txn_type).toBe("credit");
    expect(r.ok).toBe(true);
  });



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

  it("hdfc-card recovers Millennia pdfjs summary layout", () => {
    const text = `Millennia Credit Card Statement
HDFC Bank Credit Cards GSTIN: 33AAACH2702H2Z6
DEEPAK DONGARE  Credit Card No.  434155XXXXXX6560
Statement Date  28 Jun, 2026
Billing Period  29 May, 2026 - 28 Jun, 2026
PAYMENTS/CREDITS  PURCHASES/DEBIT
PREVIOUS STATEMENT DUES  FINANCE CHARGES  TOTAL AMOUNT DUE
RECEIVED  (Current Billing Cycle)
_
C -,196.33  C 0.00  +  C 7,655.26  +  C 0.00  = C 7,459.00
TOTAL CREDIT LIMIT
AVAILABLE CREDIT LIMIT  AVAILABLE CASH LIMIT
MINIMUM DUE  DUE DATE
(Including Cash)
C 380.00  18 Jul, 2026
C 2,25,000  C 2,17,541  C 90,000
Domestic Transactions
DATE & TIME  TRANSACTION DESCRIPTION  AMOUNT PI
31/05/2026| 20:38 EMI DMART AVENUE SUPERMARTSPUNE  C 2,505.46
07/06/2026| 10:28 EMI RAZ*Turtlemint Insuranc Mumbai  C 5,119.80 l`;
    const r = dispatchStatementParser(text, { bank_slug: "hdfc", statement_type: "card", subject: "HDFC Millennia June 2026" });
    expect(r.ok).toBe(true);
    expect(r.fields.statement_date).toBe("2026-06-28");
    expect(r.fields.due_date).toBe("2026-07-18");
    expect(r.fields.total_due).toBe(7459);
    expect(r.fields.credit_limit).toBe(225000);
    expect(r.fields.card_last4).toBe("6560");
    expect(r.fields.lines.length).toBeGreaterThanOrEqual(2);
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

  it("subject fallback: ICICI account long-form period", () => {
    const r = parseSubjectPeriod("Fwd: ICICI Bank Statement from June 01, 2026 to June 30, 2026 for XXXXXXXX3037");
    expect(r.period_start).toBe("2026-06-01");
    expect(r.period_end).toBe("2026-06-30");
    expect(r.statement_date).toBe("2026-06-30");
  });

  it("subject fallback: HDFC account hyphen-dated period", () => {
    const r = parseSubjectPeriod("HDFC Bank e-Statement for the period 09-Jun-2026 TO 08-Jul-2026");
    expect(r.period_start).toBe("2026-06-09");
    expect(r.period_end).toBe("2026-07-08");
    expect(r.statement_date).toBe("2026-07-08");
  });

  it("subject fallback: Kotak month-only rolls to full month", () => {
    const r = parseSubjectPeriod("Your June 2026 statement for Kotak A/c X9894");
    expect(r.period_start).toBe("2026-06-01");
    expect(r.period_end).toBe("2026-06-30");
    expect(r.statement_date).toBe("2026-06-30");
  });

  it("subject fallback: Amazon Pay ICICI card long-form period", () => {
    const r = parseSubjectPeriod("Your Amazon Pay ICICI Bank statement for the period June 2, 2026 to July 1, 2026");
    expect(r.period_start).toBe("2026-06-02");
    expect(r.period_end).toBe("2026-07-01");
  });
});

describe("detectBank — forwarder alias skiplist", () => {
  it("ignores ddongarecc forwarder and matches HDFC from subject", () => {
    const bank = detectBank("nothing bank-ish in body", {
      subject: "Fwd: Your HDFC Bank Credit Card Statement",
      sender: "ddongarecc@gmail.com",
    });
    expect(bank).toBe("hdfc");
  });
  it("ignores 52-cc forwarder and matches YES bank from body text", () => {
    const bank = detectBank("YES BANK Klick Credit Card e-statement", {
      subject: "Fwd: Statement",
      sender: "52-cc@myforwarder.com",
    });
    expect(bank).toBe("yes bank");
  });
});

// Regression: skeleton apply path must not leak STMT No. digits into min_due
// and must honour "NO PAYMENT REQUIRED" for both due_date and dues on
// SBI BPCL zero-balance months. See gap-audit 2026-07-16.
import { applySkeleton, synthesizeSkeletonFromResult } from "../supabase/functions/_shared/statement-skeleton.ts";
import { sbiCardParser } from "../supabase/functions/_shared/statement-parsers/sbi-card.ts";

describe("skeleton apply path — SBI BPCL NO PAYMENT REQUIRED", () => {
  const raw = (name: string) => readFileSync(join(__dirname, "fixtures/statements/raw", name), "utf8");

  it("sbi-bpcl (skeleton apply): zeroes min_due/total_due and mirrors due_date to statement_date", () => {
    const text = raw("180519946662_SBI_CreditCard_BPCL.txt");
    const ctx = { bank_slug: "sbi", statement_type: "card" as const, subject: "SBI BPCL statement" };
    const parsed = sbiCardParser(text, ctx);
    const skeleton = synthesizeSkeletonFromResult({
      bank_slug: "sbi",
      statement_type: "card",
      parser_source: parsed.parser_source,
      result: parsed,
    });
    const applied = applySkeleton(text, skeleton);
    expect(applied.min_due).toBe(0);
    expect(applied.total_due).toBe(0);
    expect(applied.statement_date).toBe("2026-07-02");
    expect(applied.due_date).toBe("2026-07-02");
  });

  it("sbi-cashback (skeleton apply): real dues survive the sanitizer", () => {
    const text = raw("180519944814_SBI_Cashback_CreditCard.txt");
    const ctx = { bank_slug: "sbi", statement_type: "card" as const, subject: "SBI Cashback statement" };
    const parsed = sbiCardParser(text, ctx);
    const skeleton = synthesizeSkeletonFromResult({
      bank_slug: "sbi",
      statement_type: "card",
      parser_source: parsed.parser_source,
      result: parsed,
    });
    const applied = applySkeleton(text, skeleton);
    expect(applied.total_due).toBe(4389);
    expect(applied.due_date).toBe("2026-07-21");
    expect(applied.statement_date).toBe("2026-07-01");
    // must not leak a huge STMT-No-sized number
    expect(applied.min_due! < 100000).toBe(true);
  });
});
