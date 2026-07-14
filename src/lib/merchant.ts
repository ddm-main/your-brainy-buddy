/** Merchant normalization + alias resolution.
 * Pure helpers; DB-lookup variants take the alias map as a parameter so this
 * stays free of React/Supabase and is trivially testable.
 */

export function normalizeMerchant(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/\b(pvt|ltd|inc|llc|india|payments?|autopay|subscription|txn|ref|upi|neft|imps|pos|purchase|txn#|refno)\b/g, " ")
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface MerchantAlias {
  raw: string;
  canonical: string;
  category?: string | null;
}

/** Resolve a raw merchant string to its canonical name using an alias map.
 * Longest-match wins so "amazon prime" beats "amazon" if both exist. */
export function resolveMerchant(raw: string, aliases: MerchantAlias[]): { canonical: string; category?: string | null } {
  const norm = normalizeMerchant(raw);
  if (!norm) return { canonical: "" };
  let best: MerchantAlias | null = null;
  for (const a of aliases) {
    const rn = normalizeMerchant(a.raw);
    if (!rn) continue;
    if (norm.includes(rn) && (!best || rn.length > normalizeMerchant(best.raw).length)) best = a;
  }
  if (best) return { canonical: best.canonical, category: best.category ?? null };
  return { canonical: norm };
}