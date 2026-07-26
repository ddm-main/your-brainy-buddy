import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";

// Generous — this now hits the DB cache on every call except the first of
// the day (or an explicit force-refresh), so the limiter exists only to
// bound the force-refresh path, not normal usage.
const limiter = createMarketLimiter(10, 60_000);

function istDateKey(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const rl = limiter.guard(req, auth.userId); if (rl) return rl;
  try {
    const body = await req.json().catch(() => ({}));
    const force = !!body?.force;
    const svc = svcClient();
    const today = istDateKey();

    // A "morning brief" is idempotent within a day — previously every call
    // was a fresh, unbounded LLM spend with no cache at all.
    if (!force) {
      const { data: cached } = await svc.from("market_morning_insight_cache")
        .select("summary, data, computed_at")
        .eq("user_id", auth.userId).eq("brief_date", today)
        .maybeSingle();
      if (cached) return jsonResponse(req, { summary: cached.summary, ...(cached.data as object ?? {}), cached: true, computed_at: cached.computed_at });
    }

    const [{ data: holdings }, { data: watch }] = await Promise.all([
      svc.from("market_holdings").select("symbol,exchange,quantity,avg_price").eq("user_id", auth.userId),
      svc.from("market_watchlist_items").select("symbol,exchange").eq("user_id", auth.userId),
    ]);
    // Route through the active provider (Kotak-first) so the brief uses the
    // same fast path as every other price call. Indices have no Kotak
    // instrument tokens today, so this transparently falls back to Yahoo —
    // but any future index-token mapping lights up automatically.
    const { provider } = await getActiveProvider(svc, auth.userId);
    const indexKeys = ["NSE:^NSEI", "NSE:^BSESN", "NSE:^NSEBANK", "NSE:^INDIAVIX"];
    // Previously a bare `.catch(() => [])` — the model was still asked for
    // "market tone" off an empty context with nothing in the response
    // indicating index data was missing, risking fabricated commentary.
    let indexFetchFailed = false;
    const indexRows = await provider.getQuotes(indexKeys).catch(() => { indexFetchFailed = true; return []; });
    const indexNames: Record<string, string> = {
      "NSE:^NSEI": "Nifty 50", "NSE:^BSESN": "Sensex",
      "NSE:^NSEBANK": "Bank Nifty", "NSE:^INDIAVIX": "India VIX",
    };
    const indices = indexRows.map((r) => ({
      name: indexNames[r.key] ?? r.key, price: r.price, change_pct: r.change_pct,
    }));
    const holdingsCtx = (holdings ?? []).map((h: any) => `${h.symbol} qty=${h.quantity} avg=${h.avg_price}`).join(", ") || "none";
    const watchCtx = (watch ?? []).map((w: any) => w.symbol).join(", ") || "none";
    const marketCtx = indexFetchFailed
      ? "unavailable (index data fetch failed — do not speculate on market tone from this)"
      : indices.map((i) => `${i.name} ${i.price} (${i.change_pct?.toFixed(2) ?? "?"}%)`).join(" · ");

    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) {
      const summary = `Market: ${marketCtx}\nHoldings: ${holdingsCtx}\nWatchlist: ${watchCtx}\n\n(LOVABLE_API_KEY missing — configure to enable AI summary.)`;
      return jsonResponse(req, { summary, index_data_unavailable: indexFetchFailed });
    }

    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "You are JARVIS. Give Deepak a crisp 6-8 line Indian market brief for today: market tone, notable sectors, calls to action on his holdings, and 1-2 watchlist items to prioritise. No fluff. If index data is marked unavailable, say so plainly instead of guessing at market tone." },
          { role: "user", content: `Indices: ${marketCtx}\nHoldings: ${holdingsCtx}\nWatchlist: ${watchCtx}` },
        ],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return errorResponse(req, j?.error?.message ?? r.statusText, r.status);
    const summary = j?.choices?.[0]?.message?.content ?? "";
    const computed_at = new Date().toISOString();
    await svc.from("market_morning_insight_cache").upsert({
      user_id: auth.userId, brief_date: today, summary,
      data: { index_data_unavailable: indexFetchFailed }, computed_at,
    }, { onConflict: "user_id,brief_date" });
    return jsonResponse(req, { summary, index_data_unavailable: indexFetchFailed, cached: false, computed_at });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
