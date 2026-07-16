// Learned statement layout ("skeleton"). Purpose: on first sight of a new
// bank+type layout, deep-scan it (LLM) once, cache the label anchors that
// located each field, and on every future statement of the same shape reuse
// those anchors via cheap regex — no LLM call.
//
// Two-tier match:
//   1. exact `layout_fingerprint` (SHA of a normalized header snippet)
//   2. `structural_fingerprint` (sorted label sequence) — used when a bank
//      rotates masked-account prefixes or moves a line between months.
//
// If a layout truly changes structure (labels move / disappear), both
// fingerprints will miss and we re-learn on the next parse.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { PdfParseResult, StatementLine } from "./statement-pdf.ts";
import type { ParserResult } from "./statement-parsers/types.ts";
import { PARSER_VERSION } from "./statement-parsers/index.ts";

export interface FieldAnchor {
  /** The label(s) that appear in the PDF near the value. First match wins.
   *  Legacy `label` (single string) is still accepted at read time. */
  labels?: string[];
  /** @deprecated Use `labels`. Kept for backward-compat with old skeletons. */
  label?: string;
  /** How to parse the value that follows the label. */
  value_kind: "date" | "amount" | "date_range" | "amount_range";
  /** Optional format hint, e.g. "DD/MM/YYYY". */
  format?: string;
  /** Where to look for the value relative to the label. Default: same_line. */
  column_hint?: "same_line" | "next_line" | "right_of";
}

export type SkeletonFieldKey =
  | "statement_date" | "period" | "period_start" | "period_end"
  | "due_date" | "total_due" | "min_due" | "closing_balance" | "credit_limit";

export interface SkeletonJson {
  bank_slug: string;
  statement_type: "card" | "account" | "loan";
  variant: string | null;
  fields: Partial<Record<SkeletonFieldKey, FieldAnchor>>;
  txn_header_line?: string | null;
  learned_by: string;
  learned_at: string;
}

export interface SkeletonRow {
  id: string;
  bank_slug: string;
  statement_type: "card" | "account" | "loan";
  variant: string | null;
  layout_fingerprint: string;
  structural_fingerprint?: string | null;
  skeleton: SkeletonJson;
  version: number;
}

// ---------- Bank-specific alternative labels ------------------------------
// Seeded from real Indian bank/card statements. Merged into every skeleton
// so a learned single-label anchor still catches this month's variation.

const BANK_ALT_LABELS: Record<string, Partial<Record<keyof SkeletonJson["fields"], string[]>>> = {
  hdfc: {
    statement_date: ["Statement Date", "Statement Dt", "Statement Generated On"],
    due_date: ["Payment Due Date", "Due Date", "Pay by Date"],
    total_due: ["Total Dues", "Total Amount Due", "Total Outstanding"],
    min_due: ["Minimum Amount Due", "Min Amount Due", "Min Due"],
    closing_balance: ["Closing Balance", "Total Outstanding"],
    period: ["Statement Period", "Statement For", "Bill Period"],
  },
  icici: {
    statement_date: ["Statement Date", "Statement Generation Date", "Bill Date"],
    due_date: ["Payment Due Date", "Due Date", "Payment Due"],
    total_due: ["Total Amount due", "Total Amount Due", "Amount Payable"],
    min_due: ["Minimum Amount due", "Minimum Amount Due", "Min. Amount Due"],
    closing_balance: ["Current Balance", "Closing Balance"],
    period: ["Statement Period", "Bill Period", "Statement For"],
  },
  "amazon-pay-icici": {
    statement_date: ["Statement Date", "Statement Generation Date"],
    due_date: ["Payment Due Date", "Due Date"],
    total_due: ["Total Amount due", "Total Amount Due", "Amount Payable"],
    min_due: ["Minimum Amount due", "Minimum Amount Due"],
    closing_balance: ["Current Balance", "Closing Balance"],
    period: ["Statement Period", "Bill Period"],
  },
  axis: {
    statement_date: ["Statement Date", "Statement Generation Date"],
    due_date: ["Payment Due Date", "Due Date"],
    total_due: ["Total Payment Due", "Total Amount Due", "Total Dues"],
    min_due: ["Minimum Payment Due", "Minimum Amount Due"],
    closing_balance: ["Closing Balance"],
    period: ["Statement Period"],
  },
  "airtel-axis": {
    statement_date: ["Statement Date", "Statement Generation Date"],
    due_date: ["Payment Due Date", "Due Date"],
    total_due: ["Total Payment Due", "Total Amount Due"],
    min_due: ["Minimum Payment Due", "Minimum Amount Due"],
    closing_balance: ["Closing Balance"],
    period: ["Statement Period"],
  },
  sbi: {
    statement_date: ["Statement Date", "Statement Generation Date"],
    due_date: ["Payment Due Date", "Due Date"],
    total_due: ["Total Amount Due", "Total Outstanding"],
    min_due: ["Minimum Amount Due", "Min Amt Due"],
    closing_balance: ["Current Balance", "Closing Balance"],
    period: ["Statement Period", "Statement For"],
  },
  "yes bank": {
    statement_date: ["Statement Date"],
    due_date: ["Due Date", "Payment Due Date", "Payment Due On"],
    total_due: ["Total Amount Due", "Total Payment Due", "Total Due", "Amount Payable"],
    min_due: ["Minimum Amount Due", "Min Amt Due", "Minimum Due"],
    closing_balance: ["Closing Balance"],
  },
  kotak: {
    statement_date: ["Statement Date"],
    due_date: ["Payment Due Date", "Due Date"],
    total_due: ["Total Amount Due"],
    min_due: ["Minimum Amount Due"],
    closing_balance: ["Closing Balance"],
  },
};

function mergeAltLabels(bank_slug: string, skeleton: SkeletonJson): SkeletonJson {
  const alt = BANK_ALT_LABELS[bank_slug];
  if (!alt) return skeleton;
  const fields: SkeletonJson["fields"] = { ...skeleton.fields };
  for (const key of Object.keys(alt) as (keyof SkeletonJson["fields"])[]) {
    const bankLabels = alt[key] ?? [];
    const existing = fields[key];
    if (existing) {
      const learned = anchorLabels(existing);
      const merged = Array.from(new Set([...learned, ...bankLabels]));
      fields[key] = { ...existing, labels: merged };
    } else if (bankLabels.length) {
      // Add anchor with default value_kind derived from the field name.
      const kind: FieldAnchor["value_kind"] =
        key === "period" ? "date_range" :
        key === "statement_date" || key === "due_date" ? "date" : "amount";
      fields[key] = { labels: bankLabels, value_kind: kind };
    }
  }
  return { ...skeleton, fields };
}

function anchorLabels(a: FieldAnchor): string[] {
  const out = new Set<string>();
  if (a.labels) for (const l of a.labels) if (l) out.add(l);
  if (a.label) out.add(a.label);
  return Array.from(out);
}

// ---------- Fingerprint ----------------------------------------------------

async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Hash the top-of-document header lines. We aggressively strip anything
// that varies month-to-month (digits, masked account digits, long tokens)
// so a stable layout hashes the same across months even when a masked
// account number gains/loses digits or a period rolls forward.
export async function layoutFingerprint(text: string): Promise<string> {
  const head = text
    .replace(/[xX*]{2,}[\d]{0,4}/g, "")     // masked account "XXXX1234" / "****1234"
    .replace(/\d+/g, "0")                    // any remaining digits → 0
    .split(/\n+/)
    .slice(0, 40)
    .map((l) => l.replace(/\s+/g, " ").trim().toLowerCase())
    .map((l) => l.replace(/\b\S{17,}\b/g, "")) // drop absurdly long tokens (URLs, refs)
    .filter((l) => l.length > 4 && /[a-z]{3,}/.test(l))
    .slice(0, 22)
    .join("|");
  return (await sha256Hex(head)).slice(0, 24);
}

// Fingerprint over the *set* of field labels present. Same bank+type usually
// shares this even when the header block shifts. Cheaper reuse than the
// exact fingerprint.
export async function structuralFingerprint(skeleton: SkeletonJson): Promise<string> {
  const labels: string[] = [];
  for (const k of Object.keys(skeleton.fields).sort() as (keyof SkeletonJson["fields"])[]) {
    const a = skeleton.fields[k];
    if (!a) continue;
    const first = anchorLabels(a)[0] ?? k;
    labels.push(`${k}:${first.toLowerCase().replace(/\s+/g, " ").trim()}`);
  }
  return (await sha256Hex(labels.join("|"))).slice(0, 16);
}

// ---------- Registry (DB) --------------------------------------------------

export async function loadSkeleton(
  svc: SupabaseClient,
  userId: string,
  bank_slug: string,
  statement_type: "card" | "account" | "loan",
  variant: string | null,
  layout_fingerprint: string,
): Promise<SkeletonRow | null> {
  const { data } = await svc.from("statement_skeletons")
    .select("id, bank_slug, statement_type, variant, layout_fingerprint, structural_fingerprint, skeleton, version")
    .eq("user_id", userId)
    .eq("bank_slug", bank_slug)
    .eq("statement_type", statement_type)
    .eq("layout_fingerprint", layout_fingerprint)
    .maybeSingle();
  if (!data) return null;
  if ((data.variant ?? null) !== (variant ?? null)) return null;
  // Discard skeletons written by an older parser — force a re-learn so the
  // new parser's regex/anchor rewrites take effect on cached layouts.
  if ((data.version ?? 1) < PARSER_VERSION) return null;
  return data as SkeletonRow;
}

