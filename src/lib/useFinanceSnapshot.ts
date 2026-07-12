import { useQuery, useQueryClient } from "@tanstack/react-query";
import { db, inr } from "@/lib/db";
import { calcNetWorth, calcCreditUtilization, calcHealthScore } from "@/lib/financeMetrics";

/** Shared finance data-load + derived-metrics hook — extracted from
 * Finance.tsx's Overview() so it and Home.tsx's Pulse panel compute net
 * worth/utilization/health score identically instead of maintaining two
 * copies of the same Promise.all + derivation logic that could silently
 * drift.
 *
 * Backed by TanStack Query so mutations elsewhere (statement uploads,
 * reconciliation runs, config edits) can invalidate a single key and every
 * consumer re-renders together. Use `invalidateFinance(qc)` from those
 * mutation callbacks instead of hand-rolled `refresh()` calls. */

export const FINANCE_SNAPSHOT_KEY = ["finance", "snapshot"] as const;

// db.* wrappers currently return `AnyRow` (see src/lib/db.ts) — the
// Snapshot shape stays loose here until db.ts is tightened. Post-migration
// (2026-07-12) the DB does have `current_balance`, `total_due`,
// `parser_source`, and `jarvis_actions.{type, expected_date, message}`, so
// reads below like `a.current_balance` are no longer against ghost columns.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Snapshot = {
  accounts: any[]; cards: any[]; loans: any[]; goals: any[]; subs: any[];
  month: { spend: number; income: number };
  categories: { category: string; amount: number }[];
  dues: any[];
  cardStatements: Map<string, any>;
  alerts: any[];
  trend: { month: string; spend: number; income: number; net: number }[];
};

async function loadFinanceSnapshot(): Promise<Snapshot> {
  const [a, c, l, g, s, m, cat, upcoming, latestByCard, openAlerts, trend] = await Promise.all([
    db.accounts.list(), db.cards.list(), db.loans.list(), db.goals.list(), db.subscriptions.list(), db.transactions.monthSummary(),
    db.transactions.categorySummary(), db.statements.upcomingDues(), db.statements.latestByCard(), db.alerts.list({ status: "open" }),
    db.transactions.trend(6),
  ]);
  return { accounts: a, cards: c, loans: l, goals: g, subs: s, month: m, categories: cat, dues: upcoming, cardStatements: latestByCard, alerts: openAlerts, trend };
}

export function invalidateFinance(qc: ReturnType<typeof useQueryClient>) {
  return qc.invalidateQueries({ queryKey: FINANCE_SNAPSHOT_KEY });
}

