// Registry for the chart's indicator "studies" (TradingView-style).
// A Study is one placed instance of an indicator type — you can add several
// (e.g. two EMAs) and each carries its own params, source, colours, and width.
// INDICATOR_DEFS drives the type picker (dropdown), the settings modal, and the
// default colours; the per-type compute + draw lives in CandleChart.
import type { Source } from "@/lib/market/chartIndicators";

export type { Source };

export type IndicatorType =
  | "ema" | "sma" | "wma" | "hma" | "dema" | "tema" | "vwma"
  | "bb" | "envelopes" | "vwap" | "keltner" | "donchian" | "supertrend" | "psar" | "ichimoku"
  | "rsi" | "macd" | "stoch" | "stochRsi" | "adx" | "atr" | "cci" | "williamsR" | "roc"
  | "obv" | "mfi" | "ao" | "mom" | "trix" | "uo" | "cmf" | "ad" | "aroon" | "vortex"
  | "stddev" | "chaikinOsc" | "volume";

export interface Study {
  id: string;
  type: IndicatorType;
  visible: boolean;
  params: Record<string, number>;
  source?: Source;         // present only when the def hasSource
  colors: string[];        // one per drawn line
  lineWidth: number;
}

export interface ParamMeta {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
}

export interface LineMeta {
  label: string;
  defaultColor: string;
}

export interface IndicatorDef {
  type: IndicatorType;
  label: string;
  group: "overlay" | "oscillator";
  params: ParamMeta[];
  hasSource?: boolean;
  lines: LineMeta[];
  defaultParams: Record<string, number>;
  defaultWidth: number;
}

const P = (key: string, label: string, min = 1, max = 500, step = 1): ParamMeta => ({ key, label, min, max, step });

// palette
const CY = "#7fe9ff", AM = "#ffb84d", PU = "#b85cff", BL = "#5c8aff", GR = "#8affc1",
  PK = "#ff8ae2", TE = "#35d6ed", LI = "#c792ea", UP = "#6bffb0", DN = "#ff5f6d", GY = "#e0e0e0";

const ma = (type: IndicatorType, label: string, color: string): IndicatorDef => ({
  type, label, group: "overlay", hasSource: true,
  params: [P("period", "Length")],
  lines: [{ label, defaultColor: color }],
  defaultParams: { period: 20 }, defaultWidth: 2,
});

