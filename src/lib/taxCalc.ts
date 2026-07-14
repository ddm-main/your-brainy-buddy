/**
 * ESTIMATES ONLY — NOT TAX OR FINANCIAL ADVICE. VERIFY WITH A CHARTERED
 * ACCOUNTANT BEFORE FILING.
 *
 * Indian capital-gains and income-tax rules change with each Union Budget.
 * The rates below reflect the equity/debt capital-gains regime introduced in
 * Budget 2024 (effective FY 2024-25 onward) — equity STCG 20%, equity LTCG
 * 12.5% above a ₹1.25L/year exemption with a 12-month holding threshold;
 * debt funds taxed entirely at slab rate with no LTCG/indexation benefit
 * (per the April 2023 debt-fund taxation change). These are hardcoded and
 * isolated in this one file *specifically* so they're easy to find and
 * update when rules change — do not scatter tax-rate literals elsewhere.
 * Every UI surface that renders output from this file must show a
 * persistent disclaimer, not a dismissible tooltip.
 */

export const TAX_RULES_FY2026_27 = {
  label: "FY 2026-27 (rates per Budget 2024 equity/debt capital-gains regime — verify current year)",
  equity: {
    stcgRatePct: 20,
    ltcgRatePct: 12.5,
    ltcgExemptionPerYear: 125000,
    holdingMonthsForLtcg: 12,
  },
  debtFund: {
    // Post-April-2023 rules: no LTCG/indexation distinction, always taxed as
    // "other income" at the investor's slab rate.
    taxedAtSlabRate: true,
  },
  newRegimeSlabs: [
    { upTo: 300000, ratePct: 0 },
    { upTo: 700000, ratePct: 5 },
    { upTo: 1000000, ratePct: 10 },
    { upTo: 1200000, ratePct: 15 },
    { upTo: 1500000, ratePct: 20 },
    { upTo: Infinity, ratePct: 30 },
  ],
  newRegimeStandardDeduction: 75000,
  newRegimeRebate87ATaxableLimit: 700000, // full rebate (tax = 0) if taxable income at/below this
  oldRegimeSlabs: [
    { upTo: 250000, ratePct: 0 },
    { upTo: 500000, ratePct: 5 },
    { upTo: 1000000, ratePct: 20 },
    { upTo: Infinity, ratePct: 30 },
  ],
  oldRegimeStandardDeduction: 50000,
  oldRegimeRebate87ATaxableLimit: 500000,
  cessPct: 4, // Health & Education Cess on top of computed tax
} as const;

export interface CapitalGainsInput {
  assetClass: "equity" | "debt_fund" | "stock";
  buyDate: string;
  sellDate: string;
  buyAmount: number;
  sellAmount: number;
}

export interface CapitalGainsResult {
  gain: number;
  kind: "stcg" | "ltcg" | "slab";
  taxableAfterExemption: number;
  estimatedTax: number;
}

function monthsBetween(a: string, b: string): number {
  const d1 = new Date(a), d2 = new Date(b);
  return (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth());
}

/**
 * Estimates capital gains tax for one sale event. `equityLtcgExemptionUsedSoFar`
 * lets callers apply the ₹1.25L/year exemption across multiple sales in the
 * same FY (pass the running total already consumed by earlier sales this
 * year) — defaults to 0 (exemption fully available).
 */
export function calcCapitalGains(input: CapitalGainsInput, equityLtcgExemptionUsedSoFar = 0): CapitalGainsResult | null {
  const gain = Number(input.sellAmount) - Number(input.buyAmount);
  if (!Number.isFinite(gain)) return null;
  const months = monthsBetween(input.buyDate, input.sellDate);
  if (!Number.isFinite(months)) return null;

  if (input.assetClass === "debt_fund") {
    // Slab-rate asset: reported as "other income", not taxed standalone here
    // (see calcRegimeComparison, which folds this into taxable income).
    return { gain, kind: "slab", taxableAfterExemption: Math.max(0, gain), estimatedTax: 0 };
  }

  const isLongTerm = months >= TAX_RULES_FY2026_27.equity.holdingMonthsForLtcg;
  if (!isLongTerm) {
    const estimatedTax = gain > 0 ? gain * (TAX_RULES_FY2026_27.equity.stcgRatePct / 100) : 0;
    return { gain, kind: "stcg", taxableAfterExemption: Math.max(0, gain), estimatedTax };
  }

  const remainingExemption = Math.max(0, TAX_RULES_FY2026_27.equity.ltcgExemptionPerYear - equityLtcgExemptionUsedSoFar);
  const taxableAfterExemption = gain > 0 ? Math.max(0, gain - remainingExemption) : 0;
  const estimatedTax = taxableAfterExemption * (TAX_RULES_FY2026_27.equity.ltcgRatePct / 100);
  return { gain, kind: "ltcg", taxableAfterExemption, estimatedTax };
}

function taxFromSlabs(taxableIncome: number, slabs: readonly { upTo: number; ratePct: number }[]): number {
  let tax = 0;
  let lower = 0;
  for (const slab of slabs) {
    if (taxableIncome <= lower) break;
    const upper = Math.min(taxableIncome, slab.upTo);
    tax += Math.max(0, upper - lower) * (slab.ratePct / 100);
    lower = slab.upTo;
  }
  return tax;
}

export interface RegimeComparisonResult {
  regime: "old" | "new";
  taxableIncome: number;
  taxBeforeCess: number;
  totalTax: number;
  rebateApplied: boolean;
}

/**
 * Rough old-vs-new regime comparison from gross annual income and (for the
 * old regime only) total eligible deductions (80C/80D/HRA/etc — the new
 * regime doesn't allow most of these). Does not itself include capital
 * gains — combine with calcCapitalGains's slab-taxed (debt fund) results
 * separately if needed; equity STCG/LTCG are taxed at their own flat rates
 * regardless of regime and aren't part of slab income.
 */
export function calcRegimeComparison(grossIncome: number, oldRegimeDeductions = 0): { old: RegimeComparisonResult; new: RegimeComparisonResult; better: "old" | "new" } | null {
  if (!Number.isFinite(grossIncome) || grossIncome < 0) return null;

  const newTaxable = Math.max(0, grossIncome - TAX_RULES_FY2026_27.newRegimeStandardDeduction);
  const newRebateApplies = newTaxable <= TAX_RULES_FY2026_27.newRegimeRebate87ATaxableLimit;
  const newTaxBeforeCess = newRebateApplies ? 0 : taxFromSlabs(newTaxable, TAX_RULES_FY2026_27.newRegimeSlabs);
  const newTotal = newTaxBeforeCess * (1 + TAX_RULES_FY2026_27.cessPct / 100);

  const oldTaxable = Math.max(0, grossIncome - TAX_RULES_FY2026_27.oldRegimeStandardDeduction - Math.max(0, oldRegimeDeductions));
  const oldRebateApplies = oldTaxable <= TAX_RULES_FY2026_27.oldRegimeRebate87ATaxableLimit;
  const oldTaxBeforeCess = oldRebateApplies ? 0 : taxFromSlabs(oldTaxable, TAX_RULES_FY2026_27.oldRegimeSlabs);
  const oldTotal = oldTaxBeforeCess * (1 + TAX_RULES_FY2026_27.cessPct / 100);

  return {
    new: { regime: "new", taxableIncome: newTaxable, taxBeforeCess: newTaxBeforeCess, totalTax: newTotal, rebateApplied: newRebateApplies },
    old: { regime: "old", taxableIncome: oldTaxable, taxBeforeCess: oldTaxBeforeCess, totalTax: oldTotal, rebateApplied: oldRebateApplies },
    better: newTotal <= oldTotal ? "new" : "old",
  };
}
