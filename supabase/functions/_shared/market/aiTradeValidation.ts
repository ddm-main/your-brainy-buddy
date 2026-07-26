// Plausibility guardrail for AI-generated trade numbers (entry/stop_loss/
// targets). Both market-stock-insight and market-ai-recommend ask the model
// for numbers "plausible relative to the current close" — nothing
// previously enforced that. A hallucinated or malformed response (entry
// wildly off the real price, stop_loss on the wrong side of entry for the
// verdict, targets not beyond entry) would be cached and served
// indistinguishable from a sound signal a human might act on. This never
// blocks the response — it drops only the fields that fail a hard check and
// records why in `flags`, so callers can still show the rest of the verdict.
export type AiVerdict = "buy" | "hold" | "wait" | "avoid";

export interface AiTradeFields {
  verdict: AiVerdict;
  entry: number | null;
  stop_loss: number | null;
  targets: number[];
}

export interface ValidatedAiTrade extends AiTradeFields {
  flags: string[];
}

// How far the AI's "entry" is allowed to drift from the real current close
// before it's treated as untrustworthy rather than just an aggressive limit.
const MAX_ENTRY_DRIFT_PCT = 15;

export function sanitizeAiTrade(fields: AiTradeFields, closePrice: number | null): ValidatedAiTrade {
  const flags: string[] = [];
  const { verdict } = fields;
  let entry = fields.entry != null && Number.isFinite(fields.entry) ? fields.entry : null;
  let stop_loss = fields.stop_loss != null && Number.isFinite(fields.stop_loss) ? fields.stop_loss : null;
  let targets = (fields.targets ?? []).filter((t) => Number.isFinite(t) && t > 0);

  if (entry != null && closePrice != null && closePrice > 0) {
    const driftPct = (Math.abs(entry - closePrice) / closePrice) * 100;
    if (driftPct > MAX_ENTRY_DRIFT_PCT) {
      flags.push(`entry ₹${entry} is ${driftPct.toFixed(0)}% from close ₹${closePrice} — dropped as implausible`);
      entry = null;
    }
  }

  // Anchor the direction checks on entry when we have (and trust) it,
  // falling back to the real close so a dropped/never-given entry doesn't
  // also disable the stop_loss/targets sanity checks.
  const anchor = entry ?? closePrice;
  if (anchor != null) {
    if (verdict === "buy") {
      if (stop_loss != null && stop_loss >= anchor) {
        flags.push(`stop_loss ₹${stop_loss} is not below entry/close ₹${anchor} for a buy verdict — dropped`);
        stop_loss = null;
      }
      const kept = targets.filter((t) => t > anchor);
      if (kept.length !== targets.length) flags.push("target(s) below entry/close for a buy verdict — dropped");
      targets = kept.sort((a, b) => a - b);
    } else if (verdict === "avoid") {
      if (stop_loss != null && stop_loss <= anchor) {
        flags.push(`stop_loss ₹${stop_loss} is not above entry/close ₹${anchor} for an avoid verdict — dropped`);
        stop_loss = null;
      }
      const kept = targets.filter((t) => t < anchor);
      if (kept.length !== targets.length) flags.push("target(s) above entry/close for an avoid verdict — dropped");
      targets = kept.sort((a, b) => b - a);
    }
  }

  return { verdict, entry, stop_loss, targets, flags };
}
