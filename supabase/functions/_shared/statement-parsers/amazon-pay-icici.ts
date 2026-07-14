// Amazon Pay ICICI card — same layout as vanilla ICICI cards, flagged
// separately so parser_source reflects the specific card family.

import type { ParserContext, ParserResult } from "./types.ts";
import { iciciCardParser } from "./icici-card.ts";

export const amazonPayIciciParser = (text: string, ctx: ParserContext): ParserResult => {
  const r = iciciCardParser(text, { ...ctx, card_family: "amazon-pay" });
  return { ...r, parser_source: "amazon-pay-icici" };
};