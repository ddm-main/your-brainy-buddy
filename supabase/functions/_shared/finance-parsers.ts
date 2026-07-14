// Banking-email heuristics: turn a synced Gmail message into structured
// finance records (transaction / statement / EMI / investment). Regex-first.
// If none match with sufficient confidence, callers may fall back to an AI
// pass; parsers here purposefully avoid the LLM for cheap, deterministic work.

import { FINANCE_DOMAINS } from "./finance-senders.ts";

export type ParsedKind = "transaction" | "statement" | "investment" | "emi";

export interface ParsedTxn {
  kind: "transaction" | "investment" | "emi";
  amount: number;
  txn_type: "debit" | "credit";
  merchant: string | null;
  category: string | null;
  txn_date: string; // YYYY-MM-DD
  reference_number: string | null;
  last4: string | null;
  confidence: number; // 0..1
}

export interface ParsedStmt {
  kind: "statement";
  statement_type: "account" | "card" | "loan";
  statement_date: string | null; // YYYY-MM-DD
  period_start: string | null;
  period_end: string | null;
  last4: string | null;
  confidence: number;
}

export type Parsed = ParsedTxn | ParsedStmt;

const CURRENCY = /(?:INR|Rs\.?|₹|USD|\$)/i;
const AMOUNT_RX = new RegExp(
  `${CURRENCY.source}\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)`,
  "i",
);
const LAST4_RXES = [
  /(?:ending(?:\s+with)?|a\/c\s*\S*|card\s*\S*)\s*(?:x{2,}|X{2,}|\*{2,}|\d{2,}\s*)+(\d{2,4})\b/i,
  /(?:x{2,}|X{2,}|\*{2,})\s*(\d{2,4})\b/i,
  /\b(?:ending|ends)\s+(?:in|with)\s+(\d{2,4})\b/i,
  // SBI / HDFC space-separated masking: "XX 62", "XXXX 4814", "Card no. XX 62"
  /\b(?:x{2,}|X{2,}|\*{2,})\s+(\d{2,4})\b/,
  /\bcard\s*no\.?\s*(?:x{2,}|X{2,}|\*{2,})\s*(\d{2,4})\b/i,
  /\ba\/c\s*(?:no\.?)?\s*[.\-\s]*\d*\D+(\d{4})\b/i,
];

