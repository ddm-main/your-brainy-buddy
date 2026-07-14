import { jarvisChat } from "@/lib/jarvisChat";
import { supabase } from "@/integrations/supabase/client";

const KEY_PREFIX = "jarvis:briefing:";

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function shouldRunBriefing(): boolean {
  try {
    return !localStorage.getItem(KEY_PREFIX + today());
  } catch {
    return false;
  }
}

export function markBriefingDone() {
  try { localStorage.setItem(KEY_PREFIX + today(), "1"); } catch { /* noop */ }
}

/** Loads a compact finance snapshot for the briefing prompt.
 * Deliberately minimal — a few numbers, no PII merchant strings. */
async function financeContext(): Promise<string> {
  try {
    const client: any = supabase;
    const { data: auth } = await client.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return "";
    const monthStart = new Date();
    monthStart.setDate(1);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    const [{ data: txns }, { data: budgets }, { data: sugg }, { data: accts }, { data: cards }, { data: loans }] = await Promise.all([
      client.from("transactions")
        .select("amount, txn_type, category, txn_date")
        .eq("user_id", uid)
        .gte("txn_date", monthStart.toISOString().slice(0, 10)),
      client.from("budgets").select("category, monthly_limit").eq("user_id", uid),
      client.from("finance_suggestions").select("id").eq("user_id", uid).eq("status", "pending"),
      client.from("financial_accounts").select("current_balance").eq("user_id", uid),
      client.from("credit_cards").select("total_due").eq("user_id", uid),
      client.from("loans").select("outstanding_amount").eq("user_id", uid),
    ]);

    let income = 0, spend = 0;
    const byCat = new Map<string, number>();
    for (const t of txns ?? []) {
      const amt = Number(t.amount) || 0;
      if (t.txn_type === "credit") income += amt;
      else {
        spend += amt;
        const c = t.category ?? "Uncategorized";
        byCat.set(c, (byCat.get(c) ?? 0) + amt);
      }
    }
    const assets = (accts ?? []).reduce((s: number, a: any) => s + (Number(a.current_balance) || 0), 0);
    const cardDebt = (cards ?? []).reduce((s: number, c: any) => s + (Number(c.total_due) || 0), 0);
    const loanDebt = (loans ?? []).reduce((s: number, l: any) => s + (Number(l.outstanding_amount) || 0), 0);
    const netWorth = Math.round(assets - cardDebt - loanDebt);
    const topOver = (budgets ?? [])
      .map((b: any) => {
        const s = byCat.get(b.category) ?? 0;
        const pct = b.monthly_limit > 0 ? (s / b.monthly_limit) * 100 : 0;
        return { cat: b.category, pct };
      })
      .filter((x: any) => x.pct >= 80)
      .sort((a: any, b: any) => b.pct - a.pct)[0];

    const parts = [
      `net-worth ₹${netWorth}`,
      `MTD income ₹${Math.round(income)} · spend ₹${Math.round(spend)}`,
      topOver ? `over/near budget: ${topOver.cat} at ${Math.round(topOver.pct)}%` : "budgets on-track",
      `${(sugg ?? []).length} pending finance suggestions`,
      `${weekAgo}→today snapshot`,
    ];
    return `Finance snapshot: ${parts.join("; ")}.`;
  } catch {
    return "";
  }
}

export async function runMorningBriefing(force = false) {
  if (!force) {
    if (!shouldRunBriefing()) return;
    markBriefingDone();
  }
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const finance = await financeContext();
  const prompt =
    `System briefing request. Deliver a one-line ${greet.toLowerCase()} greeting to Deepak, ` +
    `then in the same turn call web_search{mode:"news"} for "today world tech news" and weather{location:"Mumbai"}. ` +
    `After the tool results, summarize the top news headline and current weather in two short sentences, ` +
    `then add one short line about Deepak's finances using this data: ${finance || "(no finance data yet)"}.`;
  try {
    await jarvisChat(prompt);
  } catch (err) {
    console.warn("briefing failed", err);
  }
}
