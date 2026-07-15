// Subject-line fallback for bank/card emails whose PDF text is unhelpful.
// Extracted from statement-pdf.ts so tests can import it without pulling in
// pdfjs (which uses `npm:` specifiers that vitest can't resolve).

const MONTH_LONG: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04", jun: "06", jul: "07", aug: "08", sep: "09",
  sept: "09", oct: "10", nov: "11", dec: "12",
};

function monthKey(m: string): string | null {
  return MONTH_LONG[m.toLowerCase()] ?? null;
}
function lastDayOfMonth(year: number, monthIdx1: number): number {
  return new Date(year, monthIdx1, 0).getDate();
}
function iso(y: string | number, m: string, d: string | number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface SubjectPeriod {
  period_start: string | null;
  period_end: string | null;
  statement_date: string | null;
}

export function parseSubjectPeriod(subject: string | null | undefined): SubjectPeriod {
  const out: SubjectPeriod = { period_start: null, period_end: null, statement_date: null };
  if (!subject) return out;
  const s = subject.replace(/\s+/g, " ").trim();

  // Shape A: "DD-Mon-YYYY TO DD-Mon-YYYY" (HDFC account)
  let m = s.match(/(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{4})\s*(?:to|TO|–|-)\s*(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{4})/);
  if (m) {
    const m1 = monthKey(m[2]); const m2 = monthKey(m[5]);
    if (m1 && m2) {
      out.period_start = iso(m[3], m1, m[1]);
      out.period_end = iso(m[6], m2, m[4]);
    }
  }
  // Shape B: "Mon DD, YYYY to Mon DD, YYYY" (ICICI account, Amazon Pay ICICI card)
  if (!out.period_start) {
    m = s.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\s*(?:to|TO|–|-)\s*([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
    if (m) {
      const m1 = monthKey(m[1]); const m2 = monthKey(m[4]);
      if (m1 && m2) {
        out.period_start = iso(m[3], m1, m[2]);
        out.period_end = iso(m[6], m2, m[5]);
      }
    }
  }
  // Shape C: "Mon YYYY statement" (Kotak) → full month range
  if (!out.period_start) {
    m = s.match(/\b([A-Za-z]{3,9})\s+(\d{4})\b/);
    if (m) {
      const mk = monthKey(m[1]);
      const y = Number(m[2]);
      if (mk && Number.isFinite(y)) {
        const midx = Number(mk);
        out.period_start = iso(y, mk, 1);
        out.period_end = iso(y, mk, lastDayOfMonth(y, midx));
      }
    }
  }
  if (out.period_end && !out.statement_date) out.statement_date = out.period_end;
  return out;
}
