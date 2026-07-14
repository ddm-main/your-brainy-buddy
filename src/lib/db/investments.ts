import {
  supabase,
  callEdgeFunction,
  type InvestmentAccount,
  type InvestmentHolding,
  type AnyRow,
} from "./client";

export const investmentAccounts = {
  list: async () =>
    (await supabase.from("investment_accounts").select("*").order("account_name")).data ?? [],
  create: async (a: {
    provider?: string;
    account_name: string;
    account_number_masked?: string;
    notes?: string;
  }) => {
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
};

export const investmentHoldings = {
  list: async (opts: { assetTypes?: string[]; watchlistOnly?: boolean } = {}) => {
    let q = supabase
      .from("investment_holdings")
      .select("*, investment_accounts(account_name)")
      .order("name");
    if (opts.assetTypes?.length) q = q.in("asset_type", opts.assetTypes);
    if (opts.watchlistOnly) q = q.eq("is_watchlist", true);
    const { data, error } = await q;
    if (error) throw error;
    return data ?? [];
  },
  get: async (id: string) => {
    const { data, error } = await supabase
      .from("investment_holdings")
      .select("*, investment_accounts(account_name)")
      .eq("id", id)
      .single();
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
  summary: async () => {
    const { data, error } = await supabase
      .from("investment_holdings")
      .select("asset_type, current_value, invested_amount");
    if (error) throw error;
    const rows = data ?? [];
    const totalValue = rows.reduce((sum: number, r: AnyRow) => sum + (Number(r.current_value) || 0), 0);
    const totalInvested = rows.reduce(
      (sum: number, r: AnyRow) => sum + (Number(r.invested_amount) || 0),
      0,
    );
    return { totalValue, totalInvested, count: rows.length };
  },
};

export const investmentTransactions = {
  list: async (holdingId: string) => {
    const { data, error } = await supabase
      .from("investment_transactions")
      .select("*")
      .eq("holding_id", holdingId)
      .order("txn_date", { ascending: false });
    if (error) throw error;
    return data ?? [];
  },
  create: async (t: {
    holding_id: string;
    txn_type: string;
    txn_date: string;
    units?: number | null;
    price?: number | null;
    amount: number;
    source?: string;
  }) => {
    const { data, error } = await supabase.from("investment_transactions").insert(t).select().single();
    if (error) throw error;
    return data;
  },
  remove: async (id: string) => {
    const { error } = await supabase.from("investment_transactions").delete().eq("id", id);
    if (error) throw error;
  },
};

export const financeSettings = {
  get: async () => {
    const { data, error } = await supabase.from("user_finance_settings").select("*").maybeSingle();
    if (error) throw error;
    return data ?? { enabled_asset_types: ["mutual_fund", "stock"] };
  },
  setEnabledAssetTypes: async (types: string[]) => {
    const { data: existing } = await supabase.from("user_finance_settings").select("id").maybeSingle();
    if (existing) {
      const { error } = await supabase
        .from("user_finance_settings")
        .update({ enabled_asset_types: types, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("user_finance_settings")
        .insert({ enabled_asset_types: types });
      if (error) throw error;
    }
  },
};

export const navSync = {
  sync: async () => callEdgeFunction("finance-sync-nav", {}),
};

export const growwImport = {
  parse: async (params: {
    filename: string;
    bytesBase64?: string;
    csvText?: string;
    investment_account_id?: string | null;
  }) => callEdgeFunction("finance-import-groww", params),
};
