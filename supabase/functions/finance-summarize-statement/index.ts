// Generate a short natural-language summary of a parsed statement using
// Lovable AI. Reads the statement + its extracted transactions, produces
// a 3–5 line summary (top merchants, biggest spends, unusual patterns,
// due-date reminder), and writes it to statements.ai_summary.
//
// Runs on demand from the Statements UI. Cheap: one call per user click,
// short output, no streaming.

import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { svcClient } from "../_shared/gmail.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createLovableAiGatewayProvider } from "../_shared/ai-gateway.ts";
import { generateText } from "npm:ai";
import { z } from "npm:zod";

const Body = z.object({ statement_id: z.string().uuid() });

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) return new Response(JSON.stringify({ error: "ai_unavailable" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return new Response(JSON.stringify({ error: "invalid_body" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

    const svc = svcClient();
    const { data: stmt, error: se } = await svc.from("statements")
      .select("id, statement_type, period_start, period_end, statement_date, due_date, total_due, closing_balance, parse_status, credit_cards(card_name), financial_accounts(nickname), loans(lender_name)")
      .eq("id", parsed.data.statement_id).eq("user_id", auth.userId).maybeSingle();
    if (se) throw se;
    if (!stmt) return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
    if (stmt.parse_status !== "parsed") return new Response(JSON.stringify({ error: "not_parsed" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

    const { data: txns } = await svc.from("transactions")
      .select("txn_date, merchant, category, amount, txn_type, payment_mode")
      .eq("source_statement_id", parsed.data.statement_id)
      .order("amount", { ascending: false })
      .limit(50);

    const entity = (stmt as any).credit_cards?.card_name ?? (stmt as any).financial_accounts?.nickname ?? (stmt as any).loans?.lender_name ?? "account";
    const debits = (txns ?? []).filter((t) => t.txn_type === "debit");
    const credits = (txns ?? []).filter((t) => t.txn_type === "credit");
    const totalDebit = debits.reduce((s, t) => s + Number(t.amount ?? 0), 0);
    const totalCredit = credits.reduce((s, t) => s + Number(t.amount ?? 0), 0);
    const byCat: Record<string, number> = {};
    for (const t of debits) {
      const k = t.category ?? "Uncategorized";
      byCat[k] = (byCat[k] ?? 0) + Number(t.amount ?? 0);
    }
    const topCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const topTxns = debits.slice(0, 10).map((t) => `- ${t.txn_date} · ${t.merchant ?? "?"} · ₹${t.amount}`).join("\n");

    const prompt = `You are JARVIS, Deepak's finance assistant. Summarize this ${stmt.statement_type} statement for "${entity}" in 3-5 short bullet points. Be concrete, use INR, mention:
- period covered
- total spend vs credits
- top 2-3 categories
- any unusual/large single charge
- due-date reminder if applicable

Statement:
- period: ${stmt.period_start ?? "?"} → ${stmt.period_end ?? "?"}
- statement date: ${stmt.statement_date ?? "?"}, due: ${stmt.due_date ?? "?"}
- total due: ${stmt.total_due ?? "?"}, closing balance: ${stmt.closing_balance ?? "?"}
- debits: ${debits.length} totaling ₹${totalDebit.toFixed(2)}
- credits: ${credits.length} totaling ₹${totalCredit.toFixed(2)}
- top categories: ${topCats.map(([c, v]) => `${c} ₹${v.toFixed(0)}`).join(", ") || "n/a"}
- top debit lines:
${topTxns || "(none)"}

Output only the bullet points, no preamble.`;

    const gateway = createLovableAiGatewayProvider(key);
    const { text } = await generateText({
      model: gateway("google/gemini-2.5-flash"),
      prompt,
    });

    const summary = text.trim().slice(0, 2000);
    await svc.from("statements").update({ ai_summary: summary }).eq("id", parsed.data.statement_id);

    return new Response(JSON.stringify({ ok: true, ai_summary: summary }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return sanitizedErrorResponse(err, "Summary failed", "finance-summarize-statement", cors);
  }
});