// market-ai-recommend — nightly cron. For each fresh stock_scores row whose
// score signature changed, ask Gemini for {entry, stop_loss, targets[],
// holding_period_days, risk_level, recommendation, confidence, rationale}
// and upsert into market_stock_ai keyed by score_hash to avoid re-billing.
import { corsFor, preflight, jsonResponse, errorResponse, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { createLovableAiGatewayProvider } from "../_shared/ai-gateway.ts";
import { generateText, NoObjectGeneratedError, Output } from "npm:ai";
import { z } from "npm:zod";

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
  const gate = requireCronSecret(req); if (gate) return gate;
  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) return errorResponse(req, "LOVABLE_API_KEY missing", 500);

  try {
    const svc = svcClient();
    const { data: scores } = await svc.from("market_stock_scores")
      .select("*").order("computed_at", { ascending: false }).limit(500);
    if (!scores?.length) return jsonResponse(req, { ok: true, updated: 0 });

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
- recommendation must reflect breakout_score>=70 → Buy, 55-70 → Hold, 40-55 → Wait, <40 → Avoid.
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
        await svc.from("market_stock_ai").insert({
          user_id: "00000000-0000-0000-0000-000000000000",
          symbol: s.symbol,
          exchange: s.exchange,
          recommendation: output.recommendation,
          confidence: output.confidence,
          entry_price: output.entry_price,
          stop_loss: output.stop_loss,
          targets: output.targets,
          holding_period_days: output.holding_period_days,
          risk_level: output.risk_level,
          rationale: output.rationale,
          score_hash: hashScore(s as any),
          payload: output,
          computed_at: new Date().toISOString(),
        });
        updated++;
      } catch (e) { failed++; if (failed <= 3) console.error("ai_recommend_fail", s.symbol, e instanceof Error ? e.message : String(e)); }
    }
    return jsonResponse(req, { ok: true, updated, failed, total_candidates: todo.length });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
