/** Pure finance-intelligence math — no React, no DB access (mirrors loanCalc.ts).
 * Every function takes plain data the caller already loaded and returns a
 * plain result; callers own fetching and rendering. */

import { calcEmi, roundCurrency } from "@/lib/loanCalc";

function sum(nums: Array<number | string | null | undefined>): number {
  return nums.reduce((s: number, n) => s + (Number(n) || 0), 0);
}
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------- Net worth ----------

export interface NetWorthInput {
  accounts: Array<{ current_balance?: number | string | null }>;
  cardDebts: Array<{ total_due?: number | string | null }>; // latest statement per card
  loans: Array<{ outstanding_amount?: number | string | null }>;
  goals: Array<{ current_amount?: number | string | null }>;
}
export interface NetWorthResult {
  netWorth: number;
  assets: number;
  cardDebt: number;
  loanDebt: number;
  liabilities: number;
  trackedSavings: number;
}

export function calcNetWorth(input: NetWorthInput): NetWorthResult {
  const assets = sum(input.accounts.map((a) => a.current_balance));
  const cardDebt = sum(input.cardDebts.map((c) => c.total_due));
  const loanDebt = sum(input.loans.map((l) => l.outstanding_amount));
  const trackedSavings = sum(input.goals.map((g) => g.current_amount));
  const liabilities = cardDebt + loanDebt;
  return { netWorth: assets - liabilities + trackedSavings, assets, cardDebt, loanDebt, liabilities, trackedSavings };
}

// ---------- Credit utilization ----------

export interface CardUtilizationInput {
  cardId: string;
  cardName: string;
  limit?: number | string | null;
  totalDue?: number | string | null; // from latest statement, null = no statement yet
}
export interface CardUtilizationResult {
  cardId: string;
  cardName: string;
  limit: number | null;
  balance: number | null;
  utilizationPct: number | null; // null when no limit or no statement yet
}
export interface UtilizationSummary {
  perCard: CardUtilizationResult[];
  aggregatePct: number | null;
}

export function calcCreditUtilization(cards: CardUtilizationInput[]): UtilizationSummary {
  const perCard: CardUtilizationResult[] = cards.map((c) => {
    const limit = c.limit != null && Number(c.limit) > 0 ? Number(c.limit) : null;
    const balance = c.totalDue != null ? Number(c.totalDue) : null;
    const utilizationPct = limit != null && balance != null ? round1((balance / limit) * 100) : null;
    return { cardId: c.cardId, cardName: c.cardName, limit, balance, utilizationPct };
  });
  const withData = perCard.filter((c) => c.limit != null && c.balance != null);
  const totalLimit = sum(withData.map((c) => c.limit));
  const totalBalance = sum(withData.map((c) => c.balance));
  const aggregatePct = totalLimit > 0 ? round1((totalBalance / totalLimit) * 100) : null;
  return { perCard, aggregatePct };
}

// ---------- Health score ----------

export interface HealthScoreComponent {
  label: string;
  score: number;
  max: number;
  detail: string;
}
export interface HealthScoreInput {
  income: number;
  spend: number;
  utilizationPct: number | null; // aggregate, from calcCreditUtilization
  openAlerts: number;
  trackedObligations: number; // subs.length + loans.length
  assets: number;
  liabilities: number;
  hasBalanceData: boolean; // true if any account has current_balance set
}
export interface HealthScoreResult {
  score: number; // 0-100
  components: HealthScoreComponent[];
}

/** 4 transparent, weighted components. Missing data never punishes — each
 * component gives neutral (or full) credit until real data exists, so the
 * score starts honest ("we don't know yet") rather than artificially low. */
export function calcHealthScore(input: HealthScoreInput): HealthScoreResult {
  const components: HealthScoreComponent[] = [];

  // 1. Savings rate — 30pts, 20% savings rate = full marks.
  if (input.income <= 0) {
    components.push({ label: "savings rate", score: 15, max: 30, detail: "no income data yet" });
  } else {
    const rate = (input.income - input.spend) / input.income;
    const frac = clamp01(rate / 0.2);
    components.push({ label: "savings rate", score: Math.round(frac * 30), max: 30, detail: `${Math.round(rate * 100)}% this month` });
  }

  // 2. Credit utilization — 25pts, 0% = full marks, 50%+ = zero.
  if (input.utilizationPct == null) {
    components.push({ label: "credit utilization", score: 25, max: 25, detail: "no card balance data yet" });
  } else {
    const frac = clamp01(1 - input.utilizationPct / 50);
    components.push({ label: "credit utilization", score: Math.round(frac * 25), max: 25, detail: `${round1(input.utilizationPct)}% used` });
  }

  // 3. Payment reliability — 25pts, share of tracked obligations with no open alert.
  if (input.trackedObligations <= 0) {
    components.push({ label: "payment reliability", score: 25, max: 25, detail: "nothing tracked yet" });
  } else {
    const frac = clamp01(1 - input.openAlerts / input.trackedObligations);
    components.push({ label: "payment reliability", score: Math.round(frac * 25), max: 25, detail: `${input.openAlerts} open issue${input.openAlerts === 1 ? "" : "s"}` });
  }

  // 4. Debt vs. assets — 20pts. hasBalanceData=false gets the same
  // neutral half-credit as savings-rate's "no data" case, rather than
  // scoring near-zero for anyone with debt but no balance entered yet.
  if (!input.hasBalanceData) {
    components.push({ label: "debt vs. assets", score: 10, max: 20, detail: "no account balances entered yet" });
  } else if (input.assets <= 0) {
    const hasDebt = input.liabilities > 0;
    components.push({ label: "debt vs. assets", score: hasDebt ? 0 : 20, max: 20, detail: hasDebt ? "liabilities exceed tracked assets" : "no liabilities tracked" });
  } else {
    const leverage = input.liabilities / input.assets;
    const frac = clamp01(1 - leverage);
    components.push({ label: "debt vs. assets", score: Math.round(frac * 20), max: 20, detail: `${round1(leverage * 100)}% leverage` });
  }

  return { score: components.reduce((s, c) => s + c.score, 0), components };
}

