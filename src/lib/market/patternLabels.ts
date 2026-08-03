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
  | "shooting_star"
  | "double_top"
  | "head_shoulders"
  | "rising_wedge"
  | "descending_triangle"
  | "morning_star"
  | "evening_star"
  | "three_white_soldiers"
  | "three_black_crows"
  | "piercing_line"
  | "dark_cloud"
  | "bullish_harami"
  | "bearish_harami"
  | "inverted_hammer"
  | "hanging_man"
  | "dragonfly_doji"
  | "gravestone_doji"
  | "tweezer_bottom"
  | "tweezer_top"
  | "marubozu_bull"
  | "marubozu_bear"
  | "triple_top" | "triple_bottom" | "rounded_top" | "rounded_bottom"
  | "inverse_cup_and_handle" | "bear_flag" | "bull_pennant" | "bear_pennant"
  | "symmetrical_triangle" | "rectangle" | "ascending_channel" | "descending_channel"
  | "horizontal_channel" | "broadening"
  | "spinning_top" | "inside_bar" | "outside_bar" | "nr4" | "nr7"
  | "three_inside_up" | "three_inside_down" | "three_outside_up" | "three_outside_down"
  | "rising_three_methods" | "falling_three_methods" | "tasuki_gap_bull" | "tasuki_gap_bear"
  | "mat_hold" | "gap_up" | "gap_down" | "breakaway_gap" | "runaway_gap" | "exhaustion_gap"
  | "bb_squeeze" | "volatility_breakout"
  | "volume_breakout" | "volume_climax" | "volume_dryup" | "accumulation" | "distribution"
  | "golden_cross" | "death_cross" | "ma_bounce" | "support_bounce" | "resistance_rejection"
  | "trendline_break"
  | "higher_high" | "higher_low" | "lower_high" | "lower_low"
  | "bos_up" | "bos_down" | "choch_up" | "choch_down"
  | "liquidity_sweep_high" | "liquidity_sweep_low" | "fvg_up" | "fvg_down"
  | "order_block_bull" | "order_block_bear"
  | "wyckoff_accumulation" | "wyckoff_distribution" | "wyckoff_spring" | "wyckoff_upthrust";

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
  // --- bearish structures (pattern-series.ts) ---
  { key: "head_shoulders", label: "Head & shoulders", tone: "err",
    blurb: "distribution top; close under the neckline", weight: 9 },
  { key: "double_top", label: "Double top", tone: "err",
    blurb: "twin highs with a 5%+ trough between them", weight: 8 },
  { key: "descending_triangle", label: "Descending triangle", tone: "err",
    blurb: "flat floor under falling highs — supply", weight: 7 },
  { key: "rising_wedge", label: "Rising wedge", tone: "err",
    blurb: "converging uptrend broken to the downside", weight: 6 },
  // --- extended candlestick reads ---
  { key: "morning_star", label: "Morning star", tone: "ok",
    blurb: "three-bar bottoming reversal", weight: 6 },
  { key: "evening_star", label: "Evening star", tone: "err",
    blurb: "three-bar topping reversal", weight: 6 },
  { key: "three_white_soldiers", label: "Three white soldiers", tone: "ok",
    blurb: "three decisive green closes in a row", weight: 6 },
  { key: "three_black_crows", label: "Three black crows", tone: "err",
    blurb: "three decisive red closes in a row", weight: 6 },
  { key: "piercing_line", label: "Piercing line", tone: "ok",
    blurb: "green close back above the prior red midpoint", weight: 4 },
  { key: "dark_cloud", label: "Dark cloud cover", tone: "err",
    blurb: "red close back under the prior green midpoint", weight: 4 },
  { key: "bullish_harami", label: "Bullish harami", tone: "accent",
    blurb: "inside bar after a decisive red — momentum stalling", weight: 3 },
  { key: "bearish_harami", label: "Bearish harami", tone: "warn",
    blurb: "inside bar after a decisive green — momentum stalling", weight: 3 },
  { key: "inverted_hammer", label: "Inverted hammer", tone: "accent",
    blurb: "upper wick after a decline — first bid", weight: 3 },
  { key: "hanging_man", label: "Hanging man", tone: "warn",
    blurb: "lower wick after a rally — supply appearing", weight: 3 },
  { key: "dragonfly_doji", label: "Dragonfly doji", tone: "accent",
    blurb: "full rejection of the lows", weight: 3 },
  { key: "gravestone_doji", label: "Gravestone doji", tone: "warn",
    blurb: "full rejection of the highs", weight: 3 },
  { key: "tweezer_bottom", label: "Tweezer bottom", tone: "ok",
    blurb: "matched lows on consecutive bars", weight: 3 },
  { key: "tweezer_top", label: "Tweezer top", tone: "err",
    blurb: "matched highs on consecutive bars", weight: 3 },
  { key: "marubozu_bull", label: "Bullish marubozu", tone: "ok",
    blurb: "no wicks — buyers held the whole range", weight: 4 },
  { key: "marubozu_bear", label: "Bearish marubozu", tone: "err",
    blurb: "no wicks — sellers held the whole range", weight: 4 },
  // --- extended structures (pattern-structure.ts) ---
  { key: "triple_bottom", label: "Triple bottom", tone: "ok", blurb: "three matched lows — strong base", weight: 8 },
  { key: "triple_top", label: "Triple top", tone: "err", blurb: "three matched highs — heavy supply", weight: 8 },
  { key: "rounded_bottom", label: "Rounded bottom", tone: "ok", blurb: "slow saucer base, trend turning up", weight: 6 },
  { key: "rounded_top", label: "Rounded top", tone: "err", blurb: "slow dome, trend rolling over", weight: 6 },
  { key: "inverse_cup_and_handle", label: "Inverse cup & handle", tone: "err", blurb: "bearish continuation dome with a pause", weight: 6 },
  { key: "bull_pennant", label: "Bull pennant", tone: "accent", blurb: "sharp rally then a converging pause", weight: 6 },
  { key: "bear_flag", label: "Bear flag", tone: "err", blurb: "sharp fall then a drifting bounce", weight: 6 },
  { key: "bear_pennant", label: "Bear pennant", tone: "err", blurb: "sharp fall then a converging pause", weight: 6 },
  { key: "symmetrical_triangle", label: "Symmetrical triangle", tone: "warn", blurb: "coiling range — breaks either way", weight: 4 },
  { key: "rectangle", label: "Rectangle", tone: "warn", blurb: "sideways box; breakout sets direction", weight: 4 },
  { key: "ascending_channel", label: "Ascending channel", tone: "ok", blurb: "higher highs and higher lows in a band", weight: 5 },
  { key: "descending_channel", label: "Descending channel", tone: "err", blurb: "lower highs and lower lows in a band", weight: 5 },
  { key: "horizontal_channel", label: "Horizontal channel", tone: "warn", blurb: "range trading between flat bounds", weight: 3 },
  { key: "broadening", label: "Broadening formation", tone: "warn", blurb: "expanding volatility — hard to trade", weight: 3 },
  // --- bars, gaps, volatility ---
  { key: "spinning_top", label: "Spinning top", tone: "warn", blurb: "small body, wicks both sides — indecision", weight: 2 },
  { key: "inside_bar", label: "Inside bar", tone: "warn", blurb: "compression inside the prior range", weight: 3 },
  { key: "outside_bar", label: "Outside bar", tone: "warn", blurb: "engulfing range — expansion bar", weight: 3 },
  { key: "nr7", label: "NR7", tone: "accent", blurb: "narrowest range of 7 — expansion often follows", weight: 4 },
  { key: "nr4", label: "NR4", tone: "accent", blurb: "narrowest range of 4", weight: 3 },
  { key: "bb_squeeze", label: "Bollinger squeeze", tone: "accent", blurb: "band width at a local floor", weight: 5 },
  { key: "volatility_breakout", label: "Volatility breakout", tone: "accent", blurb: "wide decisive bar out of compression", weight: 5 },
  { key: "gap_up", label: "Gap up", tone: "ok", blurb: "opened above the prior high", weight: 4 },
  { key: "gap_down", label: "Gap down", tone: "err", blurb: "opened below the prior low", weight: 4 },
  { key: "breakaway_gap", label: "Breakaway gap", tone: "ok", blurb: "gap out of a tight base", weight: 6 },
  { key: "runaway_gap", label: "Runaway gap", tone: "accent", blurb: "mid-trend continuation gap", weight: 4 },
  { key: "exhaustion_gap", label: "Exhaustion gap", tone: "warn", blurb: "gap on climax volume — trend may be ending", weight: 5 },
  // --- three-bar continuation / confirmation candles ---
  { key: "three_inside_up", label: "Three inside up", tone: "ok", blurb: "harami confirmed higher", weight: 5 },
  { key: "three_inside_down", label: "Three inside down", tone: "err", blurb: "harami confirmed lower", weight: 5 },
  { key: "three_outside_up", label: "Three outside up", tone: "ok", blurb: "engulfing confirmed higher", weight: 5 },
  { key: "three_outside_down", label: "Three outside down", tone: "err", blurb: "engulfing confirmed lower", weight: 5 },
  { key: "rising_three_methods", label: "Rising three methods", tone: "ok", blurb: "bullish pause inside the impulse bar", weight: 5 },
  { key: "falling_three_methods", label: "Falling three methods", tone: "err", blurb: "bearish pause inside the impulse bar", weight: 5 },
  { key: "tasuki_gap_bull", label: "Upside tasuki gap", tone: "ok", blurb: "gap up only partly filled", weight: 4 },
  { key: "tasuki_gap_bear", label: "Downside tasuki gap", tone: "err", blurb: "gap down only partly filled", weight: 4 },
  { key: "mat_hold", label: "Mat hold", tone: "ok", blurb: "strong continuation holding the impulse", weight: 5 },
  // --- volume ---
  { key: "volume_breakout", label: "Volume breakout", tone: "ok", blurb: "new high on well above average volume", weight: 7 },
  { key: "volume_climax", label: "Volume climax", tone: "warn", blurb: "3x volume on a wide bar — possible exhaustion", weight: 5 },
  { key: "volume_dryup", label: "Volume dry-up", tone: "accent", blurb: "supply drying up in the base", weight: 4 },
  { key: "accumulation", label: "Accumulation", tone: "ok", blurb: "money flowing in inside a range", weight: 6 },
  { key: "distribution", label: "Distribution", tone: "err", blurb: "money flowing out inside a range", weight: 6 },
  { key: "wyckoff_accumulation", label: "Wyckoff accumulation", tone: "ok", blurb: "range with net demand", weight: 6 },
  { key: "wyckoff_distribution", label: "Wyckoff distribution", tone: "err", blurb: "range with net supply", weight: 6 },
  { key: "wyckoff_spring", label: "Wyckoff spring", tone: "ok", blurb: "undercut of the range low, reclaimed", weight: 6 },
  { key: "wyckoff_upthrust", label: "Wyckoff upthrust", tone: "err", blurb: "poke above the range high, rejected", weight: 6 },
  // --- trend / levels ---
  { key: "golden_cross", label: "Golden cross", tone: "ok", blurb: "fast MA crossed above the slow MA", weight: 6 },
  { key: "death_cross", label: "Death cross", tone: "err", blurb: "fast MA crossed below the slow MA", weight: 6 },
  { key: "ma_bounce", label: "MA bounce", tone: "accent", blurb: "tagged the 50 MA and closed above it", weight: 4 },
  { key: "support_bounce", label: "Support bounce", tone: "ok", blurb: "rejected the range low", weight: 5 },
  { key: "resistance_rejection", label: "Resistance rejection", tone: "err", blurb: "rejected at the range high", weight: 5 },
  { key: "trendline_break", label: "Trendline break", tone: "warn", blurb: "closed through the prevailing trendline", weight: 5 },
  // --- market structure (SMC) ---
  { key: "bos_up", label: "Break of structure ↑", tone: "ok", blurb: "closed above the last swing high", weight: 6 },
  { key: "bos_down", label: "Break of structure ↓", tone: "err", blurb: "closed below the last swing low", weight: 6 },
  { key: "choch_up", label: "CHOCH ↑", tone: "ok", blurb: "downtrend structure broken upward", weight: 6 },
  { key: "choch_down", label: "CHOCH ↓", tone: "err", blurb: "uptrend structure broken downward", weight: 6 },
  { key: "higher_high", label: "Higher high", tone: "ok", blurb: "latest swing high above the prior", weight: 3 },
  { key: "higher_low", label: "Higher low", tone: "ok", blurb: "latest swing low above the prior", weight: 3 },
  { key: "lower_high", label: "Lower high", tone: "err", blurb: "latest swing high below the prior", weight: 3 },
  { key: "lower_low", label: "Lower low", tone: "err", blurb: "latest swing low below the prior", weight: 3 },
  { key: "liquidity_sweep_low", label: "Liquidity sweep ↓", tone: "ok", blurb: "stops swept below, price reclaimed", weight: 5 },
  { key: "liquidity_sweep_high", label: "Liquidity sweep ↑", tone: "err", blurb: "stops swept above, price rejected", weight: 5 },
  { key: "fvg_up", label: "Fair value gap ↑", tone: "accent", blurb: "bullish imbalance left behind", weight: 3 },
  { key: "fvg_down", label: "Fair value gap ↓", tone: "warn", blurb: "bearish imbalance left behind", weight: 3 },
  { key: "order_block_bull", label: "Bullish order block", tone: "accent", blurb: "last red bar before an up displacement", weight: 3 },
  { key: "order_block_bear", label: "Bearish order block", tone: "warn", blurb: "last green bar before a down displacement", weight: 3 },
];

export function readPatterns(flags: Record<string, boolean> | null | undefined): PatternLabel[] {
  if (!flags) return [];
  return REGISTRY.filter((p) => flags[p.key]);
}

export function isBearish(p: PatternLabel): boolean {
  return p.tone === "err";
}

/** Key → metadata, for tooltips on per-bar marks and chart structures. */
export const REGISTRY_BY_KEY: Record<string, PatternLabel> =
  Object.fromEntries(REGISTRY.map((p) => [p.key, p]));
