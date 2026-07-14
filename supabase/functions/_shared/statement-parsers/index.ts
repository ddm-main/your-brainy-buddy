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

// Skeleton parsers — these currently just delegate to `genericParser` but
// exist so the dispatcher's registry surface stays complete. Fill them in
// with real per-bank regex bodies as sample statements arrive; the app will
// already tell you *which* bank needs which parser via `parser_source` +
// `missing_fields` in the parse result.
const hdfcCardParser: StatementParser        = (t, c) => ({ ...genericParser(t, c), parser_source: "hdfc-card (generic)" });
const iciciCardParser: StatementParser       = (t, c) => ({ ...genericParser(t, c), parser_source: "icici-card (generic)" });
const amazonPayIciciParser: StatementParser  = (t, c) => ({ ...genericParser(t, c), parser_source: "amazon-pay-icici (generic)" });
const axisCardParser: StatementParser        = (t, c) => ({ ...genericParser(t, c), parser_source: "axis-card (generic)" });
const yesCardParser: StatementParser         = (t, c) => ({ ...genericParser(t, c), parser_source: "yes-card (generic)" });
const hdfcAccountParser: StatementParser     = (t, c) => ({ ...genericParser(t, c), parser_source: "hdfc-account (generic)" });
const iciciAccountParser: StatementParser    = (t, c) => ({ ...genericParser(t, c), parser_source: "icici-account (generic)" });
const sbiAccountParser: StatementParser      = (t, c) => ({ ...genericParser(t, c), parser_source: "sbi-account (generic)" });

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
  { bank: "airtel-axis",  statement_type: "card",    parser: axisCardParser },
  { bank: "yes bank",     statement_type: "card",    parser: yesCardParser },
];

function normalizeBank(slug: string | null | undefined): string | null {
  return (slug ?? "").toLowerCase().replace(/\s+/g, " ").trim() || null;
}

// Auto-detect bank from statement text when the caller didn't supply a slug.
function detectBankFromText(text: string): string | null {
  if (/amazon\s*pay.*icici|icici.*amazon\s*pay/i.test(text)) return "amazon-pay-icici";
  if (/airtel.*axis/i.test(text)) return "airtel-axis";
  if (/axis\s*bank/i.test(text)) return "axis";
  if (/icici\s*bank/i.test(text)) return "icici";
  if (/hdfc\s*bank/i.test(text)) return "hdfc";
  if (/sbi\s*(?:card|credit\s*card)|sbicard/i.test(text)) return "sbi";
  if (/yes\s*bank/i.test(text)) return "yes bank";
  return null;
}

export function dispatchStatementParser(text: string, ctx: ParserContext): ParserResult {
  const bank = normalizeBank(ctx.bank_slug) ?? detectBankFromText(text);
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
