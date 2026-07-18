// market-stock-insight — per-stock AI verdict.
// Given a symbol, pulls the latest market_stock_scores row + fundamentals
// (from market_fundamentals cache when present) and asks Lovable AI for a
// structured recommendation (buy/hold/wait/avoid + entry/SL/targets/rationale).
// Cached in memory table `market_stock_ai` with 6h TTL — see the migration
// that adds that table. This function creates the row on first hit.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";

const MODEL = "openai/gpt-5.5";
const TTL_MS = 6 * 3600_000;

type Verdict = "buy" | "hold" | "wait" | "avoid";
interface AiPayload {
  verdict: Verdict;
  confidence: number;             // 0..1
  entry: number | null;
  stop_loss: number | null;
  targets: number[];
  holding_period_days: number | null;
  rationale: string;              // 2–4 sentences
  risks: string[];                // short bullets
}

const SYSTEM = `You are JARVIS, Deepak's Indian equities trading analyst.
Given technical + fundamental data for a single stock, output a decisive
short-term (5–30 day) plan. Numbers must be plausible relative to the
current close. If setup is weak, say "wait" or "avoid". Never invent
numbers not derivable from the given context. Keep rationale under 60 words.`;

async function callAi(apiKey: string, prompt: string): Promise<AiPayload> {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": apiKey,
      "X-Lovable-AIG-SDK": "market-stock-insight",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt + "\n\nRespond ONLY as JSON matching this schema: {\"verdict\":\"buy|hold|wait|avoid\",\"confidence\":number,\"entry\":number|null,\"stop_loss\":number|null,\"targets\":[number],\"holding_period_days\":number|null,\"rationale\":\"string\",\"risks\":[\"string\"]}" },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ai_gateway_${res.status}: ${text.slice(0, 200)}`);
  }
  const j = await res.json();
  const raw = j?.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as AiPayload;
  return {
    verdict: (["buy", "hold", "wait", "avoid"].includes(parsed.verdict) ? parsed.verdict : "hold") as Verdict,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5))),
    entry: parsed.entry ?? null,
    stop_loss: parsed.stop_loss ?? null,
    targets: Array.isArray(parsed.targets) ? parsed.targets.slice(0, 3).map(Number).filter(Number.isFinite) : [],
    holding_period_days: parsed.holding_period_days ?? null,
    rationale: String(parsed.rationale ?? "").slice(0, 600),
    risks: Array.isArray(parsed.risks) ? parsed.risks.slice(0, 4).map((r) => String(r).slice(0, 160)) : [],
  };
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  try {
    const body = await req.json().catch(() => ({}));
    const symbol = String(body?.symbol ?? "").toUpperCase();
    const exchange = String(body?.exchange ?? "NSE").toUpperCase();
    const force = !!body?.force;
    if (!symbol) return errorResponse(req, "symbol required");

    const svc = svcClient();

    // Cache hit within TTL?
    if (!force) {
      const { data: cached } = await svc.from("market_stock_ai")
        .select("payload, computed_at")
        .eq("symbol", symbol).eq("exchange", exchange)
        .order("computed_at", { ascending: false })
        .limit(1).maybeSingle();
      if (cached && Date.now() - new Date(cached.computed_at).getTime() < TTL_MS) {
        return jsonResponse(req, { payload: cached.payload, cached: true, computed_at: cached.computed_at });
      }
    }

    const { data: score } = await svc.from("market_stock_scores")
      .select("*").eq("symbol", symbol).eq("exchange", exchange).maybeSingle();
    if (!score) return errorResponse(req, "no coverage — run pipeline for this symbol first", 404);

    const { data: fund } = await svc.from("market_fundamentals")
      .select("payload, fetched_at").eq("symbol", symbol).eq("exchange", exchange)
      .order("fetched_at", { ascending: false }).limit(1).maybeSingle();

    const prompt = `Symbol: ${symbol} (${exchange})
Sector: ${score.sector ?? "unknown"}
Close: ${score.close}  Change%: ${score.change_pct}
Volume: ${score.volume}  RelVol: ${score.rel_volume}
RSI14: ${score.rsi14}  ADX14: ${score.adx14}  ATR%: ${score.atr_pct}
MACD: ${score.macd}/${score.macd_signal}  BB width: ${score.bb_width}  BB squeeze: ${score.bb_squeeze}
EMA20/50/200: ${score.ema20}/${score.ema50}/${score.ema200}
52w high/low: ${score.high_52w}/${score.low_52w}   %fromHigh: ${score.pct_from_52w_high}
Support/Resistance: ${score.support_level}/${score.resistance_level}
Higher lows: ${score.higher_lows}  Above 200EMA: ${score.above_ema200}  Near resistance: ${score.near_resistance}
Breakout score: ${score.breakout_score}   Pre-breakout: ${score.prebreakout_score}
Rel strength vs Nifty: ${score.rel_strength_nifty}
${fund?.payload ? `\nFundamentals: ${JSON.stringify(fund.payload).slice(0, 800)}` : ""}
`;

    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) return errorResponse(req, "LOVABLE_API_KEY not configured", 500);

    const payload = await callAi(apiKey, prompt);
    const computed_at = new Date().toISOString();
    await svc.from("market_stock_ai").insert({
      user_id: auth.userId, symbol, exchange, payload, computed_at,
    });
    return jsonResponse(req, { payload, cached: false, computed_at });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
