/** Standard reducing-balance EMI math. All amounts in the same currency unit
 * (₹, no paise handling — matches how the rest of the app treats amounts).
 * Rate and tenure are always the "given" inputs; Principal and EMI derive
 * from each other. Every function returns null on invalid input — never
 * NaN, never throws. */

const MAX_TENURE_MONTHS = 720; // 60 years — sanity guard against fat-fingered input

function isValidRate(annualRatePct: number): boolean {
  return Number.isFinite(annualRatePct) && annualRatePct >= 0;
}
function isValidTenure(n: number): boolean {
  return Number.isFinite(n) && n > 0 && n <= MAX_TENURE_MONTHS && Number.isInteger(n);
}

/** Principal + rate + tenure -> EMI. */
export function calcEmi(principal: number, annualRatePct: number, tenureMonths: number): number | null {
  if (!Number.isFinite(principal) || principal <= 0) return null;
  if (!isValidRate(annualRatePct) || !isValidTenure(tenureMonths)) return null;
  const r = annualRatePct / 1200;
  if (r === 0) return principal / tenureMonths;
  const factor = Math.pow(1 + r, tenureMonths);
  const emi = (principal * r * factor) / (factor - 1);
  return Number.isFinite(emi) ? emi : null;
}

/** EMI + rate + tenure -> Principal (inverse of calcEmi). */
export function calcPrincipalFromEmi(emi: number, annualRatePct: number, tenureMonths: number): number | null {
  if (!Number.isFinite(emi) || emi <= 0) return null;
  if (!isValidRate(annualRatePct) || !isValidTenure(tenureMonths)) return null;
  const r = annualRatePct / 1200;
  if (r === 0) return emi * tenureMonths;
  const factor = Math.pow(1 + r, tenureMonths);
  const principal = (emi * (factor - 1)) / (r * factor);
  return Number.isFinite(principal) ? principal : null;
}

/** Rounds to 2 decimal places for display/storage consistency. */
export function roundCurrency(n: number): number {
  return Math.round(n * 100) / 100;
}
