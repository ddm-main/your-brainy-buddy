import { supabase as _supabase, SAFE_SUPABASE_URL } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { authFetch } from "@/lib/authFetch";
import { toSafeError } from "@/lib/errors";

/**
 * Thin typed wrappers over the JARVIS Supabase tables.
 * All access is under the single-user posture — no user_id filter.
 * Errors bubble to callers, which should surface via `useUi().push`.
 *
 * The client itself is cast to `any` so the query builder's inferred generics
 * don't fight our simpler wrapper shapes at compile time. Runtime behaviour is
 * unchanged; row types below still come from the generated `Database` schema.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = _supabase as any;

// Table row types are loosely typed here because the generated `Database`
// schema for this project doesn't include the JARVIS tables yet. Runtime
// behaviour is unchanged; callers still get object shapes returned by Supabase.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRow = Record<string, any>;
void ({} as Database); // keep import used

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


async function callEdgeFunction(name: string, body: Record<string, unknown>): Promise<any> {
  const url = `${SAFE_SUPABASE_URL}/functions/v1/${name}`;
  let r: Response;
  try {
    r = await authFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    // fetch() throws a bare "Failed to fetch" TypeError for DNS/CORS/network
    // failures. Keep the function slug in the console for debugging — it
    // shouldn't reach a user-facing toast (internal implementation detail).
    console.error(`callEdgeFunction: network failure reaching "${name}"`);
    throw new Error("Could not reach the server — check your connection and try again.");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error ?? r.statusText);
  return j;
}

export const db = {
  // ---------- Tasks ----------
  tasks: {
    list: async (opts: { status?: Task["status"]; focus?: boolean; limit?: number } = {}) => {
      let q = supabase.from("tasks").select("*").order("created_at", { ascending: false });
      if (opts.status) q = q.eq("status", opts.status);
      if (opts.focus) q = q.eq("focus", true);
      if (opts.limit) q = q.limit(opts.limit);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
    listOpen: async (limit = 50) => {
      const { data, error } = await supabase
        .from("tasks")
        .select("*")
        .neq("status", "done")
        .neq("status", "cancelled")
        .order("due_at", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    focus: async (limit = 7) => {
      const { data, error } = await supabase
        .from("tasks")
        .select("*")
        .eq("focus", true)
        .neq("status", "done")
        .neq("status", "cancelled")
        .order("priority", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    create: async (t: Partial<TaskInsert> & { title: string }) => {
      const { data, error } = await supabase.from("tasks").insert(t).select().single();
      if (error) throw error;
      return data;
    },
    setStatus: async (id: string, status: Task["status"]) => {
      const { error } = await supabase.from("tasks").update({ status }).eq("id", id);
      if (error) throw error;
    },
    setFocus: async (id: string, focus: boolean) => {
      const { error } = await supabase.from("tasks").update({ focus }).eq("id", id);
      if (error) throw error;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("tasks").delete().eq("id", id);
      if (error) throw error;
    },
  },

  // ---------- Notes ----------
  notes: {
    list: async (limit = 100) => {
      const { data, error } = await supabase
        .from("notes")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    create: async (n: { title: string; content?: string; note_type?: Note["note_type"]; linked_project_id?: string | null }) => {
      const { data, error } = await supabase.from("notes").insert(n).select().single();
      if (error) throw error;
      return data;
    },
    update: async (id: string, patch: Partial<Note>) => {
      const { error } = await supabase.from("notes").update(patch).eq("id", id);
      if (error) throw error;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("notes").delete().eq("id", id);
      if (error) throw error;
    },
  },

  // ---------- Decisions ----------
  decisions: {
    list: async (limit = 50) => {
      const { data, error } = await supabase
        .from("decisions").select("*, projects(name)")
        .order("decided_on", { ascending: false }).limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    create: async (d: { title: string; decision_text: string; context?: string; rationale?: string; options_considered?: string; decided_on?: string; linked_project_id?: string | null }) => {
      const { data, error } = await supabase.from("decisions").insert(d).select().single();
      if (error) throw error;
      return data;
    },
    update: async (id: string, patch: Partial<Decision>) => {
      const { error } = await supabase.from("decisions").update(patch).eq("id", id);
      if (error) throw error;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("decisions").delete().eq("id", id);
      if (error) throw error;
    },
  },

  // ---------- Projects ----------
  projects: {
    list: async () => {
      const { data, error } = await supabase.from("projects")
        .select("*")
        .order("status", { ascending: true })
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    get: async (id: string) => {
      const { data, error } = await supabase.from("projects").select("*").eq("id", id).single();
      if (error) throw error;
      return data;
    },
    getBySlug: async (slug: string) => {
      const { data } = await supabase.from("projects").select("*").eq("slug", slug).maybeSingle();
      return data ?? null;
    },
    create: async (p: { name: string; description?: string; slug?: string; status?: Project["status"] }) => {
      const { data, error } = await supabase.from("projects").insert(p).select().single();
      if (error) throw error;
      return data;
    },
    update: async (id: string, patch: Partial<Project>) => {
      const { error } = await supabase.from("projects").update(patch).eq("id", id);
      if (error) throw error;
    },
    addUpdate: async (project_id: string, update_text: string) => {
      const { data, error } = await supabase.from("project_updates")
        .insert({ project_id, update_text }).select().single();
      if (error) throw error;
      return data;
    },
    updates: async (project_id: string, limit = 20) => {
      const { data, error } = await supabase.from("project_updates")
        .select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return data ?? [];
    },
  },

  // ---------- Inbox ----------
  emails: {
    list: async (category?: EmailRow["category"], limit = 50) => {
      let q = supabase.from("emails").select("*").order("received_at", { ascending: false, nullsFirst: false }).limit(limit);
      if (category) q = q.eq("category", category);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
    counts: async () => {
      // Small parallel count set
      const [unread, important, needsReply] = await Promise.all([
        supabase.from("emails").select("id", { count: "exact", head: true }),
        supabase.from("emails").select("id", { count: "exact", head: true }).eq("category", "important"),
        supabase.from("emails").select("id", { count: "exact", head: true }).eq("category", "needs_reply"),
      ]);
      return {
        unread: unread.count ?? 0,
        important: important.count ?? 0,
        needsReply: needsReply.count ?? 0,
      };
    },
  },
  emailAccounts: {
    list: async () => {
      const { data, error } = await supabase.from("email_accounts").select("*").order("email_address");
      if (error) throw error;
      return data ?? [];
    },
    create: async (a: { email_address: string; provider?: string; purpose?: EmailAccount["purpose"] }) => {
      const { data, error } = await supabase.from("email_accounts").insert(a).select().single();
      if (error) throw toSafeError(error, "Could not add that mailbox");
      return data;
    },
    update: async (id: string, patch: Record<string, any>) => {
      const { data, error } = await supabase.from("email_accounts").update(patch).eq("id", id).select().single();
      if (error) throw toSafeError(error, "Could not save mailbox settings");
      return data;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("email_accounts").delete().eq("id", id);
      if (error) throw error;
    },
    counts: async () => {
      const [total, connected, errors] = await Promise.all([
        supabase.from("email_accounts").select("id", { count: "exact", head: true }),
        supabase.from("email_accounts").select("id", { count: "exact", head: true }).not("connected_at", "is", null),
        supabase.from("email_accounts").select("id", { count: "exact", head: true }).eq("sync_status", "error"),
      ]);
      return { total: total.count ?? 0, connected: connected.count ?? 0, errors: errors.count ?? 0 };
    },
  },

  // ---------- Finance ----------
  banks: {
    list: async () => (await supabase.from("banks").select("*").order("name")).data ?? [],
    create: async (name: string, notes?: string) => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Bank name is required");
      const { data: existing } = await supabase.from("banks").select("id, name");
      if ((existing ?? []).some((b: any) => b.name?.trim().toLowerCase() === trimmed.toLowerCase())) {
        throw new Error(`A bank named "${trimmed}" already exists — select it from the Bank dropdown instead.`);
      }
      const { data, error } = await supabase.from("banks").insert({ name: trimmed, notes }).select().single();
      if (error) throw error;
      return data;
    },
  },
  accounts: {
    list: async () => (await supabase.from("financial_accounts").select("*, banks(name)").order("nickname")).data ?? [],
    create: async (a: { nickname: string; account_type?: string; masked_number?: string; bank_id?: string | null; statement_cycle_day?: number | null; source_email?: string | null }) => {
      const nickname = a.nickname.trim();
      const { data: existing } = await supabase.from("financial_accounts").select("id, nickname");
      if ((existing ?? []).some((x: any) => x.nickname?.trim().toLowerCase() === nickname.toLowerCase())) {
        throw new Error(`An account named "${nickname}" already exists`);
      }
      const { data, error } = await supabase.from("financial_accounts").insert({ ...a, nickname }).select().single();
      if (error) throw error;
      return data;
    },
    update: async (id: string, patch: Partial<FinancialAccount>) => {
      const { error } = await supabase.from("financial_accounts").update(patch).eq("id", id);
      if (error) throw error;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("financial_accounts").delete().eq("id", id);
      if (error) throw error;
    },
    // Plaintext goes straight to the edge function, which encrypts it
    // server-side (AES-256-GCM) before writing statement_password_rule.
    // Never written directly from the browser, never read back.
    setStatementPassword: async (id: string, password: string) => {
      await callEdgeFunction("finance-set-statement-password", { target_type: "account", target_id: id, password });
    },
    // Cross-entity view for AccountDetail. Note: credit_cards has no
    // linked_account_id in the current schema (cards relate to accounts only
    // indirectly, via logged payments) — only loans and subscriptions have a
    // real FK to check.
    linked: async (accountId: string) => {
      const [loans, subs] = await Promise.all([
        supabase.from("loans").select("*").eq("linked_account_id", accountId),
        supabase.from("subscriptions").select("*").eq("linked_account_id", accountId),
      ]);
      return { loans: loans.data ?? [], subs: subs.data ?? [] };
    },
  },
  cards: {
    list: async () => (await supabase.from("credit_cards").select("*, banks(name)").order("card_name")).data ?? [],
    create: async (c: { card_name: string; bank_id?: string | null; masked_number?: string; billing_day?: number | null; due_day?: number | null; limit_amount?: number | null; autopay?: boolean; notes?: string | null }) => {
      const cardName = c.card_name.trim();
      const maskedNumber = c.masked_number?.trim() || null;
      const { data: existing } = await supabase.from("credit_cards").select("id, card_name, masked_number");
      const dupe = (existing ?? []).find((x: any) => {
        const sameName = x.card_name?.trim().toLowerCase() === cardName.toLowerCase();
        const sameNumber = maskedNumber && x.masked_number && x.masked_number.trim() === maskedNumber;
        return sameName || sameNumber;
      });
      if (dupe) {
        throw new Error(
          dupe.masked_number && maskedNumber && dupe.masked_number.trim() === maskedNumber
            ? `A card ending in ${maskedNumber} already exists`
            : `A card named "${cardName}" already exists`,
        );
      }
      const { data, error } = await supabase.from("credit_cards").insert({ ...c, card_name: cardName, masked_number: maskedNumber ?? undefined }).select().single();
      if (error) throw error;
      return data;
    },
    update: async (id: string, patch: Partial<CreditCard>) => {
      const { error } = await supabase.from("credit_cards").update(patch).eq("id", id);
      if (error) throw error;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("credit_cards").delete().eq("id", id);
      if (error) throw error;
    },
    upcomingDues: async () => {
      const { data } = await supabase.from("credit_cards").select("*, banks(name)").order("due_day");
      return data ?? [];
    },
    setStatementPassword: async (id: string, password: string) => {
      await callEdgeFunction("finance-set-statement-password", { target_type: "card", target_id: id, password });
    },
  },
  loans: {
    list: async () => (await supabase.from("loans").select("*, financial_accounts(nickname)").order("next_due_date")).data ?? [],
    create: async (l: { lender_name: string; loan_type?: string; principal_amount?: number; interest_rate?: number; emi_amount?: number; tenure_months?: number; start_date?: string; outstanding_amount?: number; next_due_date?: string; linked_account_id?: string | null }) => {
      const { data, error } = await supabase.from("loans").insert(l).select().single();
      if (error) throw error;
      return data;
    },
    update: async (id: string, patch: Partial<Loan>) => {
      const { error } = await supabase.from("loans").update(patch).eq("id", id);
      if (error) throw error;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("loans").delete().eq("id", id);
      if (error) throw error;
    },
    payments: async (loanId: string) => {
      const { data, error } = await supabase.from("transactions")
        .select("*").eq("loan_id", loanId).order("txn_date", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  },
  goals: {
    list: async () => (await supabase.from("financial_goals").select("*, financial_accounts(nickname)").order("target_date")).data ?? [],
    create: async (g: { title: string; goal_type?: string; target_amount?: number; target_date?: string; current_amount?: number; linked_account_id?: string | null }) => {
      const { data, error } = await supabase.from("financial_goals").insert(g).select().single();
      if (error) throw error;
      return data;
    },
    update: async (id: string, patch: Partial<FinancialGoal>) => {
      const { error } = await supabase.from("financial_goals").update(patch).eq("id", id);
      if (error) throw error;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("financial_goals").delete().eq("id", id);
      if (error) throw error;
    },
    contributions: {
      list: async (goalId: string) => {
        const { data, error } = await supabase.from("goal_contributions")
          .select("*").eq("goal_id", goalId).order("contributed_at", { ascending: false });
        if (error) throw error;
        return data ?? [];
      },
      // Single insert — the goal_contribution_bump trigger (migration
      // 20260712140200) atomically adds `amount` onto financial_goals
      // .current_amount in the same transaction, so this never needs a
      // separate current_amount update from the client.
      create: async (goalId: string, amount: number, note?: string, contributed_at?: string) => {
        const { data, error } = await supabase.from("goal_contributions")
          .insert({ goal_id: goalId, amount, note: note || null, ...(contributed_at ? { contributed_at } : {}) })
          .select().single();
        if (error) throw error;
        return data;
      },
    },
    milestones: {
      list: async (goalId: string) => {
        const { data, error } = await supabase.from("goal_milestones")
          .select("*").eq("goal_id", goalId).order("target_amount");
        if (error) throw error;
        return data ?? [];
      },
      create: async (goalId: string, title: string, target_amount: number) => {
        const { data, error } = await supabase.from("goal_milestones")
          .insert({ goal_id: goalId, title, target_amount }).select().single();
        if (error) throw error;
        return data;
      },
      remove: async (id: string) => {
        const { error } = await supabase.from("goal_milestones").delete().eq("id", id);
        if (error) throw error;
      },
    },
  },
  // ---------- Investments ----------
  investmentAccounts: {
    list: async () => (await supabase.from("investment_accounts").select("*").order("account_name")).data ?? [],
    create: async (a: { provider?: string; account_name: string; account_number_masked?: string; notes?: string }) => {
      const { data, error } = await supabase.from("investment_accounts").insert(a).select().single();
      if (error) throw error;
      return data;
    },
    update: async (id: string, patch: Partial<InvestmentAccount>) => {
      const { error } = await supabase.from("investment_accounts").update(patch).eq("id", id);
      if (error) throw error;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("investment_accounts").delete().eq("id", id);
      if (error) throw error;
    },
  },
  investmentHoldings: {
    list: async (opts: { assetTypes?: string[]; watchlistOnly?: boolean } = {}) => {
      let q = supabase.from("investment_holdings").select("*, investment_accounts(account_name)").order("name");
      if (opts.assetTypes?.length) q = q.in("asset_type", opts.assetTypes);
      if (opts.watchlistOnly) q = q.eq("is_watchlist", true);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
    get: async (id: string) => {
      const { data, error } = await supabase.from("investment_holdings").select("*, investment_accounts(account_name)").eq("id", id).single();
      if (error) throw error;
      return data;
    },
    create: async (h: Partial<InvestmentHolding> & { asset_type: string; name: string }) => {
      const { data, error } = await supabase.from("investment_holdings").insert(h).select().single();
      if (error) throw error;
      return data;
    },
    update: async (id: string, patch: Partial<InvestmentHolding>) => {
      const { error } = await supabase.from("investment_holdings").update(patch).eq("id", id);
      if (error) throw error;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("investment_holdings").delete().eq("id", id);
      if (error) throw error;
    },
    // Current value summed by asset_type — feeds Overview's net worth and
    // Investments' allocation view from one query.
    summary: async () => {
      const { data, error } = await supabase.from("investment_holdings").select("asset_type, current_value, invested_amount");
      if (error) throw error;
      const rows = data ?? [];
      const totalValue = rows.reduce((sum: number, r: any) => sum + (Number(r.current_value) || 0), 0);
      const totalInvested = rows.reduce((sum: number, r: any) => sum + (Number(r.invested_amount) || 0), 0);
      return { totalValue, totalInvested, count: rows.length };
    },
  },
  investmentTransactions: {
    list: async (holdingId: string) => {
      const { data, error } = await supabase.from("investment_transactions")
        .select("*").eq("holding_id", holdingId).order("txn_date", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    create: async (t: { holding_id: string; txn_type: string; txn_date: string; units?: number | null; price?: number | null; amount: number; source?: string }) => {
      const { data, error } = await supabase.from("investment_transactions").insert(t).select().single();
      if (error) throw error;
      return data;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("investment_transactions").delete().eq("id", id);
      if (error) throw error;
    },
  },
  financeSettings: {
    get: async () => {
      const { data, error } = await supabase.from("user_finance_settings").select("*").maybeSingle();
      if (error) throw error;
      return data ?? { enabled_asset_types: ["mutual_fund", "stock"] };
    },
    // Upsert-by-user pattern: one settings row per user, created on first save.
    setEnabledAssetTypes: async (types: string[]) => {
      const { data: existing } = await supabase.from("user_finance_settings").select("id").maybeSingle();
      if (existing) {
        const { error } = await supabase.from("user_finance_settings").update({ enabled_asset_types: types, updated_at: new Date().toISOString() }).eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("user_finance_settings").insert({ enabled_asset_types: types });
        if (error) throw error;
      }
    },
  },
  navSync: {
    // Fetches AMFI's public NAV feed server-side, upserts investment_nav_cache,
    // re-prices matching holdings by symbol_or_scheme_code.
    sync: async () => callEdgeFunction("finance-sync-nav", {}),
  },
  growwImport: {
    // PDF (Groww's Profile -> Reports transaction statement) or CSV, parsed
    // server-side and returned as staged rows for the user to confirm before
    // insert (mirrors finance-upload-statement's parse-then-confirm flow).
    parse: async (params: { filename: string; bytesBase64?: string; csvText?: string; investment_account_id?: string | null }) => {
      return callEdgeFunction("finance-import-groww", params);
    },
  },

  // ---------- Budget ----------
  budgets: {
    list: async () => (await supabase.from("budgets").select("*").order("category")).data ?? [],
    create: async (b: { category: string; monthly_limit: number; rollover?: boolean; notes?: string }) => {
      const { data, error } = await supabase.from("budgets").insert(b).select().single();
      if (error) throw error;
      return data;
    },
    update: async (id: string, patch: Partial<Budget>) => {
      const { error } = await supabase.from("budgets").update(patch).eq("id", id);
      if (error) throw error;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("budgets").delete().eq("id", id);
      if (error) throw error;
    },
    // Actual debit spend this month for one category — compared against
    // budgets.monthly_limit client-side, never stored (see migration comment).
    spentThisMonth: async (category: string) => {
      const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
      const { data } = await supabase.from("transactions")
        .select("amount").eq("txn_type", "debit").eq("category", category)
        .gte("txn_date", start.toISOString().slice(0, 10));
      return (data ?? []).reduce((sum: number, r: any) => sum + (Number(r.amount) || 0), 0);
    },
  },

  // ---------- Insurance ----------
  insurancePolicies: {
    list: async () => (await supabase.from("insurance_policies").select("*, financial_accounts(nickname)").order("renewal_date")).data ?? [],
    create: async (p: Partial<InsurancePolicy> & { policy_type: string }) => {
      const { data, error } = await supabase.from("insurance_policies").insert(p).select().single();
      if (error) throw error;
      return data;
    },
    update: async (id: string, patch: Partial<InsurancePolicy>) => {
      const { error } = await supabase.from("insurance_policies").update(patch).eq("id", id);
      if (error) throw error;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("insurance_policies").delete().eq("id", id);
      if (error) throw error;
    },
  },

  subscriptions: {
    list: async () => (await supabase.from("subscriptions").select("*, financial_accounts(nickname), credit_cards(card_name)").order("next_due_date")).data ?? [],
    create: async (s: { name: string; category?: string; amount?: number; billing_cycle?: string; next_due_date?: string; linked_account_id?: string | null; linked_card_id?: string | null }) => {
      const { data, error } = await supabase.from("subscriptions").insert(s).select().single();
      if (error) throw error;
      return data;
    },
    update: async (id: string, patch: Partial<Subscription>) => {
      const { error } = await supabase.from("subscriptions").update(patch).eq("id", id);
      if (error) throw error;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("subscriptions").delete().eq("id", id);
      if (error) throw error;
    },
  },
  transactions: {
    list: async (limit = 100) => {
      const { data, error } = await supabase.from("transactions")
        .select("*, financial_accounts(nickname), credit_cards(card_name)")
        .order("txn_date", { ascending: false }).limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    create: async (t: { txn_date: string; amount: number; txn_type: Transaction["txn_type"]; merchant?: string; description?: string; category?: string; financial_account_id?: string | null; credit_card_id?: string | null; loan_id?: string | null; source?: Transaction["source"]; payment_mode?: string | null; reference_number?: string | null; is_prepayment?: boolean }) => {
      const { data, error } = await supabase.from("transactions").insert(t).select().single();
      if (error) throw error;
      return data;
    },
    update: async (id: string, patch: Partial<Transaction>) => {
      const { error } = await supabase.from("transactions").update(patch).eq("id", id);
      if (error) throw error;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("transactions").delete().eq("id", id);
      if (error) throw error;
    },
    findPossibleDuplicate: async (params: { financial_account_id?: string | null; credit_card_id?: string | null; txn_date: string; amount: number }) => {
      let q = supabase.from("transactions").select("id, merchant, source").eq("txn_date", params.txn_date).eq("amount", params.amount);
      if (params.credit_card_id) q = q.eq("credit_card_id", params.credit_card_id);
      else if (params.financial_account_id) q = q.eq("financial_account_id", params.financial_account_id);
      else return null;
      const { data } = await q.maybeSingle();
      return data ?? null;
    },
    monthSummary: async () => {
      const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
      const { data } = await supabase.from("transactions")
        .select("amount, txn_type")
        .gte("txn_date", start.toISOString().slice(0, 10));
      let spend = 0, income = 0;
      for (const r of data ?? []) {
        const amt = Number(r.amount) || 0;
        if (r.txn_type === "debit") spend += amt; else income += amt;
      }
      return { spend, income };
    },
    // Rolling monthly spend/income for the last N months (inclusive of current
    // month, oldest-first). Feeds the Overview cash-flow trend and health-score
    // stability signal so both use the same numbers.
    trend: async (months = 6) => {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
      const { data } = await supabase.from("transactions")
        .select("amount, txn_type, txn_date")
        .gte("txn_date", start.toISOString().slice(0, 10));
      const buckets = new Map<string, { spend: number; income: number }>();
      for (let i = 0; i < months; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1);
        buckets.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, { spend: 0, income: 0 });
      }
      for (const r of data ?? []) {
        const dt = new Date(r.txn_date as string);
        if (Number.isNaN(dt.getTime())) continue;
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
        const b = buckets.get(key); if (!b) continue;
        const amt = Number(r.amount) || 0;
        if (r.txn_type === "debit") b.spend += amt; else b.income += amt;
      }
      return [...buckets.entries()].map(([month, v]) => ({ month, ...v, net: v.income - v.spend }));
    },
    categorySummary: async (limit = 6) => {
      const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
      const { data } = await supabase.from("transactions")
        .select("category, amount, txn_type")
        .eq("txn_type", "debit")
        .gte("txn_date", start.toISOString().slice(0, 10));
      const byCategory = new Map<string, number>();
      for (const r of data ?? []) {
        const cat = r.category?.trim() || "uncategorized";
        byCategory.set(cat, (byCategory.get(cat) ?? 0) + (Number(r.amount) || 0));
      }
      return [...byCategory.entries()]
        .map(([category, amount]) => ({ category, amount }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, limit);
    },
    // Spend/income + top merchants/categories for a fixed window — feeds the
    // Overview "AI financial summary" (day/week/month) prompt.
    periodSummary: async (period: "day" | "week" | "month") => {
      const start = new Date();
      if (period === "day") {
        start.setHours(0, 0, 0, 0);
      } else if (period === "week") {
        start.setDate(start.getDate() - 7); start.setHours(0, 0, 0, 0);
      } else {
        start.setDate(1); start.setHours(0, 0, 0, 0);
      }
      const { data } = await supabase.from("transactions")
        .select("amount, txn_type, merchant, category")
        .gte("txn_date", start.toISOString().slice(0, 10));
      let spend = 0, income = 0;
      const byMerchant = new Map<string, number>();
      const byCategory = new Map<string, number>();
      for (const r of data ?? []) {
        const amt = Number(r.amount) || 0;
        if (r.txn_type === "debit") {
          spend += amt;
          const m = r.merchant?.trim() || "unknown";
          byMerchant.set(m, (byMerchant.get(m) ?? 0) + amt);
          const c = r.category?.trim() || "uncategorized";
          byCategory.set(c, (byCategory.get(c) ?? 0) + amt);
        } else {
          income += amt;
        }
      }
      const topMerchants = [...byMerchant.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([merchant, amount]) => ({ merchant, amount }));
      const topCategories = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([category, amount]) => ({ category, amount }));
      return { period, spend, income, topMerchants, topCategories };
    },
    // Debit transactions on a linked account/card within +-windowDays of
    // centerDate — reconciliation.ts's only read against this table.
    findInWindow: async (params: { financial_account_id?: string | null; credit_card_id?: string | null; centerDate: string; windowDays: number }) => {
      if (!params.financial_account_id && !params.credit_card_id) return [];
      const center = new Date(params.centerDate);
      const from = new Date(center); from.setDate(from.getDate() - params.windowDays);
      const to = new Date(center); to.setDate(to.getDate() + params.windowDays);
      let q = supabase.from("transactions").select("*").eq("txn_type", "debit")
        .gte("txn_date", from.toISOString().slice(0, 10))
        .lte("txn_date", to.toISOString().slice(0, 10));
      q = params.credit_card_id ? q.eq("credit_card_id", params.credit_card_id) : q.eq("financial_account_id", params.financial_account_id);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  },

  statements: {
    list: async (limit = 200) => {
      const { data, error } = await supabase.from("statements")
        .select("*, credit_cards!statements_credit_card_id_fkey(card_name, banks(name)), financial_accounts(nickname, banks(name)), loans(lender_name), banks:linked_bank_id(name), emails:source_email_id(from_name, from_email, subject, received_at)")
        .order("statement_date", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    get: async (id: string) => {
      const { data, error } = await supabase.from("statements")
        .select("*, credit_cards!statements_credit_card_id_fkey(card_name, banks(name)), financial_accounts(nickname, banks(name)), loans(lender_name), banks:linked_bank_id(name), emails:source_email_id(from_name, from_email, subject, received_at)")
        .eq("id", id).single();
      if (error) throw error;
      return data;
    },
    latestByCard: async () => {
      const { data, error } = await supabase.from("statements")
        .select("*").eq("statement_type", "card").not("credit_card_id", "is", null)
        .order("statement_date", { ascending: false, nullsFirst: false });
      if (error) throw error;
      const latest = new Map<string, any>();
      for (const s of data ?? []) {
        if (!latest.has(s.credit_card_id)) latest.set(s.credit_card_id, s);
      }
      return latest;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("statements").delete().eq("id", id);
      if (error) throw error;
    },
    transactions: async (statementId: string) => {
      const { data, error } = await supabase.from("transactions")
        .select("*").eq("source_statement_id", statementId).order("txn_date");
      if (error) throw error;
      return data ?? [];
    },
    // Manual upload. Optional `existing_statement_id` attaches the PDF to an
    // existing row (used for "skipped" statements that had no attachment).
    upload: async (params: {
      statement_type: "account" | "card" | "loan";
      credit_card_id?: string | null; financial_account_id?: string | null; loan_id?: string | null;
      filename: string; contentType?: string; bytesBase64: string; password?: string;
      existing_statement_id?: string | null;
    }) => {
      return callEdgeFunction("finance-upload-statement", { ...params, contentType: "application/pdf" });
    },
    // Server-side ownership check + short-lived signed URL — the private
    // statement-pdfs bucket has no public/anon read.
    signedPdfUrl: async (statementId: string) => {
      const j = await callEdgeFunction("finance-statement-pdf-url", { statement_id: statementId });
      return {
        url: j.url as string,
        password: typeof j.viewer_password === "string" ? j.viewer_password : null,
        passwordProtected: Boolean(j.password_protected),
      };
    },
    listPasswords: async (): Promise<Array<{ type: "card" | "account"; id: string; label: string; bank: string | null; mask: string | null; password: string | null }>> => {
      const j = await callEdgeFunction("finance-list-statement-passwords", {});
      return (j?.items ?? []) as any;
    },
    upcomingDues: async (limit = 6) => {
      const todayIso = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase.from("statements")
        .select("*, credit_cards!statements_credit_card_id_fkey(card_name), financial_accounts(nickname)")
        .eq("parse_status", "parsed")
        .not("due_date", "is", null)
        .gte("due_date", todayIso)
        .order("due_date", { ascending: true })
        .limit(50);
      if (error) throw error;
      // Soonest-due parsed statement per card/account.
      const seen = new Set<string>();
      const latest: any[] = [];
      for (const s of data ?? []) {
        const key = s.credit_card_id ?? s.financial_account_id;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        latest.push(s);
      }
      return latest.slice(0, limit);
    },
    retry: async (id: string, links?: { credit_card_id?: string | null; financial_account_id?: string | null }, password?: string) => {
      return callEdgeFunction("finance-retry-statement", { statement_id: id, ...links, password });
    },
    reparseAll: async (opts?: { limit?: number; since_days?: number; include_incomplete_parsed?: boolean }) =>
      callEdgeFunction("finance-reparse-statements", {
        limit: opts?.limit ?? 3,
        since_days: opts?.since_days ?? 3650,
        include_incomplete_parsed: opts?.include_incomplete_parsed ?? true,
      }),

    summarize: async (id: string) => {
      return callEdgeFunction("finance-summarize-statement", { statement_id: id });
    },
    // Card-statement payment lifecycle actions. Server-side would be nicer,
    // but a direct update stays within the user's RLS scope.
    markPaid: async (id: string, amount: number | null) => {
      const today = new Date().toISOString().slice(0, 10);
      const { error } = await supabase.from("statements").update({
        payment_status: "paid",
        paid_amount: amount ?? undefined,
        paid_on: today,
      }).eq("id", id);
      if (error) throw error;
    },
    markPartial: async (id: string, amount: number) => {
      const today = new Date().toISOString().slice(0, 10);
      const { error } = await supabase.from("statements").update({
        payment_status: "partial",
        paid_amount: amount,
        paid_on: today,
      }).eq("id", id);
      if (error) throw error;
    },
    clearPayment: async (id: string) => {
      const { error } = await supabase.from("statements").update({
        payment_status: "pending",
        paid_amount: null,
        paid_on: null,
      }).eq("id", id);
      if (error) throw error;
    },
  },

  // ---------- Finance sync ----------
  finance: {
    extract: async (opts: { since_days?: number; limit?: number; account_id?: string } = {}) => {
      return callEdgeFunction("finance-extract", opts);
    },
    syncMarket: async () => callEdgeFunction("finance-market-sync", {}),
    morningBrief: async (force = false) =>
      callEdgeFunction("finance-morning-brief" + (force ? "?force=1" : ""), {}),
    detect: async () => callEdgeFunction("finance-detect", {}),
    reconcile: async () => callEdgeFunction("finance-reconcile", {}),
    insight: async (topic: string, context: Record<string, unknown>, question?: string) =>
      callEdgeFunction("jarvis-finance-insight", { topic, context, question }),
    quotes: async () => {
      const { data, error } = await supabase.from("market_quotes")
        .select("*").order("kind").order("symbol");
      if (error) throw error;
      return (data ?? []) as AnyRow[];
    },
  },

  // ---------- Finance reconciliation alerts ----------
  alerts: {
    list: async (opts: { status?: "open" | "dismissed" | "resolved" } = {}) => {
      let q = supabase.from("finance_alerts").select("*").order("expected_date", { ascending: false });
      if (opts.status) q = q.eq("status", opts.status);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
    create: async (patch: Record<string, any>) => {
      const { data, error } = await supabase.from("finance_alerts").insert(patch).select().single();
      if (error) throw error;
      return data;
    },
    update: async (id: string, patch: Record<string, any>) => {
      const { error } = await supabase.from("finance_alerts").update(patch).eq("id", id);
      if (error) throw error;
    },
    dismiss: async (id: string) => {
      const { error } = await supabase.from("finance_alerts").update({ status: "dismissed" }).eq("id", id);
      if (error) throw error;
    },
    resolve: async (id: string) => {
      const { error } = await supabase.from("finance_alerts").update({ status: "resolved" }).eq("id", id);
      if (error) throw error;
    },
  },

  // ---------- Actions log ----------
  actions: {
    recent: async (limit = 8) => {
      const { data, error } = await supabase.from("jarvis_actions")
        .select("*").order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    log: async (action_type: string, command_text?: string, target_module?: string, status: JarvisAction["status"] = "success", output?: unknown) => {
      const { error } = await supabase.from("jarvis_actions").insert({
        action_type, command_text, target_module, status,
        output: (output as any) ?? null,
      });
      if (error) throw error;
    },
  },

  // ---------- Reminders ----------
  reminders: {
    list: async () => (await supabase.from("jarvis_reminders").select("*").order("fire_at")).data ?? [],
    create: async (text: string, fire_at: string, linked_task_id?: string | null) => {
      const { data, error } = await supabase.from("jarvis_reminders")
        .insert({ text, fire_at, linked_task_id: linked_task_id ?? null }).select().single();
      if (error) throw error;
      return data;
    },
  },
};

// Small helpers used by the HUD widgets.
export function inr(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return "₹ " + v.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
