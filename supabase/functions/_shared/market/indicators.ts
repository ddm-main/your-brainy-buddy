// Technical-indicator math. Pure TS, zero Deno/npm imports — unit-tested via vitest.
// All series are oldest → newest. Results align with the input length; positions
// where the indicator is not yet defined are null.

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI
export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const fastE = ema(closes, fast);
  const slowE = ema(closes, slow);
  const macdLine: (number | null)[] = closes.map((_, i) =>
    fastE[i] != null && slowE[i] != null ? (fastE[i] as number) - (slowE[i] as number) : null,
  );
  // Signal = EMA of the macd line where defined
  const defined = macdLine.filter((v): v is number => v != null);
  const sigDefined = ema(defined, signalPeriod);
  const signal: (number | null)[] = new Array(closes.length).fill(null);
  let j = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] != null) {
      signal[i] = sigDefined[j] ?? null;
      j++;
    }
  }
  const hist = macdLine.map((v, i) =>
    v != null && signal[i] != null ? v - (signal[i] as number) : null,
  );
  return { macd: macdLine, signal, hist };
}

export function trueRange(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

// Wilder's ATR
export function atr(candles: Candle[], period = 14): (number | null)[] {
  const tr = trueRange(candles);
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// Wilder's ADX
export function adx(candles: Candle[], period = 14): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period * 2 + 1) return out;
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  const tr = trueRange(candles);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  let smTR = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let smPlus = plusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let smMinus = minusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  const dx: (number | null)[] = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (i > period) {
      smTR = smTR - smTR / period + tr[i];
      smPlus = smPlus - smPlus / period + plusDM[i];
      smMinus = smMinus - smMinus / period + minusDM[i];
    }
    const pDI = smTR === 0 ? 0 : (100 * smPlus) / smTR;
    const mDI = smTR === 0 ? 0 : (100 * smMinus) / smTR;
    const sum = pDI + mDI;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(pDI - mDI)) / sum;
  }
  let adxPrev = 0;
  let count = 0;
  for (let i = period; i < n; i++) {
    if (dx[i] == null) continue;
    count++;
    if (count < period) {
      adxPrev += dx[i] as number;
    } else if (count === period) {
      adxPrev = (adxPrev + (dx[i] as number)) / period;
      out[i] = adxPrev;
    } else {
      adxPrev = (adxPrev * (period - 1) + (dx[i] as number)) / period;
      out[i] = adxPrev;
    }
  }
  return out;
}

export function bollinger(
  closes: number[],
  period = 20,
  mult = 2,
): { upper: (number | null)[]; mid: (number | null)[]; lower: (number | null)[]; width: (number | null)[] } {
  const mid = sma(closes, period);
  const upper: (number | null)[] = new Array(closes.length).fill(null);
  const lower: (number | null)[] = new Array(closes.length).fill(null);
  const width: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const m = mid[i] as number;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - m) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
    width[i] = m === 0 ? null : ((upper[i] as number) - (lower[i] as number)) / m;
  }
  return { upper, mid, lower, width };
}

export function rollingHighLow(
  candles: Candle[],
  period = 252,
): { high: number | null; low: number | null } {
  if (candles.length === 0) return { high: null, low: null };
  const window = candles.slice(-period);
  let high = -Infinity;
  let low = Infinity;
  for (const c of window) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  return { high, low };
}

export function relVolume(volumes: number[], avgPeriod = 20): number | null {
  if (volumes.length < avgPeriod + 1) return null;
  const today = volumes[volumes.length - 1];
  const prior = volumes.slice(-avgPeriod - 1, -1);
  const avg = prior.reduce((a, b) => a + b, 0) / avgPeriod;
  return avg === 0 ? null : today / avg;
}

// True if the last `count` swing lows are strictly ascending.
export function higherLows(lows: number[], lookback = 40, count = 3): boolean {
  const window = lows.slice(-lookback);
  if (window.length < 7) return false;
  const swings: number[] = [];
  for (let i = 2; i < window.length - 2; i++) {
    if (
      window[i] < window[i - 1] &&
      window[i] < window[i - 2] &&
      window[i] < window[i + 1] &&
      window[i] < window[i + 2]
    ) {
      swings.push(window[i]);
    }
  }
  if (swings.length < count) return false;
  const last = swings.slice(-count);
  for (let i = 1; i < last.length; i++) if (last[i] <= last[i - 1]) return false;
  return true;
}

// Cluster swing highs/lows into support & resistance nearest to the last close.
export function supportResistance(
  candles: Candle[],
  lookback = 60,
): { support: number | null; resistance: number | null } {
  const window = candles.slice(-lookback);
  if (window.length < 10) return { support: null, resistance: null };
  const lastClose = window[window.length - 1].close;
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 2; i < window.length - 2; i++) {
    const c = window[i];
    if (c.high > window[i - 1].high && c.high > window[i - 2].high && c.high > window[i + 1].high && c.high > window[i + 2].high) {
      highs.push(c.high);
    }
    if (c.low < window[i - 1].low && c.low < window[i - 2].low && c.low < window[i + 1].low && c.low < window[i + 2].low) {
      lows.push(c.low);
    }
  }
  const resistance = highs.filter((h) => h > lastClose).sort((a, b) => a - b)[0] ?? null;
  const support = lows.filter((l) => l < lastClose).sort((a, b) => b - a)[0] ?? null;
  return { support, resistance };
}

