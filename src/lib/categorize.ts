/** Client-side categorization engine.
 * Rule shapes intentionally mirror the DB (`category_rules` table):
 *   match_type: 'merchant' | 'contains' | 'regex'
 * Pure — takes rules + a txn and returns a category (or null).
 * `learnFromCorrection` is a thin Supabase upsert.
 */

import { supabase } from "@/integrations/supabase/client";
import { normalizeMerchant } from "@/lib/merchant";

export interface CategoryRule {
  id?: string;
  match_type: "merchant" | "contains" | "regex";
  pattern: string;
  category: string;
  priority?: number;
}

export interface CategorizableTxn {
  merchant?: string | null;
  description?: string | null;
  category?: string | null;
}

export function applyRules(txn: CategorizableTxn, rules: CategoryRule[]): string | null {
  const merchant = normalizeMerchant(txn.merchant ?? txn.description ?? "");
  const haystack = `${txn.merchant ?? ""} ${txn.description ?? ""}`.toLowerCase();
  const ordered = [...rules].sort((a, b) => (b.priority ?? 100) - (a.priority ?? 100));
  for (const r of ordered) {
    const p = r.pattern.trim();
    if (!p) continue;
    try {
      if (r.match_type === "merchant") {
        const rn = normalizeMerchant(p);
        if (rn && (merchant === rn || merchant.includes(rn))) return r.category;
      } else if (r.match_type === "contains") {
        if (haystack.includes(p.toLowerCase())) return r.category;
      } else if (r.match_type === "regex") {
        if (new RegExp(p, "i").test(haystack)) return r.category;
      }
    } catch {
      // bad regex etc — skip
    }
  }
  return null;
}

/** Called from Txns.tsx when the user renames a category inline.
 * Creates or bumps a merchant-match rule so the next matching txn
 * auto-categorizes correctly. */
export async function learnFromCorrection(txn: CategorizableTxn, newCategory: string, userId: string): Promise<void> {
  const merchant = normalizeMerchant(txn.merchant ?? txn.description ?? "");
  if (!merchant || !newCategory) return;
  const client: any = supabase;
  const { data: existing } = await client
    .from("category_rules")
    .select("id, hits")
    .eq("user_id", userId)
    .eq("match_type", "merchant")
    .eq("pattern", merchant)
    .maybeSingle();
  if (existing?.id) {
    await client
      .from("category_rules")
      .update({ category: newCategory, hits: (existing.hits ?? 0) + 1, last_used_at: new Date().toISOString() })
      .eq("id", existing.id);
  } else {
    await client.from("category_rules").insert({
      user_id: userId,
      match_type: "merchant",
      pattern: merchant,
      category: newCategory,
      priority: 200,
      hits: 1,
      last_used_at: new Date().toISOString(),
    });
  }
}

export async function loadRules(userId: string): Promise<CategoryRule[]> {
  const client: any = supabase;
  const { data } = await client
    .from("category_rules")
    .select("id, match_type, pattern, category, priority")
    .eq("user_id", userId)
    .order("priority", { ascending: false });
  return (data as CategoryRule[]) ?? [];
}