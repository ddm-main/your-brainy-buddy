/**
 * Pure investment math — no React/DB imports, never throws. Mirrors the
 * conventions in loanCalc.ts/financeMetrics.ts (return null/safe defaults on
 * invalid input rather than throwing).
 */

export interface InvestmentTxnLike {
  txn_type: "buy" | "sell" | "sip" | "dividend" | "bonus" | "split";
  txn_date: string;
  units?: number | null;
  price?: number | null;
  amount: number;
}

export interface DerivedHolding {
  units: number;
  investedAmount: number;
  avgCost: number | null;
  realizedGain: number;
}

/**
 * Derives current units/invested-amount/avg-cost/realized-gain from a
 * holding's full transaction ledger, using weighted-average cost basis (the
 * standard method for mutual fund/stock cost accounting). Called on read —
 * see the migration comment in investment_transactions for why this is never
 * denormalized onto investment_holdings.
 */
export function deriveHoldingFromTransactions(txns: InvestmentTxnLike[]): DerivedHolding {
  let units = 0;
  let investedAmount = 0;
  let realizedGain = 0;
  const sorted = [...txns].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
  for (const t of sorted) {
    const txnUnits = Number(t.units) || 0;
    const amount = Number(t.amount) || 0;
    if (t.txn_type === "buy" || t.txn_type === "sip") {
      units += txnUnits;
      investedAmount += amount;
    } else if (t.txn_type === "bonus") {
      units += txnUnits; // free units, no cost added
    } else if (t.txn_type === "split") {
      // txnUnits carries the *delta* in units from the split (caller's
      // responsibility to compute); invested_amount is unaffected.
      units += txnUnits;
    } else if (t.txn_type === "sell") {
      const avgCostBefore = units > 0 ? investedAmount / units : 0;
      const sellUnits = Math.min(txnUnits, units);
      const costOfSold = avgCostBefore * sellUnits;
      realizedGain += amount - costOfSold;
      units -= sellUnits;
      investedAmount -= costOfSold;
    } else if (t.txn_type === "dividend") {
      realizedGain += amount; // cash dividend, doesn't touch units/cost
    }
  }
  units = Math.max(0, units);
  investedAmount = Math.max(0, investedAmount);
  return {
    units,
    investedAmount,
    avgCost: units > 0 ? investedAmount / units : null,
    realizedGain,
  };
}

export function calcGainLoss(currentValue: number, investedAmount: number): { gain: number; gainPct: number | null } {
  const gain = currentValue - investedAmount;
  return { gain, gainPct: investedAmount > 0 ? (gain / investedAmount) * 100 : null };
}

export function calcAbsoluteReturn(currentValue: number, investedAmount: number): number | null {
  if (!(investedAmount > 0)) return null;
  return ((currentValue - investedAmount) / investedAmount) * 100;
}

/**
 * CAGR between an invested amount and current value over a holding period.
 * Returns null for a holding period under ~1 month (CAGR is meaningless/
 * wildly unstable at that horizon) or non-finite results.
 */
export function calcCagr(investedAmount: number, currentValue: number, startDate: string, asOf: string = new Date().toISOString().slice(0, 10)): number | null {
  if (!(investedAmount > 0) || !(currentValue >= 0)) return null;
  const start = new Date(startDate).getTime();
  const end = new Date(asOf).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const years = (end - start) / (365.25 * 86400000);
  if (years < 1 / 12) return null;
  const ratio = currentValue / investedAmount;
  if (ratio <= 0) return null;
  const cagr = (Math.pow(ratio, 1 / years) - 1) * 100;
  return Number.isFinite(cagr) ? cagr : null;
}

export interface XirrCashflow {
  date: string; // ISO yyyy-mm-dd
  amount: number; // negative = money out (investment/buy), positive = money in (redemption/current value)
}

const XIRR_MAX_ITERATIONS = 100;
const XIRR_TOLERANCE = 1e-7;

function xnpv(rate: number, cashflows: { t: number; amount: number }[]): number {
  return cashflows.reduce((sum, cf) => sum + cf.amount / Math.pow(1 + rate, cf.t), 0);
}

