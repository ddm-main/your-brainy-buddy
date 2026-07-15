// Parser registry: dispatches statement-PDF text to a bank/card-family
// parser, falling back to the generic heuristic when no specific parser is
// registered or when the specific parser reports too many missing fields.
//
// Adding a new bank is a one-file change:
//   1. drop `<bank>-<type>.ts` alongside this file
//   2. import + register it below
// The dispatcher automatically starts using it.

import type { ParserContext, ParserResult, StatementParser } from "./types.ts";
import { genericParser } from "./generic.ts";
import { sbiCardParser } from "./sbi-card.ts";
import { hdfcCardParser } from "./hdfc-card.ts";
import { hdfcAccountParser } from "./hdfc-account.ts";
import { iciciCardParser } from "./icici-card.ts";
import { iciciAccountParser } from "./icici-account.ts";
import { amazonPayIciciParser } from "./amazon-pay-icici.ts";
import { sbiAccountParser } from "./sbi-account.ts";
import { axisCardParser, airtelAxisCardParser } from "./axis-card.ts";

// Still-stub parsers — kept as generic-with-a-relabel until real fixtures
// arrive. parser_source will read "yes-card (generic)" so it's obvious
// which bank still needs a real regex body.
const yesCardParser: StatementParser   = (t, c) => ({ ...genericParser(t, c), parser_source: "yes-card (generic)" });
const kotakCardParser: StatementParser = (t, c) => ({ ...genericParser(t, c), parser_source: "kotak-card (generic)" });

interface Registration {
  bank: string;
  statement_type: "card" | "account" | "loan";
  parser: StatementParser;
}

const REGISTRY: Registration[] = [
  { bank: "sbi",          statement_type: "card",    parser: sbiCardParser },
  { bank: "sbi",          statement_type: "account", parser: sbiAccountParser },
  { bank: "hdfc",         statement_type: "card",    parser: hdfcCardParser },
  { bank: "hdfc",         statement_type: "account", parser: hdfcAccountParser },
  { bank: "icici",        statement_type: "card",    parser: iciciCardParser },
  { bank: "icici",        statement_type: "account", parser: iciciAccountParser },
  { bank: "amazon-pay-icici", statement_type: "card", parser: amazonPayIciciParser },
  { bank: "axis",         statement_type: "card",    parser: axisCardParser },
  { bank: "airtel-axis",  statement_type: "card",    parser: airtelAxisCardParser },
  { bank: "yes bank",     statement_type: "card",    parser: yesCardParser },
  { bank: "kotak",        statement_type: "card",    parser: kotakCardParser },
];

function normalizeBank(slug: string | null | undefined): string | null {
  return (slug ?? "").toLowerCase().replace(/\s+/g, " ").trim() || null;
}

// Auto-detect bank — subject/sender first (very high signal, e.g. "Amazon
// Pay ICICI Bank Statement"), then in-text anchors as a fallback.
export function detectBank(text: string, ctx: ParserContext): string | null {
  // Normalize underscores/hyphens to spaces so tokens like YES_BANK_,
  // HDFC-Bank, SBI_Card match the same rules as plain forms.
  const hay = `${ctx.subject ?? ""} ${ctx.sender ?? ""}`.toLowerCase().replace(/[_\-]+/g, " ");
  if (hay.trim()) {
    if (/amazon\s*pay.*icici|icici.*amazon\s*pay/.test(hay)) return "amazon-pay-icici";
    if (/airtel.*axis|axis.*airtel/.test(hay)) return "airtel-axis";
    if (/\baxis\b/.test(hay)) return "axis";
    if (/amazon\s*pay/.test(hay) && /icici/.test(hay)) return "amazon-pay-icici";
    if (/\bicici\b/.test(hay)) return "icici";
    if (/millennia|regalia|infinia|diners/.test(hay) || /\bhdfc\b/.test(hay)) return "hdfc";
    if (/sbicard|\bsbi\s*card\b/.test(hay)) return "sbi";
    if (/\bsbi\b/.test(hay)) return "sbi";
    if (/yes\s*bank|yesbank|klick/.test(hay)) return "yes bank";
    if (/\bkotak\b/.test(hay)) return "kotak";
  }
  const t = text.replace(/[_\-]+/g, " ");
  if (/amazon\s*pay.*icici|icici.*amazon\s*pay/i.test(t)) return "amazon-pay-icici";
  if (/airtel.*axis/i.test(t)) return "airtel-axis";
  if (/axis\s*bank/i.test(t)) return "axis";
  if (/icici\s*bank/i.test(t)) return "icici";
  if (/hdfc\s*bank|millennia|regalia|infinia/i.test(t)) return "hdfc";
  if (/sbi\s*(?:card|credit\s*card)|sbicard/i.test(t)) return "sbi";
  if (/yes\s*bank|klick/i.test(t)) return "yes bank";
  if (/kotak/i.test(t)) return "kotak";
  return null;
}

export function dispatchStatementParser(text: string, ctx: ParserContext): ParserResult {
  const bank = normalizeBank(ctx.bank_slug) ?? detectBank(text, ctx);
  const type = ctx.statement_type ?? "card";
  const entry = REGISTRY.find((r) => r.bank === bank && r.statement_type === type);
  if (entry) {
    const specific = entry.parser(text, ctx);
    if (specific.ok || specific.missing_fields.length <= 2) return specific;
    // Specific parser failed hard — fall through to generic and mark that.
    const g = genericParser(text, ctx);
    return { ...g, parser_source: `${specific.parser_source} → generic fallback` };
  }
  return genericParser(text, ctx);
}

export type { ParserResult, ParsedStatementFields, ParserContext, StatementLine } from "./types.ts";
