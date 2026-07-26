// market-stock-insight — per-stock AI verdict.
// Given a symbol, pulls the latest market_stock_scores row + fundamentals
// (from market_fundamentals cache when present) and asks Lovable AI for a
// structured recommendation (buy/hold/wait/avoid + entry/SL/targets/rationale).
// Cached in memory table `market_stock_ai` with 6h TTL — see the migration
// that adds that table. This function creates the row on first hit.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient, SHARED_CACHE_USER_ID } from "../_shared/market/common.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";
import { sanitizeAiTrade } from "../_shared/market/aiTradeValidation.ts";

// Fast, cheap default with a stronger fallback. `openai/gpt-5.5` (the old
// value) is NOT a valid Lovable AI Gateway model id and every call was 400ing
// silently; the "AI unavailable — try refresh" toast users saw was the
// gateway rejecting the model, not a real coverage gap.
const MODEL = "google/gemini-2.5-flash";
const FALLBACK_MODEL = "google/gemini-2.5-pro";
const TTL_MS = 6 * 3600_000;
// AI is the most expensive endpoint here — 20/min/user is generous and
// still blocks a runaway loop from torching gateway credits.
const limiter = createMarketLimiter(20, 60_000);

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
  plausibility_flags?: string[];  // entry/stop_loss/target fields dropped by sanitizeAiTrade
}

const SYSTEM = `You are JARVIS, Deepak's Indian equities trading analyst.
Given technical + fundamental data for a single stock, output a decisive
short-term (5–30 day) plan. Numbers must be plausible relative to the
current close. If setup is weak, say "wait" or "avoid". Never invent
numbers not derivable from the given context. Keep rationale under 60 words.`;

async function callAiOnce(apiKey: string, prompt: string, model: string): Promise<AiPayload> {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": apiKey,
      "X-Lovable-AIG-SDK": "market-stock-insight",
    },
    body: JSON.stringify({
      model,
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
  return parsed;
}

async function callAi(apiKey: string, prompt: string): Promise<AiPayload> {
  let parsed: AiPayload;
  try {
    parsed = await callAiOnce(apiKey, prompt, MODEL);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Retry the stronger model on rate-limit / server errors; propagate
    // otherwise so the caller sees the real gateway response instead of a
    // generic "AI unavailable".
    if (/ai_gateway_(429|5\d\d)/.test(msg)) {
      parsed = await callAiOnce(apiKey, prompt, FALLBACK_MODEL);
    } else {
      throw e;
    }
  }
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

// The nightly `market-ai-recommend` cron writes rows shaped as
// `{ recommendation, entry_price, targets, stop_loss, ... }`, while this
// on-demand endpoint writes `{ verdict, entry, ... }`. Older cached rows
// (from the nightly) therefore rendered a blank AI Verdict chip because
// `payload.verdict` was undefined. Normalise on read so both shapes surface
// the same UI contract.
function normalizeAiPayload(p: any): AiPayload {
  if (!p || typeof p !== "object") {
    return { verdict: "hold", confidence: 0, entry: null, stop_loss: null, targets: [], holding_period_days: null, rationale: "", risks: [] };
  }
  const verdictRaw = p.verdict ?? p.recommendation;
  const map: Record<string, Verdict> = {
    buy: "buy", strong_buy: "buy", accumulate: "buy",
    hold: "hold", neutral: "hold",
    wait: "wait", watch: "wait",
    avoid: "avoid", sell: "avoid", strong_sell: "avoid", reduce: "avoid",
  };
  const verdict: Verdict = map[String(verdictRaw ?? "").toLowerCase()] ?? "hold";
  return {
    verdict,
    confidence: Math.max(0, Math.min(1, Number(p.confidence ?? 0.5))),
    entry: p.entry ?? p.entry_price ?? null,
    stop_loss: p.stop_loss ?? p.stopLoss ?? null,
    targets: Array.isArray(p.targets) ? p.targets.slice(0, 3).map(Number).filter(Number.isFinite) : [],
    holding_period_days: p.holding_period_days ?? p.holdingPeriodDays ?? null,
    rationale: String(p.rationale ?? p.reasoning ?? "").slice(0, 600),
    risks: Array.isArray(p.risks) ? p.risks.slice(0, 4).map((r: unknown) => String(r).slice(0, 160)) : [],
    plausibility_flags: Array.isArray(p.plausibility_flags) ? p.plausibility_flags.map((f: unknown) => String(f)) : undefined,
  };
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const rl = limiter.guard(req, auth.userId); if (rl) return rl;
  try {
    const body = await req.json().catch(() => ({}));
    const symbol = String(body?.symbol ?? "").toUpperCase();
    const exchange = String(body?.exchange ?? "NSE").toUpperCase();
    const force = !!body?.force;
    if (!symbol) return errorResponse(req, "symbol required");

    const svc = svcClient();

    // Cache hit within TTL? Scope by (user_id, symbol, exchange) so one user's
    // manual refresh doesn't shadow another's, and to match the unique index
    // that lets us upsert below.
    if (!force) {
      const { data: cached } = await svc.from("market_stock_ai")
        .select("payload, computed_at")
        .eq("user_id", auth.userId).eq("symbol", symbol).eq("exchange", exchange)
        .order("computed_at", { ascending: false })
        .limit(1).maybeSingle();
      if (cached && Date.now() - new Date(cached.computed_at).getTime() < TTL_MS) {
        return jsonResponse(req, { payload: normalizeAiPayload(cached.payload), cached: true, computed_at: cached.computed_at });
      }
      // The nightly cron (market-ai-recommend) already scores every symbol
      // under SHARED_CACHE_USER_ID — check that before spending a fresh LLM
      // call. Previously these two paths never shared a cache at all: an
      // on-demand click re-paid for a symbol the nightly job scored hours
      // earlier, and the two payload shapes could disagree on verdict for
      // the same symbol at the same time. normalizeAiPayload already
      // reconciles the shape difference (recommendation/entry_price vs
      // verdict/entry).
      const { data: sharedCached } = await svc.from("market_stock_ai")
        .select("payload, computed_at")
        .eq("user_id", SHARED_CACHE_USER_ID).eq("symbol", symbol).eq("exchange", exchange)
        .order("computed_at", { ascending: false })
        .limit(1).maybeSingle();
      if (sharedCached && Date.now() - new Date(sharedCached.computed_at).getTime() < TTL_MS) {
        return jsonResponse(req, { payload: normalizeAiPayload(sharedCached.payload), cached: true, computed_at: sharedCached.computed_at });
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

    const raw = await callAi(apiKey, prompt);
    const closePrice = score.close != null ? Number(score.close) : null;
    const sane = sanitizeAiTrade({ verdict: raw.verdict, entry: raw.entry, stop_loss: raw.stop_loss, targets: raw.targets }, closePrice);
    const payload: AiPayload = {
      ...raw, entry: sane.entry, stop_loss: sane.stop_loss, targets: sane.targets,
      plausibility_flags: sane.flags.length ? sane.flags : undefined,
    };
    const computed_at = new Date().toISOString();
    // Upsert on the unique (user_id, symbol, exchange) index so the cache
    // table stays one-row-per-user-per-stock instead of growing forever.
    await svc.from("market_stock_ai").upsert({
      user_id: auth.userId, symbol, exchange, payload, computed_at,
    }, { onConflict: "user_id,symbol,exchange" });
    return jsonResponse(req, { payload, cached: false, computed_at });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
