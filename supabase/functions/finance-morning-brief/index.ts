// Personalized daily financial brief. Uses live market_quotes plus the
// user's own snapshot (portfolio value, upcoming bills, over-budget
// categories, alerts) to write a 4-6 sentence brief. Cached in
// public.morning_briefs so a second visit on the same day returns the
// stored copy — the AI call runs at most once per user per day unless
// `?force=1` is passed.

import { createClient } from "npm:@supabase/supabase-js@2";
import { generateText } from "npm:ai";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";
import { createLovableAiGatewayProvider } from "../_shared/ai-gateway.ts";

const limiter = createSlidingWindowLimiter(5, 60 * 60_000); // 5/hour/user

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Small helper — 2-decimal % with sign.
function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(2)}%`;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);

  const auth = await requireUserId(req);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const uid = auth.userId;

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, svc, { auth: { persistSession: false } });

    const brief_date = todayIso();

    if (!force) {
      const { data: existing } = await supabase.from("morning_briefs")
        .select("summary, data, updated_at")
        .eq("user_id", uid).eq("brief_date", brief_date).maybeSingle();
      if (existing) {
        return new Response(JSON.stringify({ ok: true, cached: true, ...existing }), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
    }

    const rl = limiter.check(uid);
    if (!rl.ok) {
      return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }), {
        status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
      });
    }

    // Gather everything in parallel — one round-trip.
    const monthStart = brief_date.slice(0, 8) + "01";
    const [quotesR, holdingsR, txnsR, subsR, loansR, alertsR, budgetsR] = await Promise.all([
      supabase.from("market_quotes").select("symbol,name,kind,price,change_pct,currency"),
      supabase.from("investment_holdings").select("asset_type,current_value,invested_amount").eq("user_id", uid),
      supabase.from("transactions").select("amount,type").eq("user_id", uid).gte("txn_date", monthStart),
      supabase.from("subscriptions").select("name,amount,next_due_date").eq("user_id", uid).eq("status", "active"),
      supabase.from("loans").select("lender_name,emi_amount,next_due_date").eq("user_id", uid),
      supabase.from("finance_alerts").select("id,type").eq("user_id", uid).eq("status", "open"),
      supabase.from("budgets").select("category,monthly_limit").eq("user_id", uid),
    ]);

    const quotes = quotesR.data ?? [];
    const holdings = holdingsR.data ?? [];
    const txns = txnsR.data ?? [];
    const subs = subsR.data ?? [];
    const loans = loansR.data ?? [];
    const alerts = alertsR.data ?? [];

    const portfolioValue = holdings.reduce((s: number, h: { current_value: number | null }) => s + (Number(h.current_value) || 0), 0);
    const portfolioInvested = holdings.reduce((s: number, h: { invested_amount: number | null }) => s + (Number(h.invested_amount) || 0), 0);
    const gain = portfolioValue - portfolioInvested;
    const gainPct = portfolioInvested > 0 ? (gain / portfolioInvested) * 100 : null;

    let spend = 0, income = 0;
    for (const t of txns as { amount: number | null; type: string | null }[]) {
      const amt = Number(t.amount) || 0;
      if (t.type === "credit") income += amt; else spend += amt;
    }

    const now = new Date(); now.setHours(0, 0, 0, 0);
    const horizon = new Date(now); horizon.setDate(horizon.getDate() + 7);
    const soon = (d: string | null) => {
      if (!d) return false;
      const t = new Date(d).getTime();
      return t >= now.getTime() && t <= horizon.getTime();
    };
    const upcoming: { label: string; amount: number | null; due: string }[] = [];
    for (const s of subs as { name: string; amount: number | null; next_due_date: string | null }[]) {
      if (soon(s.next_due_date)) upcoming.push({ label: s.name, amount: s.amount, due: s.next_due_date! });
    }
    for (const l of loans as { lender_name: string; emi_amount: number | null; next_due_date: string | null }[]) {
      if (soon(l.next_due_date)) upcoming.push({ label: `${l.lender_name} EMI`, amount: l.emi_amount, due: l.next_due_date! });
    }

    const indianIndices = quotes.filter((q: { kind: string; currency: string }) => q.kind === "index" && q.currency === "INR");
    const globalIndices = quotes.filter((q: { kind: string; currency: string }) => q.kind === "index" && q.currency !== "INR");
    const fx = quotes.find((q: { symbol: string }) => q.symbol === "INR=X");
    const gold = quotes.find((q: { symbol: string }) => q.symbol === "GC=F");

    const marketLine = [
      ...indianIndices.map((q: { name: string; change_pct: number | null }) => `${q.name} ${pct(q.change_pct)}`),
      ...globalIndices.slice(0, 2).map((q: { name: string; change_pct: number | null }) => `${q.name} ${pct(q.change_pct)}`),
      fx ? `USD/INR ₹${Number(fx.price).toFixed(2)} (${pct(fx.change_pct as number | null)})` : null,
      gold ? `Gold ${pct(gold.change_pct as number | null)}` : null,
    ].filter(Boolean).join(" · ");

    const upcomingLine = upcoming.slice(0, 5)
      .map((u) => `${u.label} ${u.amount != null ? "₹" + Math.round(u.amount) : ""} on ${u.due}`).join("; ") || "nothing in the next 7 days";

    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    let summary: string;
    if (!apiKey) {
      // Fallback deterministic brief so the endpoint stays useful without AI.
      summary = `Good morning, Deepak. Markets today: ${marketLine || "no live data"}. ` +
        `Portfolio ₹${Math.round(portfolioValue)} (${gainPct != null ? pct(gainPct) : "no gain data"}). ` +
        `This month so far — income ₹${Math.round(income)}, spend ₹${Math.round(spend)}. ` +
        `Upcoming: ${upcomingLine}. ` +
        (alerts.length ? `${alerts.length} open reconciliation alert${alerts.length > 1 ? "s" : ""}.` : "No open alerts.");
    } else {
      const gateway = createLovableAiGatewayProvider(apiKey);
      const prompt = [
        "You are JARVIS delivering Deepak's personal morning financial brief.",
        "Write 4-6 short sentences. Calm, competent, specific. No fluff.",
        "Cover in this order: (1) how today's markets touch his portfolio, (2) portfolio position with % gain,",
        "(3) upcoming bills/EMIs to act on, (4) one recommendation.",
        "",
        `Markets: ${marketLine || "unavailable"}.`,
        `Portfolio value ₹${Math.round(portfolioValue)}; invested ₹${Math.round(portfolioInvested)}; gain ${gainPct != null ? pct(gainPct) : "n/a"}.`,
        `This month income ₹${Math.round(income)}, spend ₹${Math.round(spend)}.`,
        `Upcoming (7d): ${upcomingLine}.`,
        `Open alerts: ${alerts.length}.`,
      ].join("\n");
      const { text } = await generateText({
        model: gateway("google/gemini-2.5-flash"),
        prompt,
      });
      summary = text.trim();
    }

    const data = {
      market: quotes,
      portfolio: { value: portfolioValue, invested: portfolioInvested, gainPct },
      month: { income, spend },
      upcoming,
      alerts: alerts.length,
    };

    await supabase.from("morning_briefs").upsert(
      { user_id: uid, brief_date, summary, data, updated_at: new Date().toISOString() },
      { onConflict: "user_id,brief_date" },
    );

    return new Response(JSON.stringify({ ok: true, cached: false, brief_date, summary, data }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return sanitizedErrorResponse(err, "Morning brief failed", "finance-morning-brief", cors);
  }
});