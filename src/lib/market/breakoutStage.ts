// Derives a human-readable "stage" for a stock in the breakout lifecycle,
// straight from the technical snapshot. Not part of the score — a caption
// that tells the reader where in the coil→trigger→run continuum they are.

import type { IndicatorSnapshot } from "../../../supabase/functions/_shared/market/indicators";

// NO DATA (nothing to read) and NO SETUP (read fine, nothing forming) are
// different facts and used to share the single "LOADING" label.
export type BreakoutStage = "NO DATA" | "NO SETUP" | "COILED" | "ARMED" | "TRIGGERED" | "EXTENDED" | "FAILED";

/**
 * Lifecycle order for sorting. The column used to sort alphabetically, which
 * put ARMED before COILED and EXTENDED before TRIGGERED — no relation to the
 * progression the header tooltip describes.
 */
export const STAGE_ORDER: Record<BreakoutStage, number> = {
  "NO DATA": 0,
  "NO SETUP": 1,
  COILED: 2,
  ARMED: 3,
  TRIGGERED: 4,
  EXTENDED: 5,
  FAILED: 6,
};

export interface StageRead {
  stage: BreakoutStage;
  detail: string;
}

export function deriveBreakoutStage(s: IndicatorSnapshot | null | undefined): StageRead {
  if (!s) return { stage: "NO DATA", detail: "no technical snapshot for this symbol" };
  // A price of 0 (or none) used to be substituted for a missing close, which
  // fed ATR / pivot-distance maths and produced a confident EXTENDED or FAILED
  // read out of nothing at all.
  if (s.close == null || !(s.close > 0)) {
    return { stage: "NO DATA", detail: "no price for this symbol in the latest session" };
  }

  // rollingHigh55 is part of the fetched geometry; without it in the fallback a
  // name whose only level is the 55-day high could never read ARMED/TRIGGERED.
  const pivot = s.pivotLevel ?? s.rollingHigh20 ?? s.rollingHigh55 ?? null;
  const atr = s.atr14 ?? null;

  // FAILED — a breakout fired and price fell back inside the base. This used to
  // render as COILED/NO SETUP (freshness is null once the breakout fails), i.e.
  // the friendliest label for the worst tape. It has to be checked first.
  if (s.breakoutStateKind === "failed") {
    const lvl = s.breakoutLevelCleared ?? pivot;
    return {
      stage: "FAILED",
      detail: lvl != null ? `lost ${lvl.toFixed(2)} after clearing it` : "breakout gave back the level",
    };
  }

  const fresh = s.breakoutFreshnessDays;
  const triggered = pivot != null && s.close > pivot && fresh != null && fresh <= 3;
  const triggerDetail = fresh === 0 ? "cleared pivot today" : `${fresh}d since trigger`;

  // EXTENDED — price is stretched too far above EMA20. When the trigger is also
  // fresh, say both: a strong day-one breakout labelled only "chase risk" reads
  // as if nothing happened.
  if (atr != null && atr > 0 && s.ema20 != null) {
    const atrsAboveEma = (s.close - s.ema20) / atr;
    if (atrsAboveEma >= 3) {
      const base = `${atrsAboveEma.toFixed(1)}× ATR above EMA20 — chase risk`;
      return { stage: "EXTENDED", detail: triggered ? `${triggerDetail}, ${base}` : base };
    }
  }

  // TRIGGERED — close above the strongest pivot within the last few sessions.
  if (triggered) return { stage: "TRIGGERED", detail: triggerDetail };

  // Every coil input is optional: `false` for an unmeasured squeeze is a claim,
  // not a reading. When nothing about the coil is measurable, say NO DATA
  // instead of the friendliest available label.
  const tight = s.baseTightness ?? null;
  const coilInputs = [s.bbSqueeze, s.atrContracting, tight]
    .filter((v) => v != null);
  const coiled = !!(s.bbSqueeze === true || s.atrContracting === true ||
    (tight != null && tight < 0.04 && (s.baseDurationDays ?? 0) >= 15));

  // ARMED — coiled AND within 1 ATR below a real pivot / near resistance.
  if (coiled && atr != null && atr > 0 && pivot != null) {
    const atrsBelow = (pivot - s.close) / atr;
    if (atrsBelow >= 0 && atrsBelow <= 1) {
      return { stage: "ARMED", detail: `${atrsBelow.toFixed(2)}× ATR below pivot` };
    }
  }
  if (coiled && s.nearResistance === true) {
    return { stage: "ARMED", detail: "coiled at resistance" };
  }

  if (coiled) return { stage: "COILED", detail: s.bbSqueeze ? "BB squeeze" : "volatility contracting" };

  if (coilInputs.length === 0) {
    return { stage: "NO DATA", detail: "no volatility or base measurements for this symbol" };
  }

  return { stage: "NO SETUP", detail: "no coil, trigger or extension in the current read" };
}

export const STAGE_TONE: Record<BreakoutStage, "ok" | "accent" | "warn" | "err" | "neutral"> = {
  "NO DATA": "neutral",
  "NO SETUP": "neutral",
  COILED: "accent",
  ARMED: "ok",
  TRIGGERED: "ok",
  EXTENDED: "warn",
  FAILED: "err",
};
