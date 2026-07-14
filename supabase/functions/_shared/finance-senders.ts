// Domains typically associated with bank/finance email.
// Used server-side to compose Gmail `from:(...)` filters when an account is
// marked finance-only or `use_case='finance'`.

export const FINANCE_DOMAINS: string[] = [
  // India
  "hdfcbank.net", "hdfcbank.com",
  "icicibank.com",
  "axisbank.com",
  "sbi.co.in", "onlinesbi.sbi", "alerts.sbi",
  "kotak.com",
  "yesbank.in",
  "idfcfirstbank.com",
  "aubank.in",
  "indusind.com",
  "americanexpress.com", "aexp.com",
  "citibank.com",
  "hsbc.co.in",
  // US
  "chase.com",
  "bankofamerica.com",
  "wellsfargo.com",
  "capitalone.com",
  "discover.com",
  // Payments / fintech
  "paypal.com",
  "stripe.com",
  "razorpay.com",
  "cashfree.com",
  "payu.in",
  "phonepe.com",
  "paytm.com",
  "gpay.app", "wise.com",
];

function normalizeDomain(s: string): string {
  return s.trim().toLowerCase().replace(/^@+/, "").replace(/\s+/g, "");
}

/** Build the `from:(a OR b OR ...)` Gmail operator. Returns empty string if no domains. */
export function financeFromClause(extraCsv?: string | null): string {
  const extra = (extraCsv ?? "")
    .split(/[,;\s]+/)
    .map(normalizeDomain)
    .filter(Boolean);
  const all = Array.from(new Set([...FINANCE_DOMAINS, ...extra]));
  if (all.length === 0) return "";
  return `from:(${all.join(" OR ")})`;
}

/** Compose the full Gmail `q` for a sync run. */
export function buildGmailQuery(opts: {
  sync_period_days?: number | null;
  finance_only?: boolean | null;
  use_case?: string | null;
  finance_sender_filter?: string | null;
}): string {
  const days = Math.max(1, Math.min(365, Number(opts.sync_period_days ?? 30)));
  const parts = [`newer_than:${days}d`, `in:inbox`];
  const financeMode = !!opts.finance_only || opts.use_case === "finance";
  if (financeMode) {
    const clause = financeFromClause(opts.finance_sender_filter);
    if (clause) parts.push(clause);
  }
  return parts.join(" ");
}