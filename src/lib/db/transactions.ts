import { supabase, type Transaction, type AnyRow } from "./client";

export const transactions = {
  list: async (limit = 100) => {
    const { data, error } = await supabase
      .from("transactions")
      .select("*, financial_accounts(nickname), credit_cards(card_name)")
      .order("txn_date", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  },
  create: async (t: {
    txn_date: string;
    amount: number;
    txn_type: Transaction["txn_type"];
    merchant?: string;
    description?: string;
    category?: string;
    financial_account_id?: string | null;
    credit_card_id?: string | null;
    loan_id?: string | null;
    source?: Transaction["source"];
    payment_mode?: string | null;
    reference_number?: string | null;
    is_prepayment?: boolean;
  }) => {
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
  findPossibleDuplicate: async (params: {
    financial_account_id?: string | null;
    credit_card_id?: string | null;
    txn_date: string;
    amount: number;
  }) => {
    let q = supabase
      .from("transactions")
      .select("id, merchant, source")
      .eq("txn_date", params.txn_date)
      .eq("amount", params.amount);
    if (params.credit_card_id) q = q.eq("credit_card_id", params.credit_card_id);
    else if (params.financial_account_id) q = q.eq("financial_account_id", params.financial_account_id);
    else return null;
    const { data } = await q.maybeSingle();
    return data ?? null;
  },
  monthSummary: async () => {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const { data } = await supabase
      .from("transactions")
      .select("amount, txn_type")
      .gte("txn_date", start.toISOString().slice(0, 10));
    let spend = 0;
    let income = 0;
    for (const r of data ?? []) {
      const amt = Number(r.amount) || 0;
      if (r.txn_type === "debit") spend += amt;
      else income += amt;
    }
    return { spend, income };
  },
  trend: async (months = 6) => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
    const { data } = await supabase
      .from("transactions")
      .select("amount, txn_type, txn_date")
      .gte("txn_date", start.toISOString().slice(0, 10));
    const buckets = new Map<string, { spend: number; income: number }>();
    for (let i = 0; i < months; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1);
      buckets.set(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        { spend: 0, income: 0 },
      );
    }
    for (const r of data ?? []) {
      const dt = new Date(r.txn_date as string);
      if (Number.isNaN(dt.getTime())) continue;
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
      const b = buckets.get(key);
      if (!b) continue;
      const amt = Number(r.amount) || 0;
      if (r.txn_type === "debit") b.spend += amt;
      else b.income += amt;
    }
    return [...buckets.entries()].map(([month, v]) => ({ month, ...v, net: v.income - v.spend }));
  },
  categorySummary: async (limit = 6) => {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const { data } = await supabase
      .from("transactions")
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
  periodSummary: async (period: "day" | "week" | "month") => {
    const start = new Date();
    if (period === "day") {
      start.setHours(0, 0, 0, 0);
    } else if (period === "week") {
      start.setDate(start.getDate() - 7);
      start.setHours(0, 0, 0, 0);
    } else {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
    }
    const { data } = await supabase
      .from("transactions")
      .select("amount, txn_type, merchant, category")
      .gte("txn_date", start.toISOString().slice(0, 10));
    let spend = 0;
    let income = 0;
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
    const topMerchants = [...byMerchant.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([merchant, amount]) => ({ merchant, amount }));
    const topCategories = [...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([category, amount]) => ({ category, amount }));
    return { period, spend, income, topMerchants, topCategories };
  },
  findInWindow: async (params: {
    financial_account_id?: string | null;
    credit_card_id?: string | null;
    centerDate: string;
    windowDays: number;
  }) => {
    if (!params.financial_account_id && !params.credit_card_id) return [];
    const center = new Date(params.centerDate);
    const from = new Date(center);
    from.setDate(from.getDate() - params.windowDays);
    const to = new Date(center);
    to.setDate(to.getDate() + params.windowDays);
    let q = supabase
      .from("transactions")
      .select("*")
      .eq("txn_type", "debit")
      .gte("txn_date", from.toISOString().slice(0, 10))
      .lte("txn_date", to.toISOString().slice(0, 10));
    q = params.credit_card_id
      ? q.eq("credit_card_id", params.credit_card_id)
      : q.eq("financial_account_id", params.financial_account_id);
    const { data, error } = await q;
    if (error) throw error;
    return data ?? [];
  },
};