// Fallback: same bank+type, any recent skeleton whose structural fingerprint
// matches. Useful when a mailbox forwards two variants of the same layout.
export async function loadSkeletonByStructure(
  svc: SupabaseClient,
  userId: string,
  bank_slug: string,
  statement_type: "card" | "account" | "loan",
  structural: string,
): Promise<SkeletonRow | null> {
  const { data } = await svc.from("statement_skeletons")
    .select("id, bank_slug, statement_type, variant, layout_fingerprint, structural_fingerprint, skeleton, version")
    .eq("user_id", userId)
    .eq("bank_slug", bank_slug)
    .eq("statement_type", statement_type)
    .eq("structural_fingerprint", structural)
    .order("last_learn_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (data && (data.version ?? 1) < PARSER_VERSION) return null;
  return (data as SkeletonRow | null) ?? null;
}

export async function upsertSkeleton(
  svc: SupabaseClient,
  userId: string,
  args: {
    bank_slug: string;
    statement_type: "card" | "account" | "loan";
    variant: string | null;
    layout_fingerprint: string;
    skeleton: SkeletonJson;
    sample_statement_id?: string | null;
  },
): Promise<SkeletonRow | null> {
  const structural = await structuralFingerprint(args.skeleton);
  const query = svc.from("statement_skeletons")
    .select("id")
    .eq("user_id", userId)
    .eq("bank_slug", args.bank_slug)
    .eq("statement_type", args.statement_type)
    .eq("layout_fingerprint", args.layout_fingerprint);
  const { data: existing } = await (args.variant == null ? query.is("variant", null) : query.eq("variant", args.variant)).maybeSingle();
  const payload = {
    user_id: userId,
    bank_slug: args.bank_slug,
    statement_type: args.statement_type,
    variant: args.variant,
    layout_fingerprint: args.layout_fingerprint,
    structural_fingerprint: structural,
    skeleton: args.skeleton,
    sample_statement_id: args.sample_statement_id ?? null,
    version: PARSER_VERSION,
    learned_at: new Date().toISOString(),
    last_learn_at: new Date().toISOString(),
  };
  const write = existing?.id
    ? svc.from("statement_skeletons").update(payload).eq("id", existing.id)
    : svc.from("statement_skeletons").insert(payload);
  const { data } = await write.select("id, bank_slug, statement_type, variant, layout_fingerprint, structural_fingerprint, skeleton, version").maybeSingle();
  return (data as SkeletonRow | null) ?? null;
}

export async function recordSkeletonOutcome(
  svc: SupabaseClient,
  skeleton_id: string,
  ok: boolean,
): Promise<void> {
  if (!skeleton_id) return;
  const col = ok ? "parse_success_count" : "parse_failure_count";
  const { data } = await svc.from("statement_skeletons").select("parse_success_count, parse_failure_count").eq("id", skeleton_id).maybeSingle();
  if (!data) return;
  await svc.from("statement_skeletons").update({
    [col]: (data[col as "parse_success_count" | "parse_failure_count"] ?? 0) + 1,
  }).eq("id", skeleton_id);
}

// ---------- Regex-derived skeleton synthesis ------------------------------
const CANONICAL_LABELS: Record<SkeletonFieldKey, string> = {
  statement_date: "Statement Date",
  period: "Statement Period",
  period_start: "Statement Period From",
  period_end: "Statement Period To",
  due_date: "Payment Due Date",
  total_due: "Total Amount Due",
  min_due: "Minimum Amount Due",
  closing_balance: "Closing Balance",
  credit_limit: "Credit Limit",
};

const REQUIRED_FOR_SYNTHESIS: Record<"card" | "account" | "loan", Array<keyof SkeletonJson["fields"]>> = {
  card: ["statement_date", "due_date", "total_due", "min_due", "period"],
  account: ["statement_date", "period", "closing_balance"],
  loan: ["statement_date", "due_date", "total_due"],
};

export function synthesizeSkeletonFromResult(args: {
  bank_slug: string;
  statement_type: "card" | "account" | "loan";
  parser_source: string;
  result: ParserResult;
}): SkeletonJson {
  const f = args.result.fields;
  const matched = (args.result as any).matched_labels ?? {};
  const fields: SkeletonJson["fields"] = {};
  const put = (key: keyof SkeletonJson["fields"], kind: FieldAnchor["value_kind"], value: unknown) => {
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return;
    const canon = CANONICAL_LABELS[key] ?? key;
    const labels = matched[key] ? [matched[key], canon] : [canon];
    fields[key] = { labels, value_kind: kind };
  };
  put("statement_date", "date", f.statement_date);
  put("due_date", "date", f.due_date);
  put("total_due", "amount", f.total_due);
  put("min_due", "amount", f.min_due);
  put("closing_balance", "amount", f.closing_balance);
  if (f.period_start && f.period_end) {
    fields.period = { labels: [matched.period ?? CANONICAL_LABELS.period], value_kind: "date_range" };
  }
  for (const key of REQUIRED_FOR_SYNTHESIS[args.statement_type]) {
    if (fields[key]) continue;
    const kind: FieldAnchor["value_kind"] = key === "period" ? "date_range" : key === "statement_date" || key === "due_date" ? "date" : "amount";
    fields[key] = { labels: [CANONICAL_LABELS[key] ?? key], value_kind: kind };
  }
  return mergeAltLabels(args.bank_slug, {
    bank_slug: args.bank_slug,
    statement_type: args.statement_type,
    variant: null,
    fields,
    txn_header_line: null,
    learned_by: `regex-${args.parser_source}`,
    learned_at: new Date().toISOString(),
  });
}

// ---------- Apply skeleton to text ----------------------------------------

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
function toIso(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})/);
  if (m) {
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yr}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{4}|\d{2})/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (mon) return `${yr}-${mon}-${m[1].padStart(2, "0")}`;
  }
  return null;
}
function toAmount(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = raw.match(/([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Given a label, find its first occurrence and return a scan window that
// includes both the trailing 140 chars (same-line values) and the next
// non-empty line (column-broken PDFs where label is on line N and value
// on line N+1).
function windowAfterLabel(text: string, label: string): string | null {
  const needle = label.trim().replace(/\s+/g, "\\s+");
  const rx = new RegExp(needle + "\\s*[:\\-]?\\s*([\\s\\S]{0,240})", "i");
  const m = text.match(rx);
  return m ? m[1] : null;
}

const DATE_RX = /(\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})|\d{1,2}[\s-]+[A-Za-z]{3,}(?:[\s-]+(?:\d{4}|\d{2}))?)/;

// Lines that look like identifiers, not values. Common in Indian bank
// statements where a "STMT No." / "CKYC No." row sits between a label
// (e.g. "Minimum Amount Due") and its real value further down the column.
// Stripping these before scanning for the first number prevents pollution
// like ₹ 26,07,02,37,829 leaking in from "STMT No. J26070237829".
const NOISE_LINE_RX = /^\s*(?:\*+\s*)?(?:STMT(?:\s*No)?\.?|Statement\s+No\.?|CKYC(?:\s+No)?\.?|Card\s+Number|Credit\s+Card\s+Number|Alternate\s+Account\s+Number|Account\s+Number|Available\s+(?:Credit|Cash)\s+Limit|Cash\s+Limit|GSTIN|HSN(?:\s+Code)?|Invoice\s+No\.?|Ref(?:erence)?\s*No\.?|IFSC|MICR|Customer\s+(?:ID|Id|No))\b.*$/gim;
// Inline "Label : J1234567890" — strip the identifier body so a shared
// line that starts with a noise label doesn't leak its digits.
const NOISE_INLINE_ID_RX = /(?:STMT|Statement\s+No|CKYC|Card\s+Number|Account\s+Number|Customer\s+ID|Invoice\s+No|Ref(?:erence)?\s*No)\.?\s*[:\-]?\s*[A-Z]?\d[\dA-Z\/-]{5,}/gi;
const NO_PAYMENT_RX = /NO\s*PAYMENT\s*REQUIRED/i;

function sanitizeAmountWindow(win: string): string {
  return win.replace(NOISE_LINE_RX, " ").replace(NOISE_INLINE_ID_RX, " ");
}

export type AnchorSentinel = "no_payment_required";

function extractByAnchor(
  text: string,
  anchor: FieldAnchor,
): { value: string | null; second?: string | null; matched_label?: string | null; sentinel?: AnchorSentinel } {
  const labels = anchorLabels(anchor);
  for (const label of labels) {
    const win = windowAfterLabel(text, label);
    if (!win) continue;
    const noPayment = NO_PAYMENT_RX.test(win);
    if (anchor.value_kind === "date") {
      const m = win.match(DATE_RX);
      if (m) return { value: m[1], matched_label: label };
      if (noPayment) return { value: null, matched_label: label, sentinel: "no_payment_required" };
      continue;
    }
    if (anchor.value_kind === "date_range") {
      const rx = new RegExp(`${DATE_RX.source}\\s*(?:to|-|–|through|until)\\s*${DATE_RX.source}`, "i");
      const m = win.match(rx);
      if (m) return { value: m[1], second: m[2], matched_label: label };
      continue;
    }
    if (anchor.value_kind === "amount") {
      if (noPayment) return { value: "0", matched_label: label, sentinel: "no_payment_required" };
      const cleaned = sanitizeAmountWindow(win);
      const m = cleaned.match(/(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
      if (m) return { value: m[1], matched_label: label };
      continue;
    }
  }
  return { value: null };
}

import { extractLines } from "./statement-parsers/generic.ts";

// Required fields per statement type — different for each. Account
// statements are info-only (no due/total lifecycle), cards track a
// payment lifecycle, loans need EMI due + amount.
export const REQUIRED_FIELDS_BY_TYPE: Record<
  "card" | "account" | "loan",
  ReadonlyArray<keyof SkeletonJson["fields"]>
> = {
  card:    ["statement_date", "due_date", "total_due"],
  account: ["statement_date"],
  loan:    ["statement_date", "due_date", "total_due"],
};

function extractTxnBlock(text: string, header: string | null | undefined, fallbackYear: number | null): StatementLine[] {
  if (header) {
    const needle = header.trim().replace(/\s+/g, "\\s+");
    const rx = new RegExp(needle, "i");
    const m = text.match(rx);
    if (m && m.index != null) {
      let block = text.slice(m.index + m[0].length);
      const endRx = /(grand\s+total|closing\s+balance|reward\s+summary|total\s+dues?|statement\s+summary|please\s+note|note\s*:)/i;
      const end = block.search(endRx);
      if (end > 200) block = block.slice(0, end);
      const scoped = extractLines(block, fallbackYear);
      if (scoped.length > 0) return scoped;
    }
  }
  return extractLines(text, fallbackYear);
}

export function applySkeleton(text: string, skeleton: SkeletonJson): PdfParseResult {
  // Enrich anchor labels with the bank's known variants so a partial LLM
  // learn still catches this month's label wording.
  const enriched = mergeAltLabels(skeleton.bank_slug, skeleton);
  const fields = enriched.fields;
  const period = fields.period ? extractByAnchor(text, fields.period) : { value: null as string | null, second: null as string | null };
  const pStart = fields.period_start ? extractByAnchor(text, fields.period_start) : { value: null };
  const pEnd   = fields.period_end   ? extractByAnchor(text, fields.period_end)   : { value: null };
  const stmt   = fields.statement_date ? extractByAnchor(text, fields.statement_date) : { value: null };
  const due    = fields.due_date ? extractByAnchor(text, fields.due_date) : { value: null };
  const total  = fields.total_due ? extractByAnchor(text, fields.total_due) : { value: null };
  const mindue = fields.min_due ? extractByAnchor(text, fields.min_due) : { value: null };
  const clos   = fields.closing_balance ? extractByAnchor(text, fields.closing_balance) : { value: null };
  const climit = fields.credit_limit ? extractByAnchor(text, fields.credit_limit) : { value: null };

  const period_start = (period.value ? toIso(period.value) : null) ?? (pStart.value ? toIso(pStart.value) : null);
  const period_end   = ((period as any).second ? toIso((period as any).second) : null) ?? (pEnd.value ? toIso(pEnd.value) : null);
  const statement_date = stmt.value ? toIso(stmt.value) : null;
  // NO PAYMENT REQUIRED: no printed due date. Mirror the SBI regex parser
  // and fall back to statement_date so downstream code that requires a
  // due_date doesn't blow up, while amount fields are forced to 0 below.
  const noPaymentDue = (due as any).sentinel === "no_payment_required";
  const due_date = due.value ? toIso(due.value) : (noPaymentDue ? statement_date : null);
  const yearHint = statement_date ? Number(statement_date.slice(0, 4))
                  : period_end ? Number(period_end.slice(0, 4)) : null;

  const lines: StatementLine[] = extractTxnBlock(text, enriched.txn_header_line, yearHint);

  const totalSentinel = (total as any).sentinel === "no_payment_required";
  const mindueSentinel = (mindue as any).sentinel === "no_payment_required";
  const total_due = totalSentinel || noPaymentDue ? 0 : toAmount(total.value);
  const min_due   = mindueSentinel || noPaymentDue ? 0 : toAmount(mindue.value);

  const required = REQUIRED_FIELDS_BY_TYPE[enriched.statement_type];
  const values: Record<string, unknown> = {
    statement_date,
    due_date,
    total_due,
    min_due,
    closing_balance: toAmount(clos.value),
    period: period_start && period_end ? `${period_start}..${period_end}` : null,
  };
  const missing: string[] = [];
  for (const k of required) {
    if (k === "period") {
      if (!values.period && !values.statement_date) missing.push("period");
      continue;
    }
    if (values[k as string] == null) missing.push(k as string);
  }

  return {
    ok: missing.length === 0,
    period_start, period_end,
    statement_date, due_date,
    total_due,
    min_due,
    closing_balance: toAmount(clos.value),
    credit_limit: toAmount(climit.value),
    card_last4: null,
    lines,
    parser_source: `skeleton (${enriched.learned_by})`,
    parse_confidence: missing.length === 0 ? 0.9 : 0.6,
    extracted_text: null,
    error: missing.length ? `missing_fields:${missing.join(",")}` : undefined,
  };
}

// ---------- Learn anchors from user-supplied correct values ---------------
// Given the PDF text and the user's known-correct values, locate each value
// in the text and derive the nearest preceding label. Returns a partial
// `fields` map suitable for merging into an existing skeleton.

const AMOUNT_FIELDS: SkeletonFieldKey[] = ["total_due", "min_due", "closing_balance", "credit_limit"];
const DATE_FIELDS: SkeletonFieldKey[] = ["statement_date", "due_date", "period_start", "period_end"];

function normalizeLabel(raw: string): string | null {
  let s = raw.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/[|•·>»›\-–—:]+\s*$/, "").trim();
  s = s.replace(/^[|•·>»›\-–—:]+\s*/, "").trim();
  // Trim any leading currency / stray tokens
  s = s.replace(/^(?:INR|Rs\.?|₹|\$)\s*/i, "").trim();
  // Keep the last 2–6 word segment that looks like a label (letters + spaces)
  const m = s.match(/([A-Za-z][A-Za-z .&/()]{2,60})\s*$/);
  if (!m) return null;
  const label = m[1].trim();
  if (label.length < 3 || label.length > 60) return null;
  if (!/[A-Za-z]{3,}/.test(label)) return null;
  return label;
}

function findValuePositions(text: string, patterns: RegExp[]): number[] {
  const positions: number[] = [];
  for (const rx of patterns) {
    const g = new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : rx.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(text)) !== null) {
      positions.push(m.index);
      if (positions.length > 8) break;
    }
    if (positions.length) break; // first pattern that matches wins
  }
  return positions;
}

function amountPatterns(value: number): RegExp[] {
  const abs = Math.abs(value);
  const int = Math.trunc(abs);
  const decs = Math.round((abs - int) * 100);
  const intStr = String(int);
  // With grouping (Indian + Western)
  const grouped = intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const indianGrouped = intStr.length > 3
    ? intStr.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + intStr.slice(-3)
    : intStr;
  const bodies = Array.from(new Set([intStr, grouped, indianGrouped]));
  const rxs: RegExp[] = [];
  for (const b of bodies) {
    const esc = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (decs > 0) {
      const d = String(decs).padStart(2, "0");
      rxs.push(new RegExp(`(?<![\\d.])${esc}\\.${d}(?!\\d)`));
    } else {
      rxs.push(new RegExp(`(?<![\\d.])${esc}(?:\\.00?)?(?!\\d)`));
    }
  }
  return rxs;
}

function datePatterns(iso: string): RegExp[] {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [];
  const [, y, mo, d] = m;
  const yy = y.slice(2);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mon = monthNames[Number(mo) - 1];
  const dNoPad = String(Number(d));
  const moNoPad = String(Number(mo));
  const variants = [
    `${d}[/.\\-]${mo}[/.\\-]${y}`,
    `${d}[/.\\-]${mo}[/.\\-]${yy}`,
    `${dNoPad}[/.\\-]${moNoPad}[/.\\-]${y}`,
    `${dNoPad}[/.\\-]${moNoPad}[/.\\-]${yy}`,
    `${d}\\s+${mon}[a-z]{0,6}\\s+${y}`,
    `${dNoPad}\\s+${mon}[a-z]{0,6}\\s+${y}`,
    `${d}\\s+${mon}[a-z]{0,6}\\s+${yy}`,
    `${mon}[a-z]{0,6}\\s+${d},?\\s+${y}`,
    `${y}[/.\\-]${mo}[/.\\-]${d}`,
  ];
  return variants.map((v) => new RegExp(`\\b${v}\\b`, "i"));
}

function labelBeforePosition(text: string, pos: number): string | null {
  // Look on the same physical line (window of 100 chars before pos, cut at newline).
  const windowStart = Math.max(0, pos - 160);
  const chunk = text.slice(windowStart, pos);
  const lastNl = chunk.lastIndexOf("\n");
  const sameLine = lastNl >= 0 ? chunk.slice(lastNl + 1) : chunk;
  const sameLabel = normalizeLabel(sameLine);
  if (sameLabel) return sameLabel;
  // Otherwise, use the previous non-empty line.
  if (lastNl >= 0) {
    const before = chunk.slice(0, lastNl).replace(/\s+$/, "");
    const prevNl = before.lastIndexOf("\n");
    const prevLine = prevNl >= 0 ? before.slice(prevNl + 1) : before;
    return normalizeLabel(prevLine);
  }
  return null;
}

export interface LearnAnchorsInput {
  statement_date?: string | null;
  due_date?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  total_due?: number | null;
  min_due?: number | null;
  closing_balance?: number | null;
  credit_limit?: number | null;
}

export interface LearnedAnchorResult {
  fields: Partial<Record<SkeletonFieldKey, FieldAnchor>>;
  learned_keys: SkeletonFieldKey[];
  skipped: Array<{ key: SkeletonFieldKey; reason: string }>;
}

export function learnAnchorsFromValues(
  text: string,
  statement_type: "card" | "account" | "loan",
  values: LearnAnchorsInput,
): LearnedAnchorResult {
  const learned: Partial<Record<SkeletonFieldKey, FieldAnchor>> = {};
  const learned_keys: SkeletonFieldKey[] = [];
  const skipped: Array<{ key: SkeletonFieldKey; reason: string }> = [];

  const attempt = (key: SkeletonFieldKey, patterns: RegExp[], kind: FieldAnchor["value_kind"]) => {
    if (!patterns.length) { skipped.push({ key, reason: "no-pattern" }); return; }
    const positions = findValuePositions(text, patterns);
    if (positions.length === 0) { skipped.push({ key, reason: "value-not-found" }); return; }
    if (positions.length > 3) { skipped.push({ key, reason: "ambiguous" }); return; }
    const label = labelBeforePosition(text, positions[0]);
    if (!label) { skipped.push({ key, reason: "no-label" }); return; }
    learned[key] = { labels: [label], value_kind: kind };
    learned_keys.push(key);
  };

  if (values.total_due != null)       attempt("total_due",       amountPatterns(values.total_due),       "amount");
  if (values.min_due != null)         attempt("min_due",         amountPatterns(values.min_due),         "amount");
  if (values.closing_balance != null) attempt("closing_balance", amountPatterns(values.closing_balance), "amount");
  if (values.credit_limit != null && statement_type !== "account") {
    attempt("credit_limit", amountPatterns(values.credit_limit), "amount");
  }
  if (values.statement_date) attempt("statement_date", datePatterns(values.statement_date), "date");
  if (values.due_date)       attempt("due_date",       datePatterns(values.due_date),       "date");
  if (values.period_start)   attempt("period_start",   datePatterns(values.period_start),   "date");
  if (values.period_end)     attempt("period_end",     datePatterns(values.period_end),     "date");

  return { fields: learned, learned_keys, skipped };
}

export function mergeLearnedAnchors(
  existing: SkeletonJson | null,
  bank_slug: string,
  statement_type: "card" | "account" | "loan",
  learned: Partial<Record<SkeletonFieldKey, FieldAnchor>>,
): SkeletonJson {
  const base: SkeletonJson = existing ?? {
    bank_slug,
    statement_type,
    variant: null,
    fields: {},
    txn_header_line: null,
    learned_by: "user-correction",
    learned_at: new Date().toISOString(),
  };
  const fields: SkeletonJson["fields"] = { ...base.fields };
  for (const [k, anchor] of Object.entries(learned) as Array<[SkeletonFieldKey, FieldAnchor]>) {
    if (!anchor) continue;
    const prior = fields[k];
    const priorLabels = prior ? anchorLabels(prior) : [];
    const newLabels = (anchor.labels ?? []).filter((l) => l && l.trim().length);
    const merged = Array.from(new Set([...newLabels, ...priorLabels])).slice(0, 6);
    fields[k] = {
      labels: merged,
      value_kind: anchor.value_kind ?? prior?.value_kind ?? "amount",
      column_hint: prior?.column_hint ?? anchor.column_hint,
      format: prior?.format ?? anchor.format,
    };
  }
  return mergeAltLabels(bank_slug, {
    ...base,
    fields,
    learned_by: existing ? `${existing.learned_by}+user-correction` : "user-correction",
    learned_at: new Date().toISOString(),
  });
}

// ---------- LLM learner ---------------------------------------------------

export interface LearnerArgs {
  text: string;
  bank_slug: string;
  statement_type: "card" | "account" | "loan";
  apiKey: string;
  subject?: string | null;
}

export async function learnSkeleton(args: LearnerArgs): Promise<SkeletonJson | null> {
  const [{ generateText, Output }, { z }, gwMod] = await Promise.all([
    import("npm:ai"),
    import("npm:zod"),
    import("./ai-gateway.ts"),
  ]);
  const gateway = gwMod.createLovableAiGatewayProvider(args.apiKey);
  const LabelArray = z.array(z.string()).nullable();
  const LearnedSchema = z.object({
    variant: z.string().nullable().describe("Card family / account variant (e.g. 'millennia', 'amazon-pay', 'salary'), or null."),
    fields: z.object({
      statement_date:  z.object({ labels: LabelArray, value: z.string().nullable() }).nullable(),
      period:          z.object({ labels: LabelArray, value_start: z.string().nullable(), value_end: z.string().nullable() }).nullable(),
      due_date:        z.object({ labels: LabelArray, value: z.string().nullable() }).nullable(),
      total_due:       z.object({ labels: LabelArray, value: z.string().nullable() }).nullable(),
      min_due:         z.object({ labels: LabelArray, value: z.string().nullable() }).nullable(),
      closing_balance: z.object({ labels: LabelArray, value: z.string().nullable() }).nullable(),
    }),
    txn_header_line: z.string().nullable().describe("Verbatim transactions table header row, e.g. 'Date Description Amount'. Null if no visible txn table."),
  });
  const head = args.text.slice(0, 8_000);
  const mid  = args.text.length > 8_000 ? args.text.slice(8_000, 16_000) : "";
  const sample = head + (mid ? "\n\n--- MID ---\n\n" + mid : "");
  const requiredList = args.statement_type === "card"
    ? "statement_date, due_date, total_due (mandatory for cards); min_due, closing_balance, period (optional)"
    : args.statement_type === "account"
    ? "statement_date, period, closing_balance (account statements are info-only — no due/total tracking)"
    : "statement_date, due_date, total_due (loan EMI)";
  const sys = `You extract structured fields from Indian bank statement PDFs.

This is a ${args.statement_type} statement from bank "${args.bank_slug}". Subject: ${args.subject ?? ""}.

Required fields for this type: ${requiredList}.

For each field, return EVERY label variant you can see that identifies the value (e.g. ["Payment Due Date", "Due Date"], ["Total Dues", "Total Amount Due"], ["Bill Period", "Statement Period"]) — return them as an array of strings, verbatim as they appear in the PDF. Also return the raw VALUE string with no reformatting. Use null when a field is not present.

Also return txn_header_line — the header row of the transactions table exactly as it appears (e.g. "Date  Transaction Details  Amount  Type"). Null if no visible txn table.

Cards need due/total tracking. Accounts are info-only. Do not invent fields.

Return only the JSON schema. No prose.`;

  try {
    const { output } = await generateText({
      model: gateway("google/gemini-2.5-flash"),
      output: Output.object({ schema: LearnedSchema }),
      system: sys,
      prompt: sample,
    });
    const f = output.fields;
    const fields: SkeletonJson["fields"] = {};
    const put = (key: keyof SkeletonJson["fields"], node: any, kind: FieldAnchor["value_kind"]) => {
      if (!node) return;
      const labels = Array.isArray(node.labels) ? node.labels.filter((s: any) => typeof s === "string" && s.trim().length) : [];
      if (labels.length === 0) return;
      fields[key] = { labels, value_kind: kind };
    };
    put("statement_date",  f.statement_date,  "date");
    put("period",          f.period,          "date_range");
    put("due_date",        f.due_date,        "date");
    put("total_due",       f.total_due,       "amount");
    put("min_due",         f.min_due,         "amount");
    put("closing_balance", f.closing_balance, "amount");
    return mergeAltLabels(args.bank_slug, {
      bank_slug: args.bank_slug,
      statement_type: args.statement_type,
      variant: output.variant ?? null,
      fields,
      txn_header_line: output.txn_header_line ?? null,
      learned_by: "google/gemini-2.5-flash",
      learned_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("learnSkeleton failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

// ---------- Orchestrator --------------------------------------------------

export interface LearnAndParseCtx {
  svc: SupabaseClient;
  userId: string;
  bank_slug: string;
  statement_type: "card" | "account" | "loan";
  subject?: string | null;
  sample_statement_id?: string | null;
}

/**
 * Try cached skeleton → structural fallback → LLM learner → apply.
 * `force` = ignore cache and re-learn from the LLM.
 */
export async function learnAndParse(
  text: string,
  ctx: LearnAndParseCtx & { force?: boolean },
): Promise<{ result: PdfParseResult; skeleton_id: string | null } | null> {
  if (!ctx.bank_slug) return null;
  const fp = await layoutFingerprint(text);

  const { data: existing } = await ctx.svc.from("statement_skeletons")
    .select("id, bank_slug, statement_type, variant, layout_fingerprint, structural_fingerprint, skeleton, version")
    .eq("user_id", ctx.userId)
    .eq("bank_slug", ctx.bank_slug)
    .eq("statement_type", ctx.statement_type)
    .eq("layout_fingerprint", fp)
    .maybeSingle();

  if (existing && !ctx.force && (existing.version ?? 1) >= PARSER_VERSION) {
    const applied = applySkeleton(text, existing.skeleton as SkeletonJson);
    if (applied.ok) {
      await recordSkeletonOutcome(ctx.svc, existing.id, true).catch(() => {});
      return { result: applied, skeleton_id: existing.id };
    }
    await recordSkeletonOutcome(ctx.svc, existing.id, false).catch(() => {});
    // fall through and re-learn
  }

  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) return null;

  const learned = await learnSkeleton({
    text, bank_slug: ctx.bank_slug, statement_type: ctx.statement_type,
    apiKey, subject: ctx.subject ?? null,
  });
  if (!learned) return null;

  const upserted = await upsertSkeleton(ctx.svc, ctx.userId, {
    bank_slug: ctx.bank_slug,
    statement_type: ctx.statement_type,
    variant: learned.variant,
    layout_fingerprint: fp,
    skeleton: learned,
    sample_statement_id: ctx.sample_statement_id ?? null,
  }).catch(() => null);

  const applied = applySkeleton(text, learned);
  await recordSkeletonOutcome(ctx.svc, upserted?.id ?? "", applied.ok).catch(() => {});
  return { result: applied, skeleton_id: upserted?.id ?? null };
}
