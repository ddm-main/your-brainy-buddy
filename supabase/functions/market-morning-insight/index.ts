import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor, yahooQuote } from "../_shared/market/common.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const svc = svcClient();
    const [{ data: holdings }, { data: watch }] = await Promise.all([
      svc.from("market_holdings").select("symbol,exchange,quantity,avg_price").eq("user_id", auth.userId),
      svc.from("market_watchlist_items").select("symbol,exchange").eq("user_id", auth.userId),
    ]);
    const indices = await yahooQuote(["^NSEI", "^BSESN", "^NSEBANK", "^INDIAVIX"]);
    const holdingsCtx = (holdings ?? []).map((h: any) => `${h.symbol} qty=${h.quantity} avg=${h.avg_price}`).join(", ") || "none";
    const watchCtx = (watch ?? []).map((w: any) => w.symbol).join(", ") || "none";
    const marketCtx = indices.map((i) => `${i.name} ${i.price} (${i.change_pct?.toFixed(2) ?? "?"}%)`).join(" · ");

    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) return jsonResponse(req, { summary: `Market: ${marketCtx}\nHoldings: ${holdingsCtx}\nWatchlist: ${watchCtx}\n\n(LOVABLE_API_KEY missing — configure to enable AI summary.)` });

    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "You are JARVIS. Give Deepak a crisp 6-8 line Indian market brief for today: market tone, notable sectors, calls to action on his holdings, and 1-2 watchlist items to prioritise. No fluff." },
          { role: "user", content: `Indices: ${marketCtx}\nHoldings: ${holdingsCtx}\nWatchlist: ${watchCtx}` },
        ],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return errorResponse(req, j?.error?.message ?? r.statusText, r.status);
    const summary = j?.choices?.[0]?.message?.content ?? "";
    return jsonResponse(req, { summary });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
