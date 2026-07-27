// market-ai-recommend — nightly cron. For each fresh stock_scores row whose
// score signature changed, ask Gemini for {entry, stop_loss, targets[],
// holding_period_days, risk_level, recommendation, confidence, rationale}
// and upsert into market_stock_ai keyed by score_hash to avoid re-billing.
import { preflight, jsonResponse, errorResponse, svcClient, SHARED_CACHE_USER_ID } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { createLovableAiGatewayProvider } from "../_shared/ai-gateway.ts";
import { sanitizeAiTrade, type AiVerdict } from "../_shared/market/aiTradeValidation.ts";
import { generateText, NoObjectGeneratedError, Output } from "npm:ai";
import { z } from "npm:zod";
import { SCORE_BAND_STRONG, SCORE_BAND_MODERATE, SCORE_BAND_WEAK } from "../_shared/market/scoring.ts";

// Per-run universe cap — highest breakout scores first so the cap keeps the
// names that actually matter, and the response reports what was dropped.
const AI_UNIVERSE_CAP = 500;

function hashScore(s: Record<string, unknown>): string {
  const key = [s.close, s.rsi14, s.macd, s.ema20, s.ema50, s.ema200, s.atr_pct, s.breakout_score, s.prebreakout_score].join("|");
  let h = 0; for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return String(h);
}

const RecoSchema = z.object({
  recommendation: z.enum(["Buy", "Hold", "Wait", "Avoid"]),
  confidence: z.number().min(0).max(1),
  entry_price: z.number(),
  stop_loss: z.number(),
  targets: z.array(z.number()).min(1).max(3),
  holding_period_days: z.number().int().min(1).max(365),
  risk_level: z.enum(["Low", "Medium", "High"]),
  rationale: z.string().max(280),
});

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const gate = await requireCronSecret(req); if (gate) return gate;
  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) return errorResponse(req, "LOVABLE_API_KEY missing", 500);

  try {
    const svc = svcClient();
    const { data: scores } = await svc.from("market_stock_scores")
      .select("*").order("breakout_score", { ascending: false, nullsFirst: false }).limit(AI_UNIVERSE_CAP);
    if (!scores?.length) return jsonResponse(req, { ok: true, updated: 0 });
    const { count: universeCount } = await svc.from("market_stock_scores")
      .select("symbol", { count: "exact", head: true });
    const droppedFromUniverse = Math.max(0, (universeCount ?? 0) - scores.length);

    // Dedupe by score_hash — skip if AI row with same hash already exists.
    const { data: existing } = await svc.from("market_stock_ai")
      .select("symbol,exchange,score_hash").in("symbol", scores.map((s) => s.symbol));
    const seen = new Set((existing ?? []).map((r) => `${r.symbol}:${r.exchange}:${r.score_hash}`));
    const todo = scores.filter((s) => !seen.has(`${s.symbol}:${s.exchange}:${hashScore(s as any)}`));
    if (todo.length === 0) return jsonResponse(req, { ok: true, updated: 0, skipped: scores.length });

    const gateway = createLovableAiGatewayProvider(key);
    const model = gateway("google/gemini-2.5-flash");
    let updated = 0, failed = 0;

    for (const s of todo.slice(0, 100)) { // per-run cap
      const prompt = `You are a technical trading assistant. Given this stock snapshot, output a recommendation.
Symbol: ${s.symbol} (${s.exchange})
Close: ${s.close}  ChangePct: ${s.change_pct}  ATR%: ${s.atr_pct}
RSI14: ${s.rsi14}  MACD: ${s.macd}/${s.macd_signal}  ADX: ${s.adx14}
EMA20/50/200: ${s.ema20}/${s.ema50}/${s.ema200}  Above200: ${s.above_ema200}
52w high/low: ${s.high_52w}/${s.low_52w}  From high%: ${s.pct_from_52w_high}
BB squeeze: ${s.bb_squeeze}  Higher lows: ${s.higher_lows}
Breakout score: ${s.breakout_score}  Pre-breakout score: ${s.prebreakout_score}

Rules:
- entry_price near current close (±2%).
- stop_loss at 1.5× ATR below entry for long ideas.
- targets: 2-3 levels using 1R/2R/3R risk multiples.
- holding_period_days: 7-90 for swing.
- recommendation must reflect breakout_score>=${SCORE_BAND_STRONG} → Buy, ${SCORE_BAND_MODERATE}-${SCORE_BAND_STRONG} → Hold, ${SCORE_BAND_WEAK}-${SCORE_BAND_MODERATE} → Wait, <${SCORE_BAND_WEAK} → Avoid.
- Rationale ≤ 200 chars, no fluff.`;

      try {
        let output: z.infer<typeof RecoSchema> | null = null;
        try {
          const r = await generateText({
            model,
            output: Output.object({ schema: RecoSchema }),
            prompt,
          });
          output = r.output;
        } catch (err) {
          if (NoObjectGeneratedError.isInstance(err) && err.text) {
            // Gemini sometimes wraps JSON in ```json fences or extra prose.
            const raw = err.text;
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) {
              try {
                const parsed = RecoSchema.parse(JSON.parse(match[0]));
                output = parsed;
              } catch { /* fall through */ }
            }
          }
          if (!output) throw err;
        }
        const verdict = (output.recommendation.toLowerCase() as AiVerdict);
        const closePrice = s.close != null ? Number(s.close) : null;
        const sane = sanitizeAiTrade({ verdict, entry: output.entry_price, stop_loss: output.stop_loss, targets: output.targets }, closePrice);
        const sanitizedOutput = { ...output, entry_price: sane.entry, stop_loss: sane.stop_loss, targets: sane.targets, plausibility_flags: sane.flags };
        // market_stock_ai has a unique index on (user_id, symbol, exchange)
        // (market_stock_ai_user_symbol_uidx) — this was a plain .insert()
        // despite the file header calling it an upsert, so it only ever
        // succeeded once per symbol: every subsequent day's re-score (a new
        // score_hash) silently failed the unique constraint and this row
        // never updated again.
        const { error: upsertErr } = await svc.from("market_stock_ai").upsert({
          user_id: SHARED_CACHE_USER_ID,
          symbol: s.symbol,
          exchange: s.exchange,
          recommendation: output.recommendation,
          confidence: output.confidence,
          entry_price: sane.entry,
          stop_loss: sane.stop_loss,
          targets: sane.targets,
          holding_period_days: output.holding_period_days,
          risk_level: output.risk_level,
          rationale: output.rationale,
          score_hash: hashScore(s as any),
          payload: sanitizedOutput,
          computed_at: new Date().toISOString(),
        }, { onConflict: "user_id,symbol,exchange" });
        if (upsertErr) throw upsertErr;
        updated++;
      } catch (e) { failed++; if (failed <= 3) console.error("ai_recommend_fail", s.symbol, e instanceof Error ? e.message : String(e)); }
    }
    return jsonResponse(req, { ok: true, updated, failed, total_candidates: todo.length, universe_cap: AI_UNIVERSE_CAP, dropped_from_universe: droppedFromUniverse });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