const REF_RX = /(?:ref(?:erence)?(?:\s*no\.?|\s*id)?|utr|txn\s*id|transaction\s*id)[:# ]*([A-Z0-9-]{6,})/i;

const DEBIT_HINTS = /\b(debited|spent|paid|purchase|withdrawn|debit alert|txn of|charged)\b/i;
const CREDIT_HINTS = /\b(credited|received|deposited|refund|reversal|credit alert)\b/i;
const STATEMENT_HINTS = /\b(statement (?:is )?(?:generated|available|ready)|monthly statement|e-?statement|account statement|card statement)\b/i;
const EMI_HINTS = /\b(emi|equated monthly instal?ment|loan (?:emi|payment)|installment)\b/i;
const SIP_HINTS = /\b(sip|mutual fund|folio|purchase confirmation|units allotted|nav|portfolio|cas|consolidated account statement)\b/i;
const CARD_BILL_HINTS = /\b(credit card bill|card bill|bill payment)\b/i;

function num(s: string): number {
  return Number(s.replace(/,/g, ""));
}

function todayIso(fallback?: string | null): string {
  const d = fallback ? new Date(fallback) : new Date();
  return isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

export function isFinanceSender(fromEmail?: string | null): boolean {
  if (!fromEmail) return false;
  const dom = fromEmail.split("@")[1]?.toLowerCase().trim();
  if (!dom) return false;
  return FINANCE_DOMAINS.some((d) => dom === d || dom.endsWith("." + d));
}

// Map a sender email domain to a coarse bank slug for display / bank-link
// heuristics. Not authoritative — just enough to show "HDFC" instead of
// blank on rows where no card/account was matched.
const BANK_SLUG_MAP: Array<[RegExp, string]> = [
  [/(^|\.)hdfcbank\.(com|net)$/i, "HDFC"],
  [/(^|\.)emailstatements\.hdfcbank\.com$/i, "HDFC"],
  [/(^|\.)icicibank\.com$/i, "ICICI"],
  [/(^|\.)amazonpay\.icicibank\.com$/i, "Amazon Pay ICICI"],
  [/(^|\.)axisbank\.com$/i, "Axis"],
  [/(^|\.)airtel-axisbank\.com$/i, "Airtel Axis"],
  [/(^|\.)(sbi\.co\.in|onlinesbi\.sbi|alerts\.sbi)$/i, "SBI"],
  [/(^|\.)sbicard\.com$/i, "SBI"],
  [/(^|\.)kotak\.com$/i, "Kotak"],
  [/(^|\.)yesbank\.in$/i, "Yes Bank"],
  [/(^|\.)idfcfirstbank\.com$/i, "IDFC First"],
  [/(^|\.)aubank\.in$/i, "AU"],
  [/(^|\.)indusind\.com$/i, "IndusInd"],
  [/(^|\.)(americanexpress|aexp)\.com$/i, "American Express"],
  [/(^|\.)citibank\.com$/i, "Citi"],
  [/(^|\.)hsbc\.co\.in$/i, "HSBC"],
  [/(^|\.)chase\.com$/i, "Chase"],
  [/(^|\.)bankofamerica\.com$/i, "Bank of America"],
  [/(^|\.)wellsfargo\.com$/i, "Wells Fargo"],
  [/(^|\.)capitalone\.com$/i, "Capital One"],
  [/(^|\.)discover\.com$/i, "Discover"],
];

export function guessBankSlugFromSender(fromEmail?: string | null): string | null {
  if (!fromEmail) return null;
  const dom = fromEmail.split("@")[1]?.toLowerCase().trim();
  if (!dom) return null;
  return BANK_SLUG_MAP.find(([rx]) => rx.test(dom))?.[1] ?? null;
}

export function isFinanceMail(opts: {
  from_email?: string | null;
  subject?: string | null;
  snippet?: string | null;
}): boolean {
  if (isFinanceSender(opts.from_email)) return true;
  const hay = `${opts.subject ?? ""}\n${opts.snippet ?? ""}`;
  return (
    STATEMENT_HINTS.test(hay) ||
    EMI_HINTS.test(hay) ||
    SIP_HINTS.test(hay) ||
    CARD_BILL_HINTS.test(hay) ||
    (AMOUNT_RX.test(hay) && (DEBIT_HINTS.test(hay) || CREDIT_HINTS.test(hay)))
  );
}

export function parseFinanceEmail(email: {
  from_email?: string | null;
  from_name?: string | null;
  subject?: string | null;
  snippet?: string | null;
  body_text?: string | null;
  received_at?: string | null;
}): Parsed | null {
  const text = [email.subject ?? "", email.snippet ?? "", email.body_text ?? ""]
    .join("\n")
    .replace(/\r/g, "");
  if (!text.trim()) return null;

  const last4 = LAST4_RXES.map((rx) => text.match(rx)?.[1]).find(Boolean) ?? null;
  const refMatch = text.match(REF_RX)?.[1] ?? null;
  const date = todayIso(email.received_at);

  // ---- Statement (highest priority when the subject says so) ------------
  if (STATEMENT_HINTS.test(email.subject ?? "") || STATEMENT_HINTS.test(text)) {
    let statement_type: "account" | "card" | "loan" = "account";
    const sender = `${email.from_email ?? ""} ${email.from_name ?? ""}`;
    if (/sbicard\.com/i.test(sender) || /\b(credit\s*card|card\s*statement|card bill)\b/i.test(text) || (/\bcard\b/i.test(text) && /\bstatement\b/i.test(text))) statement_type = "card";
    else if (/\bloan\s*statement\b/i.test(text)) statement_type = "loan";
    return {
      kind: "statement",
      statement_type,
      statement_date: date,
      period_start: null,
      period_end: null,
      last4,
      confidence: 0.75,
    };
  }

  // ---- EMI --------------------------------------------------------------
  if (EMI_HINTS.test(text)) {
    const amt = text.match(AMOUNT_RX)?.[1];
    if (amt) {
      return {
        kind: "emi",
        amount: num(amt),
        txn_type: "debit",
        merchant: "EMI",
        category: "EMI & Loans",
        txn_date: date,
        reference_number: refMatch,
        last4,
        confidence: 0.75,
      };
    }
  }

  // ---- Investment / SIP -------------------------------------------------
  if (SIP_HINTS.test(text)) {
    const amt = text.match(AMOUNT_RX)?.[1];
    if (amt) {
      return {
        kind: "investment",
        amount: num(amt),
        txn_type: "debit",
        merchant: email.from_name ?? "Investment",
        category: "Investments",
        txn_date: date,
        reference_number: refMatch,
        last4,
        confidence: 0.7,
      };
    }
  }

  // ---- Generic debit/credit alert --------------------------------------
  const amt = text.match(AMOUNT_RX)?.[1];
  if (amt) {
    const isDebit = DEBIT_HINTS.test(text);
    const isCredit = CREDIT_HINTS.test(text);
    if (isDebit || isCredit) {
      const merchantMatch =
        text.match(/\bat\s+([A-Z0-9][A-Z0-9 &._\-*]{2,40})/i)?.[1] ||
        text.match(/\bto\s+VPA\s+(\S+)/i)?.[1] ||
        text.match(/\bfrom\s+([A-Z0-9][A-Z0-9 &._\-*]{2,40})/i)?.[1] ||
        null;
      return {
        kind: "transaction",
        amount: num(amt),
        txn_type: isDebit && !isCredit ? "debit" : "credit",
        merchant: merchantMatch ? merchantMatch.trim() : null,
        category: /\bupi|vpa\b/i.test(text) ? "UPI" : null,
        txn_date: date,
        reference_number: refMatch,
        last4,
        confidence: 0.8,
      };
    }
  }

  return null;
}

// Forwarded-mail unwrapping. Gmail / Outlook style forwards embed the
// original headers inline: "From: X <x@bank.com>", "Subject: ...", etc. When
// the outer envelope is the user's own forwarding address, the sender-based
// bank/card detection sees only the user — so we pull the original sender +
// subject + body out of the quoted forwarded block. Returns the original
// email object unchanged when no forward boundary is found.
export interface UnwrappedEmail {
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  body_text: string | null;
  was_forwarded: boolean;
}

const FORWARD_BOUNDARIES = [
  /-{2,}\s*Forwarded message\s*-{2,}/i,
  /Begin forwarded message:/i,
  /^From:\s*.+<[^>]+@[^>]+>/im,
];

export function unwrapForwarded(email: {
  from_email?: string | null;
  from_name?: string | null;
  subject?: string | null;
  body_text?: string | null;
  snippet?: string | null;
}): UnwrappedEmail {
  const outer = {
    from_email: email.from_email ?? null,
    from_name: email.from_name ?? null,
    subject: email.subject ?? null,
    body_text: email.body_text ?? email.snippet ?? null,
    was_forwarded: false,
  };
  const body = email.body_text ?? email.snippet ?? "";
  if (!body) return outer;

  // Locate a forward boundary; the original headers appear immediately after.
  let boundaryIdx = -1;
  for (const rx of FORWARD_BOUNDARIES) {
    const m = body.match(rx);
    if (m && m.index !== undefined) {
      if (boundaryIdx === -1 || m.index < boundaryIdx) boundaryIdx = m.index;
    }
  }
  const isFwdSubject = /^\s*(Fwd|FW):/i.test(email.subject ?? "");
  if (boundaryIdx === -1 && !isFwdSubject) return outer;

  const inner = boundaryIdx >= 0 ? body.slice(boundaryIdx) : body;
  const fromMatch = inner.match(/^From:\s*("?)([^"<\n]*?)\1\s*<?([\w.+\-]+@[\w.\-]+)>?/im);
  const subjMatch = inner.match(/^Subject:\s*(.+)$/im);

  const inferredFromEmail = fromMatch?.[3]?.trim() ?? null;
  const inferredFromName = fromMatch?.[2]?.trim() || null;
  const inferredSubject = subjMatch?.[1]?.trim() ?? null;

  return {
    from_email: inferredFromEmail ?? outer.from_email,
    from_name: inferredFromName ?? outer.from_name,
    subject: inferredSubject ?? outer.subject?.replace(/^\s*(Fwd|FW):\s*/i, "") ?? outer.subject,
    body_text: inner,
    was_forwarded: true,
  };
}

