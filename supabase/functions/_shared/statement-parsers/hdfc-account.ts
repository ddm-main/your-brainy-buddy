// HDFC Bank savings/current account passbook parser. Standard 7-column
// layout: Date | Narration | Chq/Ref | Value Dt | Withdrawal | Deposit |
// Closing Balance.

import type { ParserContext, ParserResult } from "./types.ts";
import { genericExtract, reportMissing } from "./generic.ts";

function toAmount(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = raw.match(/([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

export const hdfcAccountParser = (text: string, _ctx: ParserContext): ParserResult => {
  const base = genericExtract(text);
  const closing = text.match(/closing\s*balance\s*[:\s]*(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  const fields = {
    ...base,
    closing_balance: closing ? toAmount(closing[1]) : base.closing_balance,
  };
  const missing = reportMissing(fields, ["period_start", "period_end"]);
  return {
    ok: missing.length === 0 && fields.lines.length > 0,
    fields,
    parser_source: "hdfc-account",
    confidence: fields.lines.length > 0 ? 0.8 : 0.5,
    missing_fields: missing,
  };
};