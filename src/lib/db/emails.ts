import { supabase, type EmailAccount, type EmailRow, type AnyRow } from "./client";
import { toSafeError } from "@/lib/errors";

export const emails = {
  list: async (category?: EmailRow["category"], limit = 50) => {
    let q = supabase
      .from("emails")
      .select("*")
      .order("received_at", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (category) q = q.eq("category", category);
    const { data, error } = await q;
    if (error) throw error;
    return data ?? [];
  },
  counts: async () => {
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
};

export const emailAccounts = {
  list: async () => {
    const { data, error } = await supabase.from("email_accounts").select("*").order("email_address");
    if (error) throw error;
    return data ?? [];
  },
  create: async (a: {
    email_address: string;
    provider?: string;
    purpose?: EmailAccount["purpose"];
  }) => {
    const { data, error } = await supabase.from("email_accounts").insert(a).select().single();
    if (error) throw toSafeError(error, "Could not add that mailbox");
    return data;
  },
  update: async (id: string, patch: AnyRow) => {
    const { data, error } = await supabase
      .from("email_accounts")
      .update(patch)
      .eq("id", id)
      .select()
      .single();
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
};
