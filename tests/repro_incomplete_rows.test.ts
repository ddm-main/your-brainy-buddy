import { describe, it, expect } from "vitest";
import { dispatchStatementParser } from "../supabase/functions/_shared/statement-parsers/index.ts";

describe("Reproduction of incomplete live rows", () => {
  it("HDFC: fails when transaction row lacks time", () => {
    const text = `HDFC Bank Credit Card Statement
      Statement Date 05/07/2026
      Payment Due Date 22/07/2026
      Total Dues Rs. 1,000.00
      DATE & TIME  TRANSACTION DESCRIPTION  AMOUNT PI
      31/05/2026 AMAZON SELLER SERVICES  C 1,000.00`;
    const r = dispatchStatementParser(text, { bank_slug: "hdfc", statement_type: "card" });
    expect(r.fields.lines).toHaveLength(1); // Currently this will fail and have 0 lines
  });

  it("HDFC: fails when rupee glyph is not 'C'", () => {
    const text = `HDFC Bank Credit Card Statement
      Statement Date 05/07/2026
      Payment Due Date 22/07/2026
      Total Dues Rs. 1,000.00
      DATE & TIME  TRANSACTION DESCRIPTION  AMOUNT PI
      31/05/2026| 20:38 AMAZON SELLER SERVICES  ₹ 1,000.00`;
    const r = dispatchStatementParser(text, { bank_slug: "hdfc", statement_type: "card" });
    expect(r.fields.lines).toHaveLength(1); // Currently fails because it expects 'C'
  });

  it("YES Bank: loses description part when wrapping without keywords", () => {
    const text = `YES BANK KLICK
      Statement Date : 01/07/2026
      Total Amount Due: Rs. 1,000.00
      Date  Transaction Details  Merchant Category  Amount (Rs.)
      01/06/2026 SOMETHING THAT
      WRAPS TO NEXT LINE  Retail Outlet Services  100.00 Dr`;
    const r = dispatchStatementParser(text, { bank_slug: "yes", statement_type: "card" });
    expect(r.fields.lines[0].description).toContain("WRAPS TO NEXT LINE"); // Currently "WRAPS TO NEXT LINE" is lost or creates separate line
  });

  it("Amazon Pay ICICI: fails when SerialNo or RewardPts are missing", () => {
    const text = `Amazon Pay ICICI Bank Credit Card
      STATEMENT DATE
        July 1, 2026
      PAYMENT DUE DATE
        July 19, 2026
      Total Amount due Rs. 1,000.00
      Transaction Details
      01/06/2026  123456  AMAZON PAY CASHBACK  0  100.00 CR
      02/06/2026  NOPE_SERIAL  AMAZON PAY CASHBACK  0  100.00 CR`;
    const r = dispatchStatementParser(text, { subject: "Your Amazon Pay ICICI Bank Statement", statement_type: "card" });
    // The second row has "NOPE_SERIAL" which doesn't match \d{6,}
    expect(r.fields.lines).toHaveLength(2); 
  });

  it("SBI: fails when marker (Cr/Dr) is missing", () => {
    const text = `SBI Card Statement
      Statement Date : 05/07/2026
      Payment Due Date : 25/07/2026
      Total Amount Due : Rs. 1,000.00
      02/06/2026 AMAZON SELLER SERVICES 1000.00`;
    const r = dispatchStatementParser(text, { bank_slug: "sbi", statement_type: "card" });
    expect(r.fields.lines).toHaveLength(1); // Currently 0 because it expects Dr/Cr/C/D
  });
});
