// market-stock-insight — per-stock AI verdict.
// Given a symbol, pulls the latest market_stock_scores row + fundamentals
// (from market_fundamentals cache when present) and asks Lovable AI for a
// structured recommendation (buy/hold/wait/avoid + entry/SL/targets/rationale).
// Cached in memory table `market_stock_ai` with 6h TTL — see the migration
// that adds that table. This function creates the row on first hit.
import { corsFor, preflight, jsonResponse, errorResponse, requireUserId, svcClient, SHARED_CACHE_USER_ID } from "../_shared/market/common.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";
import { sanitizeAiTrade } from "../_shared/market/aiTradeValidation.ts";
import { classifyHeadline, windowSentiment } from "../_shared/market/newsSentiment.ts";

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
  // How the AI reads the mechanical breakout setup, and how much it would
  // move the v4 score. The Analysis panel applies this on top of the stored
  // score instead of showing the verdict as an unrelated opinion.
  alignment?: "confirms" | "neutral" | "contradicts";
  score_adjustment?: number | null;   // −10..+10
  adjustment_reason?: string | null;
}

const SYSTEM = `You are JARVIS, Deepak's Indian equities trading analyst.
Given technical, fundamental, news-sentiment and market-context data for a
single stock, output a decisive short-term (5–30 day) plan. Weigh ALL of the
supplied evidence: trend and momentum, the breakout score and its component
buckets, volume/liquidity, chart patterns, support/resistance distance,
valuation and balance-sheet quality, recent news sentiment, sector strength
and the market breadth regime. Where the live price differs from the EOD
close the technicals were computed on, reason off the live price.

Also judge the mechanical breakout score: set "alignment" to confirms /
neutral / contradicts and "score_adjustment" to an integer between -10 and
+10 saying how much the evidence the score cannot see (news, fundamentals,
market context, pattern quality) should move it. Use 0 when you have nothing
to add. "adjustment_reason" is one short clause.

Numbers must be plausible relative to the current price. If the setup is
weak, say "wait" or "avoid". Never invent numbers not derivable from the
given context. Keep rationale under 60 words.`;

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
        { role: "user", content: prompt + "\n\nRespond ONLY as JSON matching this schema: {\"verdict\":\"buy|hold|wait|avoid\",\"confidence\":number,\"entry\":number|null,\"stop_loss\":number|null,\"targets\":[number],\"holding_period_days\":number|null,\"rationale\":\"string\",\"risks\":[\"string\"],\"alignment\":\"confirms|neutral|contradicts\",\"score_adjustment\":number,\"adjustment_reason\":\"string\"}" },
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
    // Cap at 0.95: models routinely emit 1.0 ("certain") for an equity call
    // that is never certain, and the UI rendered that as 100% confidence.
    confidence: Math.max(0, Math.min(0.95, Number(parsed.confidence ?? 0.5))),
    entry: parsed.entry ?? null,
    stop_loss: parsed.stop_loss ?? null,
    targets: Array.isArray(parsed.targets) ? parsed.targets.slice(0, 3).map(Number).filter(Number.isFinite) : [],
    holding_period_days: parsed.holding_period_days ?? null,
    rationale: String(parsed.rationale ?? "").slice(0, 600),
    risks: Array.isArray(parsed.risks) ? parsed.risks.slice(0, 4).map((r) => String(r).slice(0, 160)) : [],
    alignment: ["confirms", "neutral", "contradicts"].includes(String(parsed.alignment))
      ? parsed.alignment : "neutral",
    score_adjustment: Number.isFinite(Number(parsed.score_adjustment))
      ? Math.max(-10, Math.min(10, Math.round(Number(parsed.score_adjustment)))) : 0,
    adjustment_reason: parsed.adjustment_reason ? String(parsed.adjustment_reason).slice(0, 160) : null,
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
    confidence: Math.max(0, Math.min(0.95, Number(p.confidence ?? 0.5))),
    entry: p.entry ?? p.entry_price ?? null,
    stop_loss: p.stop_loss ?? p.stopLoss ?? null,
    targets: Array.isArray(p.targets) ? p.targets.slice(0, 3).map(Number).filter(Number.isFinite) : [],
    holding_period_days: p.holding_period_days ?? p.holdingPeriodDays ?? null,
    rationale: String(p.rationale ?? p.reasoning ?? "").slice(0, 600),
    risks: Array.isArray(p.risks) ? p.risks.slice(0, 4).map((r: unknown) => String(r).slice(0, 160)) : [],
    plausibility_flags: Array.isArray(p.plausibility_flags) ? p.plausibility_flags.map((f: unknown) => String(f)) : undefined,
    alignment: ["confirms", "neutral", "contradicts"].includes(String(p.alignment)) ? p.alignment : undefined,
    score_adjustment: Number.isFinite(Number(p.score_adjustment))
      ? Math.max(-10, Math.min(10, Math.round(Number(p.score_adjustment)))) : null,
    adjustment_reason: p.adjustment_reason ? String(p.adjustment_reason).slice(0, 160) : null,
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

    // Fundamentals: the per-user `market_fundamentals` cache is populated only
    // for symbols someone opened the fundamentals panel on, so most verdicts
    // used to be made fundamentals-blind. Fall back to the universe-wide
    // `market_fundamentals_global` table before giving up.
    const { data: fund } = await svc.from("market_fundamentals")
      .select("payload, fetched_at").eq("symbol", symbol).eq("exchange", exchange)
      .order("fetched_at", { ascending: false }).limit(1).maybeSingle();

    let fundText = "";
    let fundAsOf: string | null = null;
    if (fund?.payload) {
      fundText = JSON.stringify(fund.payload).slice(0, 800);
      fundAsOf = fund.fetched_at ?? null;
    } else {
      const { data: gf } = await svc.from("market_fundamentals_global")
        .select("pe_ttm,price_to_book,eps_ttm,roe,roce,debt_to_equity,current_ratio,dividend_yield,revenue_growth,earnings_growth,promoter_holding,beta,market_cap,sector,industry,data_as_of,updated_at")
        .eq("symbol", symbol).eq("exchange", exchange).maybeSingle();
      if (gf) {
        const { data_as_of, updated_at, ...metrics } = gf as Record<string, unknown>;
        fundText = JSON.stringify(metrics).slice(0, 800);
        fundAsOf = (data_as_of as string | null) ?? (updated_at as string | null) ?? null;
      }
    }

    // Extra evidence the verdict used to be blind to: live price, the news
    // window with per-headline sentiment, detected patterns, the v4 bucket
    // breakdown, and the market/sector regime.
    const [{ data: quoteRow }, { data: newsRows }, { data: breadth }] = await Promise.all([
      svc.from("market_quotes").select("ltp,day_change_pct,as_of")
        .eq("symbol", symbol).eq("exchange", exchange)
        .order("as_of", { ascending: false }).limit(1).maybeSingle(),
      svc.from("market_news").select("headline,sentiment,published_at")
        .eq("symbol", symbol).eq("exchange", exchange)
        .order("published_at", { ascending: false }).limit(8),
      svc.from("market_breadth_daily").select("regime,adv_decline_ratio,trade_date")
        .order("trade_date", { ascending: false }).limit(1).maybeSingle(),
    ]);

    const newsItems = (newsRows ?? []).map((n) => ({
      headline: String(n.headline ?? ""),
      sentiment: n.sentiment != null ? Number(n.sentiment) : classifyHeadline(String(n.headline ?? "")).score,
      published_at: (n.published_at as string | null) ?? null,
    }));
    const sent = windowSentiment(newsItems);
    const newsText = newsItems.length
      ? newsItems.map((n) => `- [${n.sentiment >= 0 ? "+" : ""}${n.sentiment.toFixed(2)}] ${n.headline}`).join("\n")
      : "(no recent headlines)";

    const patternText = [
      score.bullish_engulfing && "bullish engulfing", score.bearish_engulfing && "bearish engulfing",
      score.hammer && "hammer", score.shooting_star && "shooting star", score.doji && "doji",
      score.cup_and_handle && "cup & handle", score.flag && "flag",
      score.ascending_triangle && "ascending triangle", score.double_bottom && "double bottom",
      score.inverse_head_shoulders && "inverse H&S", score.falling_wedge && "falling wedge",
    ].filter(Boolean).join(", ") || "none detected";

    const prompt = `Symbol: ${symbol} (${exchange})
Sector: ${score.sector ?? "unknown"}
Data vintage: technicals are end-of-day for ${score.trade_date ?? "an unknown session"} (today is ${new Date().toISOString().slice(0, 10)}).
EOD close: ${score.close}  Change%: ${score.change_pct}
${quoteRow?.ltp != null ? `LIVE price: ${quoteRow.ltp} (${quoteRow.day_change_pct ?? "?"}% today, as of ${quoteRow.as_of}) — anchor entry/stop/targets on this, not the EOD close.` : "Live price: unavailable."}
Volume: ${score.volume}  RelVol: ${score.rel_volume}  Delivery%: ${score.delivery_pct ?? "n/a"}
RSI14: ${score.rsi14}  ADX14: ${score.adx14}  ATR%: ${score.atr_pct}
MACD: ${score.macd}/${score.macd_signal}  BB width: ${score.bb_width}  BB squeeze: ${score.bb_squeeze}
EMA20/50/200: ${score.ema20}/${score.ema50}/${score.ema200}
52w high/low: ${score.high_52w}/${score.low_52w}   %fromHigh: ${score.pct_from_52w_high}
Support/Resistance: ${score.support_level}/${score.resistance_level}
Higher lows: ${score.higher_lows}  Above 200EMA: ${score.above_ema200}  Near resistance: ${score.near_resistance}
Chart patterns: ${patternText}
Breakout score: ${score.breakout_score}   Pre-breakout: ${score.prebreakout_score}   Band: ${score.breakout_band ?? "n/a"}
Rel strength vs Nifty: ${score.rel_strength_nifty}   Sector strength: ${score.sector_strength ?? "n/a"}
Market breadth regime: ${breadth?.regime ?? "unknown"}${breadth?.adv_decline_ratio != null ? ` (A/D ${breadth.adv_decline_ratio})` : ""}
News sentiment: ${sent.avg != null ? sent.avg.toFixed(2) : "n/a"} across ${sent.count} headlines (${sent.positive} positive / ${sent.negative} negative)
Recent headlines:
${newsText}
${fundText ? `\nFundamentals${fundAsOf ? ` (as of ${String(fundAsOf).slice(0, 10)})` : ""}: ${fundText}` : "\nFundamentals: unavailable — do not assert valuation claims."}
`;


    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) return errorResponse(req, "LOVABLE_API_KEY not configured", 500);

    const raw = await callAi(apiKey, prompt);
    const closePrice = quoteRow?.ltp != null ? Number(quoteRow.ltp)
      : score.close != null ? Number(score.close) : null;
    const sane = sanitizeAiTrade({ verdict: raw.verdict, entry: raw.entry, stop_loss: raw.stop_loss, targets: raw.targets }, closePrice);
    // A verdict with no entry, no stop and no targets carries nothing the user
    // can act on — the model still routinely returned 1.0 ("certain") for it,
    // which rendered as a 95% confidence chip next to an empty plan. Cap those
    // at 0.6 so the number reflects how much the answer actually says.
    const noLevels = sane.entry == null && sane.stop_loss == null && sane.targets.length === 0;
    const confidence = noLevels ? Math.min(raw.confidence, 0.6) : raw.confidence;
    const payload: AiPayload = {
      ...raw, confidence, entry: sane.entry, stop_loss: sane.stop_loss, targets: sane.targets,
      plausibility_flags: sane.flags.length ? sane.flags : undefined,
    };
    const computed_at = new Date().toISOString();
    // Upsert on the unique (user_id, symbol, exchange) index so the cache
    // table stays one-row-per-user-per-stock instead of growing forever.
    // The flat columns are written alongside `payload`: the nightly
    // market-ai-recommend job and every list view read those columns, and
    // writing only the JSON blob left them NULL — a stored verdict that no
    // other reader could see.
    await svc.from("market_stock_ai").upsert({
      user_id: auth.userId, symbol, exchange, payload, computed_at,
      recommendation: payload.verdict,
      confidence: payload.confidence,
      entry_price: payload.entry,
      stop_loss: payload.stop_loss,
      targets: payload.targets.length ? payload.targets : null,
      holding_period_days: payload.holding_period_days,
      rationale: payload.rationale || null,
    }, { onConflict: "user_id,symbol,exchange" });
    return jsonResponse(req, { payload, cached: false, computed_at });

  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
