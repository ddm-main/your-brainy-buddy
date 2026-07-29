// Human-readable pattern labels for the Breakout Intelligence panel.
// Source keys mirror `PatternFlags` in supabase/functions/_shared/market/
// indicators-advanced.ts. Bearish reads render with a danger tone so a
// shooting star at resistance is immediately obvious even when the score
// hasn't dropped below its band yet.

export type PatternKey =
  | "cup_and_handle_triggered"
  | "cup_and_handle"
  | "ascending_triangle"
  | "flag"
  | "double_bottom"
  | "inverse_head_shoulders"
  | "falling_wedge"
  | "bullish_engulfing"
  | "hammer"
  | "doji"
  | "bearish_engulfing"
  | "shooting_star";

export interface PatternLabel {
  key: PatternKey;
  label: string;
  tone: "ok" | "accent" | "warn" | "err";
  blurb: string;
  weight: number;
}

// Ordered by conviction (highest first). The panel iterates in this order so
// the most decisive read is what the user sees first.
const REGISTRY: PatternLabel[] = [
  { key: "cup_and_handle_triggered", label: "Cup & handle · triggered", tone: "ok",
    blurb: "cleared the right rim; classic continuation trigger", weight: 10 },
  { key: "cup_and_handle", label: "Cup & handle · forming", tone: "accent",
    blurb: "symmetric U with a tight handle in the upper third", weight: 8 },
  { key: "inverse_head_shoulders", label: "Inv. head & shoulders", tone: "ok",
    blurb: "three troughs (L/H/R); close near neckline", weight: 8 },
  { key: "double_bottom", label: "Double bottom", tone: "ok",
    blurb: "twin lows with a 5%+ rally between them", weight: 7 },
  { key: "ascending_triangle", label: "Ascending triangle", tone: "ok",
    blurb: "3-touch flat top over rising lows", weight: 7 },
  { key: "falling_wedge", label: "Falling wedge", tone: "accent",
    blurb: "converging downtrend; upside resolution", weight: 6 },
  { key: "flag", label: "Bull flag", tone: "accent",
    blurb: "sharp impulse then tight 5-bar pullback", weight: 6 },
  { key: "bullish_engulfing", label: "Bullish engulfing", tone: "ok",
    blurb: "decisive green body engulfs prior red", weight: 5 },
  { key: "hammer", label: "Hammer", tone: "accent",
    blurb: "long lower wick; rejection of the lows", weight: 4 },
  { key: "doji", label: "Doji", tone: "warn",
    blurb: "indecision on real range — awaits confirmation", weight: 2 },
  { key: "bearish_engulfing", label: "Bearish engulfing", tone: "err",
    blurb: "red body engulfs prior green — reversal risk", weight: 5 },
  { key: "shooting_star", label: "Shooting star", tone: "err",
    blurb: "long upper wick — rejection at highs", weight: 4 },
];

export function readPatterns(flags: Record<string, boolean> | null | undefined): PatternLabel[] {
  if (!flags) return [];
  return REGISTRY.filter((p) => flags[p.key]);
}

export function isBearish(p: PatternLabel): boolean {
  return p.tone === "err";
}
