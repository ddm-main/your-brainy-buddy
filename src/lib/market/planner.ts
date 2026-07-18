// Trade Planner — pure client-side risk/position sizing math.
// All inputs in absolute rupees / percent. No I/O; safe to unit-test.

export interface PlanInput {
  portfolioSize: number;   // total capital, ₹
  riskPct: number;         // % of portfolio you're willing to lose on this trade
  entry: number;           // entry price ₹
  stopLoss: number;        // stop-loss price ₹
  targets: number[];       // 1..N target prices ₹
  side: "long" | "short";
  brokerageBps?: number;   // per side, in basis points (10 bps = 0.10%)
  slippageBps?: number;    // per side
}

export interface PlanResult {
  riskPerShare: number;
  rupeeRisk: number;         // portfolio × risk%
  quantity: number;          // shares to buy/sell
  positionValue: number;     // qty × entry
  positionPctOfCapital: number;
  maxLoss: number;           // qty × riskPerShare + fees
  totalFees: number;         // brokerage + slippage, both sides
  breakeven: number;         // entry + fees converted per-share
  targets: Array<{ price: number; rr: number; profit: number; profitPct: number }>;
  warnings: string[];
}

const clampPositive = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

export function computePlan(inp: PlanInput): PlanResult {
  const warnings: string[] = [];
  const portfolio = clampPositive(inp.portfolioSize);
  const riskPct = clampPositive(inp.riskPct);
  const entry = clampPositive(inp.entry);
  const sl = clampPositive(inp.stopLoss);
  const brokerage = (inp.brokerageBps ?? 3) / 10000;
  const slippage = (inp.slippageBps ?? 5) / 10000;

  const side = inp.side;
  const riskPerShare = side === "long" ? entry - sl : sl - entry;
  const rupeeRisk = portfolio * (riskPct / 100);

  if (riskPerShare <= 0) {
    warnings.push(side === "long" ? "Stop-loss must be below entry" : "Stop-loss must be above entry");
  }
  if (portfolio <= 0) warnings.push("Enter portfolio size");
  if (riskPct <= 0) warnings.push("Enter risk %");
  if (riskPct > 5) warnings.push("Risking more than 5% per trade is aggressive");

  const quantity = riskPerShare > 0 ? Math.floor(rupeeRisk / riskPerShare) : 0;
  const positionValue = quantity * entry;
  const positionPctOfCapital = portfolio > 0 ? (positionValue / portfolio) * 100 : 0;

  if (positionValue > portfolio) {
    warnings.push("Position value exceeds portfolio — reduce risk % or widen stop");
  }

  // Two-sided fees (entry + exit) as rupees.
  const feeRate = brokerage + slippage;
  const totalFees = positionValue * feeRate * 2;
  const feePerShare = quantity > 0 ? totalFees / quantity : 0;
  const breakeven = side === "long" ? entry + feePerShare : entry - feePerShare;
  const maxLoss = quantity * riskPerShare + totalFees;

  const targets = (inp.targets ?? [])
    .map((t) => clampPositive(t))
    .filter((t) => t > 0)
    .map((price) => {
      const reward = side === "long" ? price - entry : entry - price;
      const rr = riskPerShare > 0 ? reward / riskPerShare : 0;
      const profit = quantity * reward - totalFees;
      const profitPct = portfolio > 0 ? (profit / portfolio) * 100 : 0;
      return { price, rr, profit, profitPct };
    });

  return {
    riskPerShare,
    rupeeRisk,
    quantity,
    positionValue,
    positionPctOfCapital,
    maxLoss,
    totalFees,
    breakeven,
    targets,
    warnings,
  };
}

const PREFS_KEY = "jarvis.market.planner.defaults";
export interface PlannerDefaults {
  portfolioSize: number;
  riskPct: number;
  brokerageBps: number;
  slippageBps: number;
}
export const DEFAULT_PLANNER: PlannerDefaults = {
  portfolioSize: 500000,
  riskPct: 1,
  brokerageBps: 3,
  slippageBps: 5,
};
export function loadPlannerDefaults(): PlannerDefaults {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PLANNER;
    return { ...DEFAULT_PLANNER, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PLANNER;
  }
}
export function savePlannerDefaults(d: PlannerDefaults) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(d)); } catch { /* ignore */ }
}
