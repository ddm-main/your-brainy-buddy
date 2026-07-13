import { supabase, callEdgeFunction, type AnyRow } from "./client";

export const statements = {
  list: async (limit = 200) => {
    const { data, error } = await supabase
      .from("statements")
      .select(
        "*, credit_cards(card_name), financial_accounts(nickname), loans(lender_name)",
      )
      .order("statement_date", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  },
  get: async (id: string) => {
    const { data, error } = await supabase
      .from("statements")
      .select(
        "*, credit_cards(card_name), financial_accounts(nickname), loans(lender_name)",
      )
      .eq("id", id)
      .single();
    if (error) throw error;
    return data;
  },
  latestByCard: async () => {
    const { data, error } = await supabase
      .from("statements")
      .select("*")
      .eq("statement_type", "card")
      .not("credit_card_id", "is", null)
      .order("statement_date", { ascending: false, nullsFirst: false });
    if (error) throw error;
    const latest = new Map<string, AnyRow>();
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
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("source_statement_id", statementId)
      .order("txn_date");
    if (error) throw error;
    return data ?? [];
  },
  upload: async (params: {
    statement_type: "account" | "card" | "loan";
    credit_card_id?: string | null;
    financial_account_id?: string | null;
    loan_id?: string | null;
    filename: string;
    bytesBase64: string;
    password?: string;
  }) =>
    callEdgeFunction("finance-upload-statement", {
      ...params,
      contentType: "application/pdf",
    }),
  signedPdfUrl: async (statementId: string) => {
    const j = await callEdgeFunction("finance-statement-pdf-url", { statement_id: statementId });
    return j.url as string;
  },
  upcomingDues: async (limit = 6) => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from("statements")
      .select("*, credit_cards(card_name), financial_accounts(nickname)")
      .eq("parse_status", "parsed")
      .not("due_date", "is", null)
      .gte("due_date", todayIso)
      .order("due_date", { ascending: true })
      .limit(50);
    if (error) throw error;
    const seen = new Set<string>();
    const latest: AnyRow[] = [];
    for (const s of data ?? []) {
      const key = s.credit_card_id ?? s.financial_account_id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      latest.push(s);
    }
    return latest.slice(0, limit);
  },
  retry: async (
    id: string,
    links?: { credit_card_id?: string | null; financial_account_id?: string | null },
    password?: string,
  ) => callEdgeFunction("finance-retry-statement", { statement_id: id, ...links, password }),
  summarize: async (id: string) =>
    callEdgeFunction("finance-summarize-statement", { statement_id: id }),
};

export const finance = {
  extract: async (opts: { since_days?: number; limit?: number; account_id?: string } = {}) =>
    callEdgeFunction("finance-extract", opts),
};

export const alerts = {
  list: async (opts: { status?: "open" | "dismissed" | "resolved" } = {}) => {
    let q = supabase.from("finance_alerts").select("*").order("expected_date", { ascending: false });
    if (opts.status) q = q.eq("status", opts.status);
    const { data, error } = await q;
    if (error) throw error;
    return data ?? [];
  },
  create: async (patch: AnyRow) => {
    const { data, error } = await supabase.from("finance_alerts").insert(patch).select().single();
    if (error) throw error;
    return data;
  },
  update: async (id: string, patch: AnyRow) => {
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
};
