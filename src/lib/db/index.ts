// Barrel: `import { db } from "@/lib/db"` continues to work.
// Individual sub-modules can also be imported directly, e.g.
// `import { transactions } from "@/lib/db/transactions"`.

export * from "./client";
export * from "./format";

import { tasks } from "./tasks";
import { notes } from "./notes";
import { decisions } from "./decisions";
import { projects } from "./projects";
import { emails, emailAccounts } from "./emails";
import {
  banks,
  accounts,
  cards,
  loans,
  goals,
  budgets,
  insurancePolicies,
  subscriptions,
} from "./finance-core";
import {
  investmentAccounts,
  investmentHoldings,
  investmentTransactions,
  financeSettings,
  navSync,
  growwImport,
} from "./investments";
import { transactions } from "./transactions";
import { statements, finance, alerts } from "./statements";
import { actions, reminders } from "./jarvis";

export const db = {
  tasks,
  notes,
  decisions,
  projects,
  emails,
  emailAccounts,
  banks,
  accounts,
  cards,
  loans,
  goals,
  investmentAccounts,
  investmentHoldings,
  investmentTransactions,
  financeSettings,
  navSync,
  growwImport,
  budgets,
  insurancePolicies,
  subscriptions,
  transactions,
  statements,
  finance,
  alerts,
  actions,
  reminders,
};
