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
  | "stddev" | "chaikinOsc" | "volume" | "volumeProfile";

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
  /** VWAP-style indicators that only make sense on intraday timeframes. */
  intradayOnly?: boolean;
  lines: LineMeta[];
  defaultParams: Record<string, number>;
  defaultWidth: number;
}


const P = (key: string, label: string, min = 1, max = 500, step = 1): ParamMeta => ({ key, label, min, max, step });

// palette
const CY = "#7fe9ff", AM = "#ffb84d", BL = "#5c8aff", GR = "#8affc1",
  PK = "#ff8ae2", TE = "#35d6ed", LI = "#c792ea", UP = "#6bffb0", DN = "#ff5f6d";

const ma = (type: IndicatorType, label: string, color: string): IndicatorDef => ({
  type, label, group: "overlay", hasSource: true,
  params: [P("period", "Length")],
  lines: [{ label, defaultColor: color }],
  defaultParams: { period: 20 }, defaultWidth: 2,
});

// Curated list: the studies actually used for reading a chart here plus the
// two extra inputs of the breakout score (ATR, MFI). The maths for other
// indicators still lives in chartIndicators.ts but is no longer selectable;
// normalizeStudy() drops saved studies whose type is no longer listed.
export const INDICATOR_DEFS: IndicatorDef[] = [
  // ---- overlays ----
  ma("ema", "EMA", CY),
  ma("sma", "SMA", BL),
  { type: "bb", label: "Bollinger Bands", group: "overlay", hasSource: true, params: [P("period", "Length"), P("mult", "StdDev", 0.5, 10, 0.1)], lines: [{ label: "Upper", defaultColor: CY }, { label: "Basis", defaultColor: CY }, { label: "Lower", defaultColor: CY }], defaultParams: { period: 20, mult: 2 }, defaultWidth: 1 },
  { type: "vwap", label: "VWAP", group: "overlay", intradayOnly: true, params: [], lines: [{ label: "VWAP", defaultColor: PK }], defaultParams: {}, defaultWidth: 1 },
  { type: "supertrend", label: "Supertrend", group: "overlay", params: [P("atrPeriod", "ATR"), P("mult", "Mult", 0.5, 10, 0.1)], lines: [{ label: "Up trend", defaultColor: UP }, { label: "Down trend", defaultColor: DN }], defaultParams: { atrPeriod: 10, mult: 3 }, defaultWidth: 2 },
  { type: "volume", label: "Volume", group: "overlay", params: [], lines: [{ label: "Volume (bar color follows candle)", defaultColor: UP }], defaultParams: {}, defaultWidth: 1 },
  // Visible-range volume profile: each row splits into buying / selling volume.
  // side: 1 = right edge, 0 = left edge.
  { type: "volumeProfile", label: "Volume Profile", group: "overlay", params: [P("rows", "Rows", 4, 200), P("valueArea", "Value area %", 10, 100), P("widthPct", "Width %", 5, 60), P("side", "Right side (0/1)", 0, 1)], lines: [{ label: "Buying volume", defaultColor: UP }, { label: "Selling volume", defaultColor: DN }, { label: "POC", defaultColor: AM }], defaultParams: { rows: 24, valueArea: 70, widthPct: 25, side: 1 }, defaultWidth: 1 },
  // ---- oscillators ----
  { type: "rsi", label: "RSI", group: "oscillator", params: [P("period", "Length")], lines: [{ label: "RSI", defaultColor: LI }], defaultParams: { period: 14 }, defaultWidth: 1 },
  { type: "macd", label: "MACD", group: "oscillator", params: [P("fast", "Fast"), P("slow", "Slow"), P("signal", "Signal")], lines: [{ label: "MACD", defaultColor: TE }, { label: "Signal", defaultColor: AM }, { label: "Hist", defaultColor: GR }], defaultParams: { fast: 12, slow: 26, signal: 9 }, defaultWidth: 1 },
  { type: "stochRsi", label: "Stochastic RSI", group: "oscillator", params: [P("rsiPeriod", "RSI"), P("stochPeriod", "Stoch"), P("k", "%K"), P("d", "%D")], lines: [{ label: "%K", defaultColor: LI }, { label: "%D", defaultColor: AM }], defaultParams: { rsiPeriod: 14, stochPeriod: 14, k: 3, d: 3 }, defaultWidth: 1 },
  { type: "adx", label: "ADX / DMI", group: "oscillator", params: [P("period", "Length")], lines: [{ label: "ADX", defaultColor: TE }, { label: "+DI", defaultColor: UP }, { label: "-DI", defaultColor: DN }], defaultParams: { period: 14 }, defaultWidth: 2 },
  // ATR and MFI are inputs of the breakout score — kept so they can be eyeballed.
  { type: "atr", label: "ATR", group: "oscillator", params: [P("period", "Length")], lines: [{ label: "ATR", defaultColor: AM }], defaultParams: { period: 14 }, defaultWidth: 1 },
  { type: "mfi", label: "MFI", group: "oscillator", params: [P("period", "Length")], lines: [{ label: "MFI", defaultColor: LI }], defaultParams: { period: 14 }, defaultWidth: 1 },
  // maPeriod 1 = MA off; resetDaily 1 = restart the cumulative line each IST session.
  { type: "obv", label: "OBV", group: "oscillator", params: [P("maPeriod", "MA length", 1, 200), P("resetDaily", "Reset daily (0/1)", 0, 1)], lines: [{ label: "OBV", defaultColor: BL }, { label: "OBV MA", defaultColor: AM }], defaultParams: { maPeriod: 20, resetDaily: 0 }, defaultWidth: 1 },
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
// params/colors from the current def so it always renders. Params are clamped
// to their def-declared min/max so a corrupt saved layout can't feed negatives
// or 10 000-length periods into the indicator math.
export function normalizeStudy(raw: Study): Study | null {
  const def = DEF_BY_TYPE.get(raw.type);
  if (!def) return null;
  const params: Record<string, number> = { ...def.defaultParams };
  for (const p of def.params) {
    const v = Number(raw.params?.[p.key]);
    if (!Number.isFinite(v)) continue;
    params[p.key] = Math.min(p.max, Math.max(p.min, v));
  }
  return {
    id: raw.id || uid(),
    type: raw.type,
    visible: raw.visible !== false,
    params,
    source: def.hasSource ? (raw.source ?? "close") : undefined,
    colors: def.lines.map((l, i) => raw.colors?.[i] ?? l.defaultColor),
    lineWidth: raw.lineWidth ?? def.defaultWidth,
  };
}


export const DEFAULT_STUDIES: Study[] = [
  makeStudy("volume"),
];

// Short legend label, e.g. "EMA 20" or "MACD 12 26 9".
export function studyLabel(study: Study): string {
  const def = defByType(study.type);
  const vals = def.params.map((p) => study.params[p.key]).filter((v) => v != null);
  return vals.length ? `${def.label} ${vals.join(" ")}` : def.label;
}