export const INDICATOR_DEFS: IndicatorDef[] = [
  // ---- overlays: moving averages ----
  ma("ema", "EMA", CY),
  ma("sma", "SMA", BL),
  ma("wma", "WMA", GR),
  ma("hma", "HMA", PK),
  ma("dema", "DEMA", AM),
  ma("tema", "TEMA", PU),
  { type: "vwma", label: "VWMA", group: "overlay", hasSource: true, params: [P("period", "Length")], lines: [{ label: "VWMA", defaultColor: TE }], defaultParams: { period: 20 }, defaultWidth: 2 },
  // ---- overlays: bands / channels ----
  { type: "bb", label: "Bollinger Bands", group: "overlay", hasSource: true, params: [P("period", "Length"), P("mult", "StdDev", 0.5, 10, 0.1)], lines: [{ label: "Upper", defaultColor: CY }, { label: "Basis", defaultColor: CY }, { label: "Lower", defaultColor: CY }], defaultParams: { period: 20, mult: 2 }, defaultWidth: 1 },
  { type: "envelopes", label: "Envelopes", group: "overlay", hasSource: true, params: [P("period", "Length"), P("pct", "Percent", 0.1, 25, 0.1)], lines: [{ label: "Upper", defaultColor: GR }, { label: "Basis", defaultColor: GR }, { label: "Lower", defaultColor: GR }], defaultParams: { period: 20, pct: 2 }, defaultWidth: 1 },
  { type: "keltner", label: "Keltner Channels", group: "overlay", params: [P("emaPeriod", "EMA"), P("atrPeriod", "ATR"), P("mult", "Mult", 0.5, 10, 0.1)], lines: [{ label: "Upper", defaultColor: AM }, { label: "Basis", defaultColor: AM }, { label: "Lower", defaultColor: AM }], defaultParams: { emaPeriod: 20, atrPeriod: 10, mult: 2 }, defaultWidth: 1 },
  { type: "donchian", label: "Donchian Channels", group: "overlay", params: [P("period", "Length")], lines: [{ label: "Upper", defaultColor: BL }, { label: "Basis", defaultColor: BL }, { label: "Lower", defaultColor: BL }], defaultParams: { period: 20 }, defaultWidth: 1 },
  { type: "vwap", label: "VWAP", group: "overlay", params: [], lines: [{ label: "VWAP", defaultColor: PK }], defaultParams: {}, defaultWidth: 1 },
  { type: "supertrend", label: "Supertrend", group: "overlay", params: [P("atrPeriod", "ATR"), P("mult", "Mult", 0.5, 10, 0.1)], lines: [{ label: "Up trend", defaultColor: UP }, { label: "Down trend", defaultColor: DN }], defaultParams: { atrPeriod: 10, mult: 3 }, defaultWidth: 2 },
  { type: "psar", label: "Parabolic SAR", group: "overlay", params: [P("step", "Step", 0.001, 1, 0.001), P("max", "Max", 0.01, 1, 0.01)], lines: [{ label: "PSAR", defaultColor: GY }], defaultParams: { step: 0.02, max: 0.2 }, defaultWidth: 1 },
  { type: "ichimoku", label: "Ichimoku Cloud", group: "overlay", params: [P("conv", "Conversion"), P("base", "Base"), P("spanB", "Span B")], lines: [{ label: "Conversion", defaultColor: TE }, { label: "Base", defaultColor: PK }, { label: "Span A", defaultColor: UP }, { label: "Span B", defaultColor: DN }], defaultParams: { conv: 9, base: 26, spanB: 52 }, defaultWidth: 1 },
  { type: "volume", label: "Volume", group: "overlay", params: [], lines: [{ label: "Volume (bar color follows candle)", defaultColor: UP }], defaultParams: {}, defaultWidth: 1 },
  // ---- oscillators ----
  { type: "rsi", label: "RSI", group: "oscillator", params: [P("period", "Length")], lines: [{ label: "RSI", defaultColor: LI }], defaultParams: { period: 14 }, defaultWidth: 1 },
  { type: "macd", label: "MACD", group: "oscillator", params: [P("fast", "Fast"), P("slow", "Slow"), P("signal", "Signal")], lines: [{ label: "MACD", defaultColor: TE }, { label: "Signal", defaultColor: AM }, { label: "Hist", defaultColor: GR }], defaultParams: { fast: 12, slow: 26, signal: 9 }, defaultWidth: 1 },
  { type: "stoch", label: "Stochastic", group: "oscillator", params: [P("k", "%K"), P("d", "%D"), P("smooth", "Smooth")], lines: [{ label: "%K", defaultColor: TE }, { label: "%D", defaultColor: AM }], defaultParams: { k: 14, d: 3, smooth: 3 }, defaultWidth: 1 },
  { type: "stochRsi", label: "Stochastic RSI", group: "oscillator", params: [P("rsiPeriod", "RSI"), P("stochPeriod", "Stoch"), P("k", "%K"), P("d", "%D")], lines: [{ label: "%K", defaultColor: LI }, { label: "%D", defaultColor: AM }], defaultParams: { rsiPeriod: 14, stochPeriod: 14, k: 3, d: 3 }, defaultWidth: 1 },
  { type: "adx", label: "ADX / DMI", group: "oscillator", params: [P("period", "Length")], lines: [{ label: "ADX", defaultColor: TE }, { label: "+DI", defaultColor: UP }, { label: "-DI", defaultColor: DN }], defaultParams: { period: 14 }, defaultWidth: 2 },
  { type: "atr", label: "ATR", group: "oscillator", params: [P("period", "Length")], lines: [{ label: "ATR", defaultColor: AM }], defaultParams: { period: 14 }, defaultWidth: 1 },
  { type: "cci", label: "CCI", group: "oscillator", params: [P("period", "Length")], lines: [{ label: "CCI", defaultColor: CY }], defaultParams: { period: 20 }, defaultWidth: 1 },
  { type: "williamsR", label: "Williams %R", group: "oscillator", params: [P("period", "Length")], lines: [{ label: "%R", defaultColor: PK }], defaultParams: { period: 14 }, defaultWidth: 1 },
  { type: "roc", label: "ROC", group: "oscillator", params: [P("period", "Length")], lines: [{ label: "ROC", defaultColor: GR }], defaultParams: { period: 12 }, defaultWidth: 1 },
  { type: "mom", label: "Momentum", group: "oscillator", params: [P("period", "Length")], lines: [{ label: "MOM", defaultColor: CY }], defaultParams: { period: 10 }, defaultWidth: 1 },
  { type: "ao", label: "Awesome Oscillator", group: "oscillator", params: [P("fast", "Fast"), P("slow", "Slow")], lines: [{ label: "AO", defaultColor: GR }], defaultParams: { fast: 5, slow: 34 }, defaultWidth: 1 },
  { type: "trix", label: "TRIX", group: "oscillator", params: [P("period", "Length")], lines: [{ label: "TRIX", defaultColor: PK }], defaultParams: { period: 15 }, defaultWidth: 1 },
  { type: "uo", label: "Ultimate Oscillator", group: "oscillator", params: [P("p1", "Fast"), P("p2", "Mid"), P("p3", "Slow")], lines: [{ label: "UO", defaultColor: TE }], defaultParams: { p1: 7, p2: 14, p3: 28 }, defaultWidth: 1 },
  { type: "cmf", label: "Chaikin Money Flow", group: "oscillator", params: [P("period", "Length")], lines: [{ label: "CMF", defaultColor: GR }], defaultParams: { period: 20 }, defaultWidth: 1 },
  { type: "ad", label: "Accum / Dist", group: "oscillator", params: [], lines: [{ label: "A/D", defaultColor: BL }], defaultParams: {}, defaultWidth: 1 },
  { type: "chaikinOsc", label: "Chaikin Oscillator", group: "oscillator", params: [P("fast", "Fast"), P("slow", "Slow")], lines: [{ label: "Chaikin", defaultColor: TE }], defaultParams: { fast: 3, slow: 10 }, defaultWidth: 1 },
  { type: "aroon", label: "Aroon", group: "oscillator", params: [P("period", "Length")], lines: [{ label: "Up", defaultColor: UP }, { label: "Down", defaultColor: DN }], defaultParams: { period: 14 }, defaultWidth: 1 },
  { type: "vortex", label: "Vortex", group: "oscillator", params: [P("period", "Length")], lines: [{ label: "+VI", defaultColor: UP }, { label: "-VI", defaultColor: DN }], defaultParams: { period: 14 }, defaultWidth: 1 },
  { type: "stddev", label: "Std Deviation", group: "oscillator", hasSource: true, params: [P("period", "Length")], lines: [{ label: "StdDev", defaultColor: AM }], defaultParams: { period: 20 }, defaultWidth: 1 },
  { type: "obv", label: "OBV", group: "oscillator", params: [], lines: [{ label: "OBV", defaultColor: BL }], defaultParams: {}, defaultWidth: 1 },
  { type: "mfi", label: "MFI", group: "oscillator", params: [P("period", "Length")], lines: [{ label: "MFI", defaultColor: LI }], defaultParams: { period: 14 }, defaultWidth: 1 },
];