function xnpvDerivative(rate: number, cashflows: { t: number; amount: number }[]): number {
  return cashflows.reduce((sum, cf) => sum + (-cf.t * cf.amount) / Math.pow(1 + rate, cf.t + 1), 0);
}

/**
 * XIRR via Newton-Raphson with a bisection fallback if it fails to converge
 * or diverges — never loops forever, returns null (not NaN, not a throw) on
 * non-convergence or insufficient/invalid data. `cashflows` needs at least
 * one negative and one positive amount to be solvable.
 */
export function calcXirr(cashflows: XirrCashflow[]): number | null {
  const valid = cashflows.filter((cf) => Number.isFinite(cf.amount) && cf.amount !== 0 && !Number.isNaN(new Date(cf.date).getTime()));
  if (valid.length < 2) return null;
  const hasNeg = valid.some((cf) => cf.amount < 0);
  const hasPos = valid.some((cf) => cf.amount > 0);
  if (!hasNeg || !hasPos) return null;

  const t0 = new Date(valid[0].date).getTime();
  const cfs = valid.map((cf) => ({ t: (new Date(cf.date).getTime() - t0) / (365.25 * 86400000), amount: cf.amount }));

  let rate = 0.1;
  for (let i = 0; i < XIRR_MAX_ITERATIONS; i++) {
    const f = xnpv(rate, cfs);
    const df = xnpvDerivative(rate, cfs);
    if (Math.abs(df) < 1e-12) break;
    const next = rate - f / df;
    if (!Number.isFinite(next) || next <= -0.999999) break;
    if (Math.abs(next - rate) < XIRR_TOLERANCE) return next * 100;
    rate = next;
  }

  // Newton-Raphson didn't converge cleanly — bisection fallback over a wide,
  // sane range. If xnpv doesn't change sign across it, the data genuinely
  // isn't solvable (never infinite-loops).
  let lo = -0.99, hi = 10;
  let fLo = xnpv(lo, cfs);
  const fHi = xnpv(hi, cfs);
  if (Number.isNaN(fLo) || Number.isNaN(fHi) || fLo * fHi > 0) return null;
  for (let i = 0; i < XIRR_MAX_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const fMid = xnpv(mid, cfs);
    if (Math.abs(fMid) < XIRR_TOLERANCE || (hi - lo) / 2 < XIRR_TOLERANCE) return mid * 100;
    if (fLo * fMid < 0) { hi = mid; } else { lo = mid; fLo = fMid; }
  }
  return null;
}

/** Builds XIRR cashflows from a transaction ledger + a final current-value mark. */
export function xirrCashflowsFromTransactions(txns: InvestmentTxnLike[], currentValue: number, asOf: string = new Date().toISOString().slice(0, 10)): XirrCashflow[] {
  const flows: XirrCashflow[] = [];
  for (const t of txns) {
    const amount = Number(t.amount) || 0;
    if (t.txn_type === "buy" || t.txn_type === "sip") flows.push({ date: t.txn_date, amount: -amount });
    else if (t.txn_type === "sell" || t.txn_type === "dividend") flows.push({ date: t.txn_date, amount });
  }
  if (currentValue > 0) flows.push({ date: asOf, amount: currentValue });
  return flows;
}

export interface AllocationSlice {
  key: string;
  value: number;
  pct: number;
}

/** Groups holdings by a key (asset_type, sector, category, ...) for allocation/diversification views. */
export function calcAllocation(holdings: { value: number; key: string | null | undefined }[]): AllocationSlice[] {
  const total = holdings.reduce((sum, h) => sum + (Number(h.value) || 0), 0);
  const byKey = new Map<string, number>();
  for (const h of holdings) {
    const key = h.key?.trim() || "uncategorized";
    byKey.set(key, (byKey.get(key) ?? 0) + (Number(h.value) || 0));
  }
  return [...byKey.entries()]
    .map(([key, value]) => ({ key, value, pct: total > 0 ? (value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}
