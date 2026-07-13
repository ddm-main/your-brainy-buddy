// Shared Supabase client + helpers for the db/* modules.
// Client is cast to `any` so PostgREST's generic inference doesn't fight the
// simpler wrapper shapes; runtime behaviour is unchanged.

import { supabase as _supabase } from "@/integrations/supabase/client";
import { authFetch } from "@/lib/authFetch";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const supabase: any = _supabase as any;
export type AnyRow = Record<string, any>;

export async function callEdgeFunction(
  name: string,
  body: Record<string, unknown>,
): Promise<any> {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`;
  let r: Response;
  try {
    r = await authFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    console.error(`callEdgeFunction: network failure reaching "${name}"`);
    throw new Error("Could not reach the server — check your connection and try again.");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error ?? r.statusText);
  return j;
}

// Row types are loosely typed because the generated Database schema doesn't
// include the JARVIS tables yet.
export type Task = AnyRow;
export type TaskInsert = AnyRow;
export type Note = AnyRow;
export type Decision = AnyRow;
export type Project = AnyRow;
export type ProjectUpdate = AnyRow;
export type EmailAccount = AnyRow;
export type EmailRow = AnyRow;
export type Bank = AnyRow;
export type FinancialAccount = AnyRow;
export type CreditCard = AnyRow;
export type Loan = AnyRow;
export type FinancialGoal = AnyRow;
export type Subscription = AnyRow;
export type Transaction = AnyRow;
export type Statement = AnyRow;
export type FinanceAlert = AnyRow;
export type JarvisAction = AnyRow;
export type JarvisReminder = AnyRow;
export type InvestmentAccount = AnyRow;
export type InvestmentHolding = AnyRow;
export type InvestmentTransaction = AnyRow;
export type Budget = AnyRow;
export type InsurancePolicy = AnyRow;
