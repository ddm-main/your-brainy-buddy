// Parser registry: dispatches statement-PDF text to a bank/card-family
// parser, falling back to the generic heuristic when no specific parser is
// registered or when the specific parser reports too many missing fields.

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
import { yesCardParser } from "./yes-card.ts";
import { kotakAccountParser } from "./kotak-account.ts";
import { sniffStatementType } from "./shared.ts";

/**
 * Bump when any registered parser materially changes its output. Cached
 * `statement_skeletons` rows written by an older parser are discarded on
 * load so the next parse re-learns the layout.
 */
export const PARSER_VERSION = 4;

// Sender aliases used by users who forward statements from an intermediate
// mailbox. When the raw sender is one of these, ignore it in `detectBank`
// and rely entirely on subject + PDF text.
// Match only known personal-forwarder mailbox patterns — never a real bank
// alias. `sbicard`, `bank`, `statements` (plain plural) etc. must fall
// through to the normal detection path.
const FORWARDER_SENDER_ALIASES = /(^|<|\s)(?:\d{2,3}[-_]cc|ddongarecc|\d+statement\d*|statement\d+|fwd\w*|forwarder\w*)@/i;

const kotakCardParser: StatementParser = (t, c) => ({ ...genericParser(t, c), parser_source: "kotak-card (generic)" });

interface Registration {
  bank: string;
  statement_type: "card" | "account" | "loan";
  parser: StatementParser;
}

const REGISTRY: Registration[] = [
  { bank: "sbi",              statement_type: "card",    parser: sbiCardParser },
  { bank: "sbi",              statement_type: "account", parser: sbiAccountParser },
  { bank: "hdfc",             statement_type: "card",    parser: hdfcCardParser },
  { bank: "hdfc",             statement_type: "account", parser: hdfcAccountParser },
  { bank: "icici",            statement_type: "card",    parser: iciciCardParser },
  { bank: "icici",            statement_type: "account", parser: iciciAccountParser },
  { bank: "amazon-pay-icici", statement_type: "card",    parser: amazonPayIciciParser },
  { bank: "axis",             statement_type: "card",    parser: axisCardParser },
  { bank: "airtel-axis",      statement_type: "card",    parser: airtelAxisCardParser },
  { bank: "yes bank",         statement_type: "card",    parser: yesCardParser },
  { bank: "kotak",            statement_type: "card",    parser: kotakCardParser },
  { bank: "kotak",            statement_type: "account", parser: kotakAccountParser },
];

function normalizeBank(slug: string | null | undefined): string | null {
  const normalized = (slug ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized === "yes" || normalized === "yesbank") return "yes bank";
  return normalized;
}

export function detectBank(text: string, ctx: ParserContext): string | null {
  const senderRaw = ctx.sender ?? "";
  const senderSafe = FORWARDER_SENDER_ALIASES.test(senderRaw) ? "" : senderRaw;
  const hay = `${ctx.subject ?? ""} ${senderSafe}`.toLowerCase().replace(/[_\-]+/g, " ");
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
    if (/\bkotak\b|kkbk/.test(hay)) return "kotak";
  }
  const t = text.replace(/[_\-]+/g, " ");
  if (/amazon\s*pay.*icici|icici.*amazon\s*pay|help\.amazonpaycc@icicibank/i.test(t)) return "amazon-pay-icici";
  if (/airtel\s*axis.*rupay|airtel.*axis/i.test(t)) return "airtel-axis";
  if (/axis\s*bank/i.test(t)) return "axis";
  if (/icici\s*bank/i.test(t)) return "icici";
  if (/hdfc\s*bank|millennia|regalia|infinia/i.test(t)) return "hdfc";
  if (/sbi\s*(?:card|credit\s*card)|sbicard/i.test(t)) return "sbi";
  if (/yes\s*bank|klick/i.test(t)) return "yes bank";
  if (/kotak\s*mahindra|kkbk\d{4,}/i.test(t)) return "kotak";
  return null;
}

export function dispatchStatementParser(text: string, ctx: ParserContext): ParserResult {
  const bank = normalizeBank(ctx.bank_slug) ?? detectBank(text, ctx);
  // If caller didn't specify, sniff type from the PDF text — accounts must
  // NOT be routed through card parsers (and vice versa).
  const type: "card" | "account" | "loan" = ctx.statement_type ?? sniffStatementType(text);
  const entry = REGISTRY.find((r) => r.bank === bank && r.statement_type === type);
  if (entry) {
    const specific = entry.parser(text, ctx);
    // Wrong-type sentinel: an ICICI card parser sniffs an account PDF and
    // asks for retry via the sibling account parser (or vice versa).
    if (specific.missing_fields.includes("_wrong_type_account")) {
      const acct = REGISTRY.find((r) => r.bank === bank && r.statement_type === "account");
      if (acct) return acct.parser(text, ctx);
    }
    if (specific.missing_fields.includes("_wrong_type_card")) {
      const card = REGISTRY.find((r) => r.bank === bank && r.statement_type === "card");
      if (card) return card.parser(text, ctx);
    }
    if (specific.ok) return specific;
    const specificMissing = specific.missing_fields.filter((field) => !field.startsWith("_"));
    if (specificMissing.length <= 2) {
      const g = genericParser(text, { ...ctx, statement_type: type });
      const genericMissing = g.missing_fields.filter((field) => !field.startsWith("_"));
      if (g.ok || genericMissing.length < specificMissing.length) {
        return { ...g, parser_source: `${specific.parser_source} → generic fallback` };
      }
      return specific;
    }
    const g = genericParser(text, { ...ctx, statement_type: type });
    return { ...g, parser_source: `${specific.parser_source} → generic fallback` };
  }
  return genericParser(text, { ...ctx, statement_type: type });
}

export type { ParserResult, ParsedStatementFields, ParserContext, StatementLine } from "./types.ts";