const DEF_BY_TYPE = new Map(INDICATOR_DEFS.map((d) => [d.type, d]));
export function defByType(type: IndicatorType): IndicatorDef {
  const d = DEF_BY_TYPE.get(type);
  if (!d) throw new Error(`unknown indicator type: ${type}`);
  return d;
}

export const OVERLAY_DEFS = INDICATOR_DEFS.filter((d) => d.group === "overlay");
export const OSCILLATOR_DEFS = INDICATOR_DEFS.filter((d) => d.group === "oscillator");

let _seq = 0;
function uid(): string {
  try { if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID(); } catch { /* noop */ }
  return `s_${Date.now().toString(36)}_${(_seq++).toString(36)}`;
}

export function makeStudy(type: IndicatorType, overrides?: { params?: Record<string, number>; visible?: boolean }): Study {
  const def = defByType(type);
  return {
    id: uid(),
    type,
    visible: overrides?.visible ?? true,
    params: { ...def.defaultParams, ...(overrides?.params ?? {}) },
    source: def.hasSource ? "close" : undefined,
    colors: def.lines.map((l) => l.defaultColor),
    lineWidth: def.defaultWidth,
  };
}

// A study restored from storage may predate a def change — backfill any missing
// params/colors from the current def so it always renders.
export function normalizeStudy(raw: Study): Study | null {
  const def = DEF_BY_TYPE.get(raw.type);
  if (!def) return null;
  return {
    id: raw.id || uid(),
    type: raw.type,
    visible: raw.visible !== false,
    params: { ...def.defaultParams, ...(raw.params ?? {}) },
    source: def.hasSource ? (raw.source ?? "close") : undefined,
    colors: def.lines.map((l, i) => raw.colors?.[i] ?? l.defaultColor),
    lineWidth: raw.lineWidth ?? def.defaultWidth,
  };
}

export const DEFAULT_STUDIES: Study[] = [
  makeStudy("ema", { params: { period: 20 } }),
  makeStudy("ema", { params: { period: 50 } }),
  makeStudy("supertrend"),
  makeStudy("volume"),
];

// Short legend label, e.g. "EMA 20" or "MACD 12 26 9".
export function studyLabel(study: Study): string {
  const def = defByType(study.type);
  const vals = def.params.map((p) => study.params[p.key]).filter((v) => v != null);
  return vals.length ? `${def.label} ${vals.join(" ")}` : def.label;
}
