import {
  supabase,
  callEdgeFunction,
  type FinancialAccount,
  type CreditCard,
  type Loan,
  type FinancialGoal,
  type Subscription,
  type Budget,
  type InsurancePolicy,
  type AnyRow,
} from "./client";

export const banks = {
  list: async () => (await supabase.from("banks").select("*").order("name")).data ?? [],
  create: async (name: string, notes?: string) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Bank name is required");
    const { data: existing } = await supabase.from("banks").select("id, name");
    if ((existing ?? []).some((b: AnyRow) => b.name?.trim().toLowerCase() === trimmed.toLowerCase())) {
      throw new Error(
        `A bank named "${trimmed}" already exists — select it from the Bank dropdown instead.`,
      );
    }
    const { data, error } = await supabase.from("banks").insert({ name: trimmed, notes }).select().single();
    if (error) throw error;
    return data;
  },
};

export const accounts = {
  list: async () =>
    (await supabase.from("financial_accounts").select("*, banks(name)").order("nickname")).data ?? [],
  create: async (a: {
    nickname: string;
    account_type?: string;
    masked_number?: string;
    bank_id?: string | null;
    statement_cycle_day?: number | null;
    source_email?: string | null;
  }) => {
    const nickname = a.nickname.trim();
    const { data: existing } = await supabase.from("financial_accounts").select("id, nickname");
    if ((existing ?? []).some((x: AnyRow) => x.nickname?.trim().toLowerCase() === nickname.toLowerCase())) {
      throw new Error(`An account named "${nickname}" already exists`);
    }
    const { data, error } = await supabase
      .from("financial_accounts")
      .insert({ ...a, nickname })
      .select()
      .single();
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
  setStatementPassword: async (id: string, password: string) => {
    await callEdgeFunction("finance-set-statement-password", {
      target_type: "account",
      target_id: id,
      password,
    });
  },
  linked: async (accountId: string) => {
    const [loans, subs] = await Promise.all([
      supabase.from("loans").select("*").eq("linked_account_id", accountId),
      supabase.from("subscriptions").select("*").eq("linked_account_id", accountId),
    ]);
    return { loans: loans.data ?? [], subs: subs.data ?? [] };
  },
};

export const cards = {
  list: async () =>
    (await supabase.from("credit_cards").select("*, banks(name)").order("card_name")).data ?? [],
  create: async (c: {
    card_name: string;
    bank_id?: string | null;
    masked_number?: string;
    billing_day?: number | null;
    due_day?: number | null;
    limit_amount?: number | null;
    autopay?: boolean;
    notes?: string | null;
  }) => {
    const cardName = c.card_name.trim();
    const maskedNumber = c.masked_number?.trim() || null;
    const { data: existing } = await supabase
      .from("credit_cards")
      .select("id, card_name, masked_number");
    const dupe = (existing ?? []).find((x: AnyRow) => {
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
    const { data, error } = await supabase
      .from("credit_cards")
      .insert({ ...c, card_name: cardName, masked_number: maskedNumber ?? undefined })
      .select()
      .single();
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
    await callEdgeFunction("finance-set-statement-password", {
      target_type: "card",
      target_id: id,
      password,
    });
  },
};

export const loans = {
  list: async () =>
    (await supabase.from("loans").select("*, financial_accounts(nickname)").order("next_due_date")).data ??
    [],
  create: async (l: {
    lender_name: string;
    loan_type?: string;
    principal_amount?: number;
    interest_rate?: number;
    emi_amount?: number;
    tenure_months?: number;
    start_date?: string;
    outstanding_amount?: number;
    next_due_date?: string;
    linked_account_id?: string | null;
  }) => {
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
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("loan_id", loanId)
      .order("txn_date", { ascending: false });
    if (error) throw error;
    return data ?? [];
  },
};

export const goals = {
  list: async () =>
    (await supabase.from("financial_goals").select("*, financial_accounts(nickname)").order("target_date"))
      .data ?? [],
  create: async (g: {
    title: string;
    goal_type?: string;
    target_amount?: number;
    target_date?: string;
    current_amount?: number;
    linked_account_id?: string | null;
  }) => {
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
      const { data, error } = await supabase
        .from("goal_contributions")
        .select("*")
        .eq("goal_id", goalId)
        .order("contributed_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    create: async (goalId: string, amount: number, note?: string, contributed_at?: string) => {
      const { data, error } = await supabase
        .from("goal_contributions")
        .insert({
          goal_id: goalId,
          amount,
          note: note || null,
          ...(contributed_at ? { contributed_at } : {}),
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
  },
  milestones: {
    list: async (goalId: string) => {
      const { data, error } = await supabase
        .from("goal_milestones")
        .select("*")
        .eq("goal_id", goalId)
        .order("target_amount");
      if (error) throw error;
      return data ?? [];
    },
    create: async (goalId: string, title: string, target_amount: number) => {
      const { data, error } = await supabase
        .from("goal_milestones")
        .insert({ goal_id: goalId, title, target_amount })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    remove: async (id: string) => {
      const { error } = await supabase.from("goal_milestones").delete().eq("id", id);
      if (error) throw error;
    },
  },
};

export const budgets = {
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
  spentThisMonth: async (category: string) => {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const { data } = await supabase
      .from("transactions")
      .select("amount")
      .eq("txn_type", "debit")
      .eq("category", category)
      .gte("txn_date", start.toISOString().slice(0, 10));
    return (data ?? []).reduce((sum: number, r: AnyRow) => sum + (Number(r.amount) || 0), 0);
  },
};

export const insurancePolicies = {
  list: async () =>
    (await supabase.from("insurance_policies").select("*, financial_accounts(nickname)").order("renewal_date"))
      .data ?? [],
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
};

export const subscriptions = {
  list: async () =>
    (
      await supabase
        .from("subscriptions")
        .select("*, financial_accounts(nickname), credit_cards(card_name)")
        .order("next_due_date")
    ).data ?? [],
  create: async (s: {
    name: string;
    category?: string;
    amount?: number;
    billing_cycle?: string;
    next_due_date?: string;
    linked_account_id?: string | null;
    linked_card_id?: string | null;
  }) => {
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
};
