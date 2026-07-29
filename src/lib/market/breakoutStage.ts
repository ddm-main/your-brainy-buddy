// Derives a human-readable "stage" for a stock in the breakout lifecycle,
// straight from the technical snapshot. Not part of the score — a caption
// that tells the reader where in the coil→trigger→run continuum they are.

import type { IndicatorSnapshot } from "../../../supabase/functions/_shared/market/indicators";

export type BreakoutStage = "LOADING" | "COILED" | "ARMED" | "TRIGGERED" | "EXTENDED";

export interface StageRead {
  stage: BreakoutStage;
  detail: string;
}

export function deriveBreakoutStage(s: IndicatorSnapshot | null | undefined): StageRead {
  if (!s) return { stage: "LOADING", detail: "no snapshot" };

  const pivot = s.pivotLevel ?? s.rollingHigh20 ?? null;
  const atr = s.atr14 ?? null;

  // EXTENDED — trigger fired but price is now stretched too far above EMA20.
  if (atr != null && atr > 0 && s.ema20 != null) {
    const atrsAboveEma = (s.close - s.ema20) / atr;
    if (atrsAboveEma >= 3) {
      return { stage: "EXTENDED", detail: `${atrsAboveEma.toFixed(1)}× ATR above EMA20 — chase risk` };
    }
  }

  // TRIGGERED — close above the strongest pivot within the last few sessions.
  if (pivot != null && s.close > pivot) {
    const fresh = s.breakoutFreshnessDays;
    if (fresh != null && fresh <= 3) {
      return { stage: "TRIGGERED", detail: fresh === 0 ? "cleared pivot today" : `${fresh}d since trigger` };
    }
  }

  const coiled = !!(s.bbSqueeze || s.atrContracting ||
    (s.baseTightness != null && s.baseTightness < 0.04 && (s.baseDurationDays ?? 0) >= 15));

  // ARMED — coiled AND within 1 ATR below a real pivot / near resistance.
  if (coiled && atr != null && atr > 0 && pivot != null) {
    const atrsBelow = (pivot - s.close) / atr;
    if (atrsBelow >= 0 && atrsBelow <= 1) {
      return { stage: "ARMED", detail: `${atrsBelow.toFixed(2)}× ATR below pivot` };
    }
  }
  if (coiled && s.nearResistance) {
    return { stage: "ARMED", detail: "coiled at resistance" };
  }

  if (coiled) return { stage: "COILED", detail: s.bbSqueeze ? "BB squeeze" : "volatility contracting" };

  return { stage: "LOADING", detail: "no setup yet" };
}

export const STAGE_TONE: Record<BreakoutStage, "ok" | "accent" | "warn" | "err" | "neutral"> = {
  LOADING: "neutral",
  COILED: "accent",
  ARMED: "ok",
  TRIGGERED: "ok",
  EXTENDED: "warn",
};
