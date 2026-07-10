import { supabase as _supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

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
export type JarvisAction = AnyRow;
export type JarvisReminder = AnyRow;


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
    list: async (limit = 20) => {
      const { data, error } = await supabase
        .from("decisions").select("*")
        .order("decided_on", { ascending: false }).limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    create: async (d: { title: string; decision_text: string; context?: string; rationale?: string; linked_project_id?: string | null }) => {
      const { data, error } = await supabase.from("decisions").insert(d).select().single();
      if (error) throw error;
      return data;
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
      if (error) throw error;
      return data;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("email_accounts").delete().eq("id", id);
      if (error) throw error;
    },
  },

  // ---------- Finance ----------
  banks: {
    list: async () => (await supabase.from("banks").select("*").order("name")).data ?? [],
    create: async (name: string, notes?: string) => {
      const { data, error } = await supabase.from("banks").insert({ name, notes }).select().single();
      if (error) throw error;
      return data;
    },
  },
  accounts: {
    list: async () => (await supabase.from("financial_accounts").select("*, banks(name)").order("nickname")).data ?? [],
    create: async (a: { nickname: string; account_type?: string; masked_number?: string; bank_id?: string | null; statement_cycle_day?: number | null; source_email?: string | null }) => {
      const { data, error } = await supabase.from("financial_accounts").insert(a).select().single();
      if (error) throw error;
      return data;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("financial_accounts").delete().eq("id", id);
      if (error) throw error;
    },
  },
  cards: {
    list: async () => (await supabase.from("credit_cards").select("*, banks(name)").order("card_name")).data ?? [],
    create: async (c: { card_name: string; bank_id?: string | null; masked_number?: string; billing_day?: number | null; due_day?: number | null; limit_amount?: number | null }) => {
      const { data, error } = await supabase.from("credit_cards").insert(c).select().single();
      if (error) throw error;
      return data;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("credit_cards").delete().eq("id", id);
      if (error) throw error;
    },
    upcomingDues: async () => {
      const { data } = await supabase.from("credit_cards").select("*, banks(name)").order("due_day");
      return data ?? [];
    },
  },
  loans: {
    list: async () => (await supabase.from("loans").select("*").order("next_due_date")).data ?? [],
    create: async (l: { lender_name: string; loan_type?: string; principal_amount?: number; interest_rate?: number; emi_amount?: number; tenure_months?: number; start_date?: string; outstanding_amount?: number; next_due_date?: string }) => {
      const { data, error } = await supabase.from("loans").insert(l).select().single();
      if (error) throw error;
      return data;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("loans").delete().eq("id", id);
      if (error) throw error;
    },
  },
  goals: {
    list: async () => (await supabase.from("financial_goals").select("*").order("target_date")).data ?? [],
    create: async (g: { title: string; goal_type?: string; target_amount?: number; target_date?: string; current_amount?: number }) => {
      const { data, error } = await supabase.from("financial_goals").insert(g).select().single();
      if (error) throw error;
      return data;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("financial_goals").delete().eq("id", id);
      if (error) throw error;
    },
  },
  subscriptions: {
    list: async () => (await supabase.from("subscriptions").select("*").order("next_due_date")).data ?? [],
    create: async (s: { name: string; category?: string; amount?: number; billing_cycle?: string; next_due_date?: string }) => {
      const { data, error } = await supabase.from("subscriptions").insert(s).select().single();
      if (error) throw error;
      return data;
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
    create: async (t: { txn_date: string; amount: number; txn_type: Transaction["txn_type"]; merchant?: string; description?: string; category?: string; financial_account_id?: string | null; credit_card_id?: string | null; loan_id?: string | null; source?: Transaction["source"] }) => {
      const { data, error } = await supabase.from("transactions").insert(t).select().single();
      if (error) throw error;
      return data;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("transactions").delete().eq("id", id);
      if (error) throw error;
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