export function useFinanceSnapshot() {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({
    queryKey: FINANCE_SNAPSHOT_KEY,
    queryFn: loadFinanceSnapshot,
    // I3 — Prevent rapid tab focus refetches from clobbering local optimistic
    // updates (e.g. dismissed alerts via setAlerts) before the server catches up.
    staleTime: 30_000,
  });

  const accounts = data?.accounts ?? [];
  const cards = data?.cards ?? [];
  const loans = data?.loans ?? [];
  const goals = data?.goals ?? [];
  const subs = data?.subs ?? [];
  const categories = data?.categories ?? [];
  const dues = data?.dues ?? [];
  const cardStatements: Map<string, any> = data?.cardStatements ?? new Map();
  const alerts = data?.alerts ?? [];
  const month = data?.month ?? { spend: 0, income: 0 };
  const trend = data?.trend ?? [];

  const state = {
    accounts: accounts.length, cards: cards.length, loans: loans.length,
    goals: goals.length, subs: subs.length, spend: month.spend, income: month.income,
  };

  const netWorth = calcNetWorth({ accounts, cardDebts: Array.from(cardStatements.values()), loans, goals });
  const utilization = calcCreditUtilization(cards.map((c: any) => ({
    cardId: c.id, cardName: c.card_name, limit: c.limit_amount, totalDue: cardStatements.get(c.id)?.total_due,
  })));
  const hasBalanceData = accounts.some((a: any) => a.current_balance != null);
  const trackedObligations = subs.filter((s: any) => s.linked_account_id || s.linked_card_id).length
    + loans.filter((l: any) => l.linked_account_id).length;
  const health = calcHealthScore({
    income: state.income, spend: state.spend, utilizationPct: utilization.aggregatePct,
    openAlerts: alerts.length, trackedObligations,
    assets: netWorth.assets, liabilities: netWorth.liabilities, hasBalanceData,
  });

  // ---- 2e interconnection layer ----
  // Unified bills stream: statement dues + subs + loans, sorted by date,
  // clipped to the next 30 days. One list drives Overview + HUD Pulse.
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const horizon = new Date(now); horizon.setDate(horizon.getDate() + 30);
  const withinHorizon = (iso?: string | null) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= now.getTime() && t <= horizon.getTime();
  };
  type Bill = { id: string; kind: "statement" | "subscription" | "loan"; label: string; amount: number | null; dueDate: string; to?: string };
  const bills: Bill[] = [];
  for (const d of dues) {
    if (!withinHorizon(d.due_date)) continue;
    bills.push({
      id: `stmt-${d.id}`, kind: "statement",
      label: d.credit_cards?.card_name ?? d.financial_accounts?.nickname ?? "statement",
      amount: d.total_due != null ? Number(d.total_due) : null,
      dueDate: d.due_date, to: "/finance/statements",
    });
  }
  for (const s of subs) {
    if (!withinHorizon(s.next_due_date)) continue;
    bills.push({
      id: `sub-${s.id}`, kind: "subscription", label: s.name ?? "subscription",
      amount: s.amount != null ? Number(s.amount) : null,
      dueDate: s.next_due_date, to: "/finance/subs",
    });
  }
  for (const l of loans) {
    if (!withinHorizon(l.next_due_date)) continue;
    bills.push({
      id: `loan-${l.id}`, kind: "loan", label: l.lender_name ?? "loan",
      amount: l.emi_amount != null ? Number(l.emi_amount) : null,
      dueDate: l.next_due_date, to: "/finance/loans",
    });
  }
  bills.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const upcomingBills = bills;
  const upcomingBillsTotal = bills.reduce((s, b) => s + (b.amount ?? 0), 0);

  // Goal projections: months to reach target at current monthly net savings
  // vs months remaining until target_date. Flags any goal that will miss.
  const monthlyNet = trend.length ? trend.reduce((s, t) => s + t.net, 0) / trend.length : (state.income - state.spend);
  const goalProjections = goals.map((g: any) => {
    const target = Number(g.target_amount) || 0;
    const current = Number(g.current_amount) || 0;
    const remaining = Math.max(0, target - current);
    const monthsToReach = monthlyNet > 0 ? Math.ceil(remaining / monthlyNet) : null;
    let monthsLeft: number | null = null;
    if (g.target_date) {
      const d = new Date(g.target_date);
      if (!Number.isNaN(d.getTime())) {
        monthsLeft = Math.max(0, Math.round((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24 * 30)));
      }
    }
    const status: "on-track" | "at-risk" | "no-data" =
      remaining === 0 ? "on-track"
      : monthsToReach == null ? "no-data"
      : monthsLeft != null && monthsToReach > monthsLeft ? "at-risk"
      : "on-track";
    return { id: g.id, title: g.title, target, current, remaining, monthsToReach, monthsLeft, status };
  });

  // Automated insights — the connective tissue between raw data and the user.
  // These are strictly derived; no server calls. Ranked highest-impact first.
  const insights: { id: string; severity: "info" | "warn" | "danger"; text: string; to?: string }[] = [];
  if (state.spend > state.income && state.income > 0) {
    insights.push({ id: "burn", severity: "danger", text: `Spending ${inr(state.spend - state.income)} more than income this month`, to: "/finance/txns" });
  }
  if (utilization.aggregatePct != null && utilization.aggregatePct > 30) {
    insights.push({ id: "util", severity: utilization.aggregatePct > 60 ? "danger" : "warn",
      text: `Card utilization at ${utilization.aggregatePct}% — aim below 30% for credit health`, to: "/finance/cards" });
  }
  if (upcomingBills.length && state.income > 0 && upcomingBillsTotal > state.income) {
    insights.push({ id: "bills", severity: "warn",
      text: `${inr(upcomingBillsTotal)} in bills coming up — exceeds this month's income`, to: "/finance/subs" });
  }
  const atRiskGoals = goalProjections.filter((g) => g.status === "at-risk");
  if (atRiskGoals.length) {
    insights.push({ id: "goals", severity: "warn",
      text: `${atRiskGoals.length} goal${atRiskGoals.length > 1 ? "s" : ""} off track at current savings pace`, to: "/finance/goals" });
  }
  if (alerts.length) {
    insights.push({ id: "alerts", severity: "warn", text: `${alerts.length} reconciliation alert${alerts.length > 1 ? "s" : ""} open` });
  }
  if (trend.length >= 3) {
    const last3 = trend.slice(-3);
    const trending = last3.every((t, i) => i === 0 || t.spend >= last3[i - 1].spend);
    if (trending && last3[2].spend > last3[0].spend * 1.15) {
      insights.push({ id: "spend-up", severity: "info",
        text: `Spend up ${Math.round((last3[2].spend / Math.max(1, last3[0].spend) - 1) * 100)}% over 3 months` });
    }
  }

  // Legacy setter kept so Finance.tsx's "dismiss alert" flow can still splice
  // the local list without a full refetch. Writes into the cached query data.
  const setAlerts = (next: any[] | ((prev: any[]) => any[])) => {
    qc.setQueryData(FINANCE_SNAPSHOT_KEY, (prev: Snapshot | undefined) => {
      if (!prev) return prev;
      const value = typeof next === "function" ? next(prev.alerts) : next;
      return { ...prev, alerts: value };
    });
  };

  return {
    loading: isLoading,
    state, categories, dues, accounts, cards, loans, goals, subs,
    cardStatements, alerts, setAlerts, netWorth, utilization, health,
    trend, upcomingBills, upcomingBillsTotal, goalProjections, insights, monthlyNet,
    refresh: () => refetch().then(() => undefined),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