function lastDefined(series: (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) if (series[i] != null) return series[i];
  return null;
}

export interface IndicatorSnapshot {
  close: number;
  changePct: number | null;
  volume: number;
  volAvg20: number | null;
  volAvg30: number | null;
  relVolume: number | null;
  ema20: number | null;
  ema50: number | null;
  ema100: number | null;
  ema200: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  adx14: number | null;
  atr14: number | null;
  atrPct: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  bbWidth: number | null;
  bbSqueeze: boolean;
  atrContracting: boolean;
  high52w: number | null;
  low52w: number | null;
  pctFrom52wHigh: number | null;
  aboveEma200: boolean;
  emaAligned: boolean;
  higherLows: boolean;
  support: number | null;
  resistance: number | null;
  nearResistance: boolean;
  macdHistRising: boolean;
  // Rolling N-day highs (scoring v2 breakout trigger). Optional: pipelines that
  // haven't been updated still work — the trigger falls back to pctFrom52wHigh.
  rollingHigh20?: number | null;
  rollingHigh55?: number | null;
  obvSlope20?: number | null;
  // series for chart overlays (aligned to candles)
  ema20Series: (number | null)[];
  ema50Series: (number | null)[];
  ema200Series: (number | null)[];
}

// Compute everything the scoring engine + Analysis page needs, in one pass.
export function computeSnapshot(candles: Candle[]): IndicatorSnapshot | null {
  if (candles.length < 30) return null;
  const closes = candles.map((c) => c.close);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e100 = ema(closes, 100);
  const e200 = ema(closes, 200);
  const r = rsi(closes, 14);
  const m = macd(closes);
  const a = atr(candles, 14);
  const ax = adx(candles, 14);
  const bb = bollinger(closes, 20, 2);
  const hl = rollingHighLow(candles, 252);

  const close = last.close;
  const ema20v = lastDefined(e20);
  const ema50v = lastDefined(e50);
  const ema100v = lastDefined(e100);
  const ema200v = lastDefined(e200);
  const atrV = lastDefined(a);

  const volAvg20 =
    volumes.length >= 21
      ? volumes.slice(-21, -1).reduce((x, y) => x + y, 0) / 20
      : null;
  // Average of the 30 completed sessions before today. The current session is
  // deliberately excluded: "today's volume > 30D average" must not dilute its
  // own comparison baseline.
  const volAvg30 = volumes.length >= 31
    ? volumes.slice(-31, -1).reduce((sum, value) => sum + value, 0) / 30
    : null;

  // BB squeeze: current width in the bottom 20% of the last 120 sessions' widths
  const widths = bb.width.slice(-120).filter((w): w is number => w != null);
  const curWidth = lastDefined(bb.width);
  let squeeze = false;
  if (curWidth != null && widths.length >= 30) {
    const sorted = [...widths].sort((x, y) => x - y);
    squeeze = curWidth <= sorted[Math.floor(sorted.length * 0.2)];
  }

  // ATR contraction: current ATR% below its 60-session average
  const atrSeries = a.slice(-60).filter((v): v is number => v != null);
  const atrAvg = atrSeries.length ? atrSeries.reduce((x, y) => x + y, 0) / atrSeries.length : null;
  const atrContracting = atrV != null && atrAvg != null && atrV < atrAvg * 0.85;

  const sr = supportResistance(candles, 60);
  const nearRes =
    sr.resistance != null && close >= sr.resistance * 0.97 && close < sr.resistance;

  const macdHistSeries = m.hist.filter((v): v is number => v != null);
  const macdHistRising =
    macdHistSeries.length >= 3 &&
    macdHistSeries[macdHistSeries.length - 1] > macdHistSeries[macdHistSeries.length - 2] &&
    macdHistSeries[macdHistSeries.length - 2] > macdHistSeries[macdHistSeries.length - 3];

  return {
    close,
    changePct: prev.close ? ((close - prev.close) / prev.close) * 100 : null,
    volume: last.volume,
    volAvg20,
    volAvg30,
    relVolume: relVolume(volumes, 20),
    ema20: ema20v,
    ema50: ema50v,
    ema100: ema100v,
    ema200: ema200v,
    rsi14: lastDefined(r),
    macd: lastDefined(m.macd),
    macdSignal: lastDefined(m.signal),
    macdHist: lastDefined(m.hist),
    adx14: lastDefined(ax),
    atr14: atrV,
    atrPct: atrV != null && close ? (atrV / close) * 100 : null,
    bbUpper: lastDefined(bb.upper),
    bbLower: lastDefined(bb.lower),
    bbWidth: curWidth,
    bbSqueeze: squeeze,
    atrContracting,
    high52w: hl.high,
    low52w: hl.low,
    pctFrom52wHigh: hl.high ? ((close - hl.high) / hl.high) * 100 : null,
    aboveEma200: ema200v != null && close > ema200v,
    emaAligned:
      ema20v != null && ema50v != null && ema200v != null && ema20v > ema50v && ema50v > ema200v,
    higherLows: higherLows(lows),
    support: sr.support,
    resistance: sr.resistance,
    nearResistance: nearRes,
    macdHistRising,
    ema20Series: e20,
    ema50Series: e50,
    ema200Series: e200,
  };
}