// ---------- Amortization ----------

export interface AmortizationRow {
  month: number;
  payment: number;
  principal: number;
  interest: number;
  balance: number;
}

/** Month-by-month reducing-balance schedule, reusing calcEmi's exact r/edge
 * handling rather than re-deriving it. Last row absorbs rounding drift so
 * the balance always lands on exactly 0. Returns null on invalid input
 * (mirrors loanCalc's never-throw convention). */
export function generateAmortizationSchedule(principal: number, annualRatePct: number, tenureMonths: number): AmortizationRow[] | null {
  const emi = calcEmi(principal, annualRatePct, tenureMonths);
  if (emi == null) return null;
  const r = annualRatePct / 1200;
  const rows: AmortizationRow[] = [];
  let balance = principal;
  for (let month = 1; month <= tenureMonths; month++) {
    const interest = balance * r;
    let principalPaid = emi - interest;
    let payment = emi;
    if (month === tenureMonths) {
      principalPaid = balance;
      payment = principalPaid + interest;
    }
    balance -= principalPaid;
    if (month === tenureMonths) balance = 0;
    rows.push({
      month,
      payment: roundCurrency(payment),
      principal: roundCurrency(principalPaid),
      interest: roundCurrency(interest),
      balance: roundCurrency(Math.max(0, balance)),
    });
  }
  return rows;
}

// ---------- Prepayment / foreclosure ----------

export interface PrepaymentImpact {
  originalRemainingInterest: number;
  newRemainingInterest: number;
  interestSaved: number;
  originalMonthsLeft: number;
  newMonthsLeft: number; // reduce_tenure: the new (shorter) payoff month count; reduce_emi: unchanged
  newEmi: number | null; // reduce_emi: the new (lower) EMI; reduce_tenure: null (EMI unchanged)
}

const MAX_PREPAYMENT_MONTHS = 720; // matches loanCalc.ts's MAX_TENURE_MONTHS guard

/** What a lump-sum prepayment today does to the rest of the loan — reuses
 * generateAmortizationSchedule/calcEmi's exact reducing-balance math twice
 * (baseline vs. post-prepayment) rather than a bespoke recurrence. Returns
 * null on invalid input, never throws (mirrors loanCalc's convention). */
export function calcPrepaymentImpact(
  outstanding: number,
  annualRatePct: number,
  remainingMonths: number,
  prepaymentAmount: number,
  mode: "reduce_tenure" | "reduce_emi",
  currentEmi: number,
): PrepaymentImpact | null {
  if (!Number.isFinite(prepaymentAmount) || prepaymentAmount <= 0 || prepaymentAmount >= outstanding) return null;
  if (!Number.isFinite(currentEmi) || currentEmi <= 0) return null;

  const baseline = generateAmortizationSchedule(outstanding, annualRatePct, remainingMonths);
  if (!baseline) return null;
  const originalRemainingInterest = roundCurrency(sum(baseline.map((r) => r.interest)));
  const newPrincipal = outstanding - prepaymentAmount;

  if (mode === "reduce_emi") {
    const newEmi = calcEmi(newPrincipal, annualRatePct, remainingMonths);
    const newSchedule = generateAmortizationSchedule(newPrincipal, annualRatePct, remainingMonths);
    if (newEmi == null || !newSchedule) return null;
    const newRemainingInterest = roundCurrency(sum(newSchedule.map((r) => r.interest)));
    return {
      originalRemainingInterest, newRemainingInterest,
      interestSaved: roundCurrency(originalRemainingInterest - newRemainingInterest),
      originalMonthsLeft: remainingMonths, newMonthsLeft: remainingMonths,
      newEmi: roundCurrency(newEmi),
    };
  }

  // reduce_tenure: hold the EMI fixed, replay the schedule against the
  // reduced principal to find the new (shorter) payoff month count.
  const r = annualRatePct / 1200;
  let balance = newPrincipal;
  let newRemainingInterest = 0;
  let months = 0;
  while (balance > 0.01 && months < MAX_PREPAYMENT_MONTHS) {
    const interest = balance * r;
    const principalPaid = Math.min(currentEmi - interest, balance);
    if (principalPaid <= 0) return null; // EMI doesn't even cover interest at this balance — can't amortize
    balance -= principalPaid;
    newRemainingInterest += interest;
    months++;
  }
  if (months >= MAX_PREPAYMENT_MONTHS) return null;
  return {
    originalRemainingInterest, newRemainingInterest: roundCurrency(newRemainingInterest),
    interestSaved: roundCurrency(originalRemainingInterest - newRemainingInterest),
    originalMonthsLeft: remainingMonths, newMonthsLeft: months,
    newEmi: null,
  };
}

/** Paying off the full outstanding balance today instead of running the
 * schedule to term — the "savings" are simply all the interest that would
 * otherwise still accrue. */
export function calcForeclosureQuote(outstanding: number, annualRatePct: number, remainingMonths: number): { interestSavedByForeclosing: number } | null {
  const schedule = generateAmortizationSchedule(outstanding, annualRatePct, remainingMonths);
  if (!schedule) return null;
  return { interestSavedByForeclosing: roundCurrency(sum(schedule.map((r) => r.interest))) };
}
