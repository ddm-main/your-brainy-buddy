// Shared shape for every bank/card-family statement parser. A parser takes
// the raw extracted PDF text (already decrypted upstream) plus an optional
// bank/card hint, and returns normalized fields the pipeline persists.
//
// Parsers never throw: a miss returns { ok: false, missing_fields } so the
// caller can decide whether to fall through to a lower-confidence parser.

export interface StatementLine {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number;
  txn_type: "debit" | "credit";
}

export interface ParsedStatementFields {
  period_start: string | null;
  period_end: string | null;
  statement_date: string | null;
  due_date: string | null;
  total_due: number | null;
  min_due: number | null;
  closing_balance: number | null;
  lines: StatementLine[];
}

export interface ParserResult {
  ok: boolean;
  fields: ParsedStatementFields;
  parser_source: string;
  confidence: number; // 0..1
  missing_fields: string[];
  error?: string;
}

export interface ParserContext {
  bank_slug?: string | null;
  card_family?: string | null; // e.g. "bpcl", "cashback", "amazon-pay"
  statement_type?: "card" | "account" | "loan" | null;
  subject?: string | null;
  sender?: string | null;
  statement_year?: number | null;
}

export type StatementParser = (text: string, ctx: ParserContext) => ParserResult;
