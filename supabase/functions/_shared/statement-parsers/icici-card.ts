// ICICI Bank credit card statement parser.
//
// The vanilla ICICI credit-card PDF and the Amazon Pay ICICI co-brand use
// the same layout: labels stack over values in a left column, a
// STATEMENT SUMMARY tabular block sits below (separated by `= + + + -`
// operators), backtick (`) is rendered instead of ₹, and a MITC footer
// table further down contains sample amounts (`Total Amount Due on
// statement dated Oct 08, 2023` etc.) that must NOT leak into extraction.
//
// We delegate the heavy lifting to `amazonPayIciciParser` so both parsers
// stay behaviourally identical, but we override `parser_source` and keep
// the wrong-type sentinel so the dispatcher can retry with iciciAccount.

import type { ParserContext, ParserResult } from "./types.ts";
import { genericExtract } from "./generic.ts";
import { amazonPayIciciParser } from "./amazon-pay-icici.ts";

function looksLikeAccount(text: string): boolean {
  const head = text.slice(0, 5000);
  const savings = /Savings\s*A\/c\s*X{2,}\d{4}|Savings\s*Account\s*(?:X{4,}|\d{4,})/i.test(head);
  const noCard = !/Credit\s*Card\s*(?:No\.?|Number)/i.test(head);
  return savings && noCard;
}

export const iciciCardParser = (text: string, ctx: ParserContext): ParserResult => {
  if (looksLikeAccount(text)) {
    return {
      ok: false,
      fields: genericExtract(text, ctx.statement_year ?? null),
      parser_source: "icici-card",
      confidence: 0.1,
      missing_fields: ["_wrong_type_account"],
    };
  }
  const family = ctx.card_family ? `-${ctx.card_family}` : "";
  const inner = amazonPayIciciParser(text, ctx);
  return { ...inner, parser_source: `icici-card${family}` };
};
