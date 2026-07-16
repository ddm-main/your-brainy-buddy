// Shared helpers used across bank-specific statement parsers.
//
// PDF text extractors render the Indian rupee glyph inconsistently depending
// on the font embedded in the source PDF:
//   • YES/Axis/SBI:                Rs. / ₹ / INR
//   • Amazon Pay ICICI:            `  (U+0060 backtick)
//   • HDFC Millennia:              C  (Caps C directly before digits)
// The `AMOUNT_TOKEN` and `stripCurrency` helpers accept all four so
// downstream parsers don't need per-bank currency logic.

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Best-effort year for date fragments that lack one (e.g. "28 Feb" in an SBI
// statement whose subject is "…Mar 2026"). Prefer the caller-provided year,
// otherwise the first 20xx we see in the subject or the top of the text.
export function inferYear(text: string, ctx: { statement_year?: number | null; subject?: string | null }): number | null {
  if (ctx.statement_year) return ctx.statement_year;
  const hay = `${ctx.subject ?? ""} ${text.slice(0, 2000)}`;
  const m = hay.match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

// Any currency prefix — `C` needs the (?=[0-9\-,]) lookahead so we don't
// swallow a random capital C from prose.
export const CURRENCY_PREFIX = "(?:INR|Rs\\.?|₹|`|C(?=[\\-]?[0-9]))";
export const AMOUNT_RX = new RegExp(`(?:${CURRENCY_PREFIX})?\\s*(-?[0-9][0-9,]*(?:\\.[0-9]{1,2})?)`, "i");
export const DATE_SRC =
  "(?:\\d{1,2}[./-]\\d{1,2}[./-](?:\\d{4}|\\d{2})" +
  "|\\d{1,2}[\\s-]+[A-Za-z]{3,}(?:[\\s-]+(?:\\d{4}|\\d{2}))?" +
  "|[A-Za-z]{3,}\\s+\\d{1,2},?\\s+(?:\\d{4}|\\d{2}))";

export function toAmount(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = raw.match(/(-?[0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function toIsoDate(raw: string | undefined | null, fallbackYear?: number | null): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/\s+/g, " ");
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})$/);
  if (m) {
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yr}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]*,?\s*(\d{2}|\d{4})$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (mon) return `${yr}-${mon}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})$/);
  if (m && fallbackYear) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${fallbackYear}-${mon}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{2}|\d{4})$/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (mon) return `${yr}-${mon}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

// Sniff statement_type when the caller doesn't already know it. Uses cheap
// keyword heuristics — cards win over accounts only when a truly
// card-specific label is present (`Payment Due Date`, `Credit Card`, etc.).
export function sniffStatementType(text: string): "card" | "account" {
  const head = text.slice(0, 6000);
  const isCard =
    /\bCredit\s*Card\b/i.test(head) ||
    /\bPayment\s*Due\s*Date\b/i.test(head) ||
    /\bMinimum\s*(?:Amount|Payment)\s*Due\b/i.test(head) ||
    /\bTotal\s*(?:Amount|Payment)\s*Due\b/i.test(head);
  const isAccount =
    /\bSavings\s*Account\b/i.test(head) ||
    /\bSavings\s*A\/c\b/i.test(head) ||
    /\bAccount\s*Statement\b/i.test(head) ||
    /\bStatement\s*of\s*Transactions\b/i.test(head) ||
    /\bWithdrawal\s*\(Dr/i.test(head) ||
    /\bDeposit\s*\(Cr/i.test(head) ||
    /\bIFSC(?:\s*Code)?\b/i.test(head);
  if (isCard && !isAccount) return "card";
  if (isAccount && !isCard) return "account";
  // Both present: whoever anchors *earlier* in the text wins.
  if (isCard && isAccount) {
    const cardIdx = head.search(/Credit\s*Card|Payment\s*Due\s*Date/i);
    const acctIdx = head.search(/Savings\s*(?:Account|A\/c)|Statement\s*of\s*Transactions/i);
    return cardIdx >= 0 && (acctIdx < 0 || cardIdx < acctIdx) ? "card" : "account";
  }
  return "card";
}

// Split a line by 2+ whitespace runs — the classic tabular signal in
// pdftotext `-layout` output. Empty cells collapse.
export function splitCols(line: string): string[] {
  return line.split(/\s{2,}/).map((s) => s.trim()).filter((s) => s.length > 0);
}

// Given a block of text, find a row that matches ALL label patterns (a
// header row) and return that plus the following 1-3 non-empty lines split
// by whitespace columns. Handy for HDFC/Amazon Pay ICICI's stacked
// label-then-value layouts.
export function findColumnarBlock(
  text: string,
  headerLabels: RegExp[],
  maxValueLines = 3,
): { headers: string[]; rows: string[][] } | null {
  const lines = text.split(/\n+/).map((l) => l.replace(/\s+$/, ""));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (headerLabels.every((rx) => rx.test(line))) {
      const headers = splitCols(line);
      const rows: string[][] = [];
      let taken = 0;
      for (let j = i + 1; j < lines.length && taken < maxValueLines; j++) {
        const raw = lines[j];
        if (!raw.trim()) continue;
        // Skip pure-operator lines like `= + + + -` that Amazon Pay ICICI
        // renders between the header and value rows.
        if (/^\s*[=+\-\s]+\s*$/.test(raw)) continue;
        const cells = splitCols(raw);
        if (cells.length === 0) continue;
        rows.push(cells);
        taken++;
      }
      if (rows.length) return { headers, rows };
    }
  }
  return null;
}

// Locate a label on its own line and return the first non-empty following
// line. Used by Amazon Pay ICICI where labels stack over values.
export function stackedValue(
  text: string,
  label: RegExp,
  maxLookahead = 5,
): string | null {
  const lines = text.split(/\n+/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    if (!label.test(lines[i])) continue;
    // If the line already contains a value after the label, return that.
    const inline = lines[i].replace(label, "").trim();
    if (inline && /[0-9]/.test(inline)) return inline;
    for (let j = i + 1; j < Math.min(lines.length, i + 1 + maxLookahead); j++) {
      if (!lines[j]) continue;
      if (label.test(lines[j])) continue; // skip repeated header
      return lines[j];
    }
  }
  return null;
}
