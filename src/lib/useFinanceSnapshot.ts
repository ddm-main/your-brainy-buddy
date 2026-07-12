import { useEffect, useState } from "react";
import { db } from "@/lib/db";
import { calcNetWorth, calcCreditUtilization, calcHealthScore } from "@/lib/financeMetrics";

/** Shared finance data-load + derived-metrics hook — extracted from
 * Finance.tsx's Overview() so it and Home.tsx's Pulse panel compute net
 * worth/utilization/health score identically instead of maintaining two
 * copies of the same Promise.all + derivation logic that could silently
 * drift. Straight extraction, no new logic. */
export function useFinanceSnapshot() {
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState({ accounts: 0, cards: 0, loans: 0, goals: 0, subs: 0, spend: 0, income: 0 });
  const [categories, setCategories] = useState<{ category: string; amount: number }[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [dues, setDues] = useState<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [accounts, setAccounts] = useState<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [cards, setCards] = useState<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [loans, setLoans] = useState<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [goals, setGoals] = useState<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [subs, setSubs] = useState<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [cardStatements, setCardStatements] = useState<Map<string, any>>(new Map());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [alerts, setAlerts] = useState<any[]>([]);

  const refresh = async () => {
    setLoading(true);
    try {
      const [a, c, l, g, s, m, cat, upcoming, latestByCard, openAlerts] = await Promise.all([
        db.accounts.list(), db.cards.list(), db.loans.list(), db.goals.list(), db.subscriptions.list(), db.transactions.monthSummary(),
        db.transactions.categorySummary(), db.statements.upcomingDues(), db.statements.latestByCard(), db.alerts.list({ status: "open" }),
      ]);
      setState({ accounts: a.length, cards: c.length, loans: l.length, goals: g.length, subs: s.length, spend: m.spend, income: m.income });
      setCategories(cat);
      setDues(upcoming);
      setAccounts(a); setCards(c); setLoans(l); setGoals(g); setSubs(s);
      setCardStatements(latestByCard);
      setAlerts(openAlerts);
    } finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);

  const netWorth = calcNetWorth({ accounts, cardDebts: Array.from(cardStatements.values()), loans, goals });
  const utilization = calcCreditUtilization(cards.map((c) => ({
    cardId: c.id, cardName: c.card_name, limit: c.limit_amount, totalDue: cardStatements.get(c.id)?.total_due,
  })));
  const hasBalanceData = accounts.some((a) => a.current_balance != null);
  // Only entities reconciliation.ts can actually monitor (linked to an
  // account/card) count toward the denominator — otherwise an unlinked
  // subscription would silently read as "reliable" for never alerting.
  const trackedObligations = subs.filter((s) => s.linked_account_id || s.linked_card_id).length
    + loans.filter((l) => l.linked_account_id).length;
  const health = calcHealthScore({
    income: state.income, spend: state.spend, utilizationPct: utilization.aggregatePct,
    openAlerts: alerts.length, trackedObligations,
    assets: netWorth.assets, liabilities: netWorth.liabilities, hasBalanceData,
  });

  return {
    loading, state, categories, dues, accounts, cards, loans, goals, subs,
    cardStatements, alerts, setAlerts, netWorth, utilization, health, refresh,
  };
}
