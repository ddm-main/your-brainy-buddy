// market-backtest-run — simple deterministic rule backtester over stored/Yahoo candles.
// P1.12: applies brokerage + slippage on every entry/exit so metrics match
// live-trading reality. Defaults calibrated to Kotak Neo cash-equity delivery:
//   - brokerage ~0.03% per side (flat-fee style broker; Zerodha CNC is 0)
//   - slippage  0.05% per side (typical mid-cap market-order fill drift)
// Overridable per-strategy via strategy.brokerage_pct / strategy.slippage_pct.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { getReadProvider } from "../_shared/market/provider.ts";
import { ema, rsi, type Candle } from "../_shared/market/indicators.ts";
import { createMarketLimiter } from "../_shared/market/rateLimit.ts";

const limiter = createMarketLimiter(10, 60_000);

type Strategy = {
  id: string;
  user_id: string;
  strategy: {
    rule?: string; symbol?: string; exchange?: string;
    stop_loss_pct?: number; target_pct?: number;
    brokerage_pct?: number; slippage_pct?: number;
    // "long" (default) — same v1 behavior as before. "short" runs the
    // reverse: SELL to open, BUY to cover; SL/target measured against entry.
    direction?: "long" | "short";
  };
};

type Trade = {
  entry_time: string;
  exit_time: string;
  entry: number;
  exit: number;
  return_pct: number;
  gross_pct: number;
  costs_pct: number;
};

const DEFAULT_BROKERAGE_PCT = 0.03; // 0.03% per side
const DEFAULT_SLIPPAGE_PCT = 0.05;  // 0.05% per side

const clampYears = (v: unknown) => {
  const n = Number(v ?? 3);
  return Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : 3;
};

const pct = (a: number, b: number) => (b === 0 ? 0 : ((a - b) / b) * 100);
const isoDay = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

function crossAbove(a: (number | null)[], b: (number | null)[], i: number) {
  return a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1]! <= b[i - 1]! && a[i]! > b[i]!;
}
function crossBelow(a: (number | null)[], b: (number | null)[], i: number) {
  return a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1]! >= b[i - 1]! && a[i]! < b[i]!;
}

function maxDrawdown(values: number[]) {
  let peak = values[0] ?? 1;
  let maxDd = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) maxDd = Math.min(maxDd, (v - peak) / peak);
  }
  return maxDd * 100;
}

function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function stdev(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function runRule(
  candles: Candle[],
  rule: string,
  stopLossPct: number,
  targetPct: number,
  brokeragePct: number,
  slippagePct: number,
  direction: "long" | "short",
) {
  const closes = candles.map((c) => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const rs = rsi(closes, 14);

  let inPos = false;
  let entry = 0;
  let entryTime = 0;
  // Entry/rule-exit signals are evaluated on a bar's own close (we can't
  // know that until the bar has finished), so the fill must happen at the
  // NEXT bar's open — filling at the same bar's close is a lookahead bug
  // (it assumes you could observe today's close and transact at that same
  // close simultaneously, which is impossible live). Stop-loss/target are
  // different: the level is fixed at entry, so a resting order can
  // legitimately fill intrabar the same day price touches it.
  let pendingEntry = false;
  let pendingExit = false;
  let equity = 100_000;
  const equityCurve: Array<{ t: string; v: number }> = [];
  const trades: Trade[] = [];

  // Costs applied on both legs. Slippage widens the entry price against you
  // (buy higher / short lower) and the exit price against you too.
  const long = direction === "long";
  const costsRoundTripPct = 2 * (brokeragePct + slippagePct);

  const fillEntry = (i: number, raw: number) => {
    inPos = true;
    // Slip entry against the trade direction.
    entry = raw * (long ? 1 + slippagePct / 100 : 1 - slippagePct / 100);
    entryTime = candles[i].time;
  };
  const fillExit = (i: number, raw: number) => {
    // Slip exit against the trade direction.
    const filled = raw * (long ? 1 - slippagePct / 100 : 1 + slippagePct / 100);
    const grossPct = long ? pct(filled, entry) : pct(entry, filled);
    const retPct = grossPct - 2 * brokeragePct;
    equity *= 1 + retPct / 100;
    trades.push({
      entry_time: isoDay(entryTime),
      exit_time: isoDay(candles[i].time),
      entry, exit: filled, return_pct: retPct,
      gross_pct: grossPct, costs_pct: 2 * brokeragePct + 2 * slippagePct,
    });
    inPos = false;
    entry = 0;
  };

  // Entry signal (direction-aware): long → cross-above / oversold / breakout;
  // short → cross-below / overbought / breakdown.
  const isEntrySignal = (i: number): boolean => {
    const prior20High = Math.max(...candles.slice(Math.max(0, i - 20), i).map((c) => c.high));
    const prior20Low = Math.min(...candles.slice(Math.max(0, i - 20), i).map((c) => c.low));
    if (long) {
      if (rule === "ema_cross_20_50") return crossAbove(e20, e50, i);
      if (rule === "rsi_reversion") return rs[i - 1] != null && rs[i - 1]! < 30 && rs[i] != null && rs[i]! >= 30;
      if (rule === "breakout_20d") return closes[i] > prior20High;
    } else {
      if (rule === "ema_cross_20_50") return crossBelow(e20, e50, i);
      if (rule === "rsi_reversion") return rs[i - 1] != null && rs[i - 1]! > 70 && rs[i] != null && rs[i]! <= 70;
      if (rule === "breakout_20d") return closes[i] < prior20Low;
    }
    return false;
  };
  // Rule-based exit only — stop-loss/target are checked intrabar, separately.
  const isExitSignal = (i: number): boolean => {
    if (long) {
      if (rule === "ema_cross_20_50") return crossBelow(e20, e50, i);
      if (rule === "rsi_reversion") return rs[i] != null && rs[i]! > 70;
      if (rule === "breakout_20d") return closes[i] < (e20[i] ?? closes[i] * 0.92);
    } else {
      if (rule === "ema_cross_20_50") return crossAbove(e20, e50, i);
      if (rule === "rsi_reversion") return rs[i] != null && rs[i]! < 30;
      if (rule === "breakout_20d") return closes[i] > (e20[i] ?? closes[i] * 1.08);
    }
    return false;
  };
  // A stop-loss/target that's only checked against the close would miss a
  // stock that gapped/spiked through the level intrabar and closed back
  // inside the band — understating realized drawdown/loss frequency vs
  // live trading. Returns the level touched, or null.
  const intrabarStopOrTarget = (i: number): number | null => {
    const stopLevel = long ? entry * (1 - Math.abs(stopLossPct) / 100) : entry * (1 + Math.abs(stopLossPct) / 100);
    const targetLevel = long ? entry * (1 + Math.abs(targetPct) / 100) : entry * (1 - Math.abs(targetPct) / 100);
    const { high, low } = candles[i];
    if (long) {
      if (low <= stopLevel) return stopLevel;
      if (high >= targetLevel) return targetLevel;
    } else {
      if (high >= stopLevel) return stopLevel;
      if (low <= targetLevel) return targetLevel;
    }
    return null;
  };

  for (let i = 55; i < candles.length; i++) {
    // Execute signals raised on the previous bar's close at THIS bar's open.
    if (pendingEntry && !inPos) {
      fillEntry(i, candles[i].open);
      pendingEntry = false;
    } else if (pendingExit && inPos) {
      fillExit(i, candles[i].open);
      pendingExit = false;
    }

    if (inPos) {
      const level = intrabarStopOrTarget(i);
      if (level != null) {
        fillExit(i, level);
      } else if (isExitSignal(i)) {
        pendingExit = true;
      }
    } else if (isEntrySignal(i)) {
      pendingEntry = true;
    }

    equityCurve.push({ t: isoDay(candles[i].time), v: Math.round(equity) });
  }
  // Window ended mid-trade with no further bar to fill a next-open exit —
  // close out at the final bar's close (best available reference).
  if (inPos) fillExit(candles.length - 1, closes[candles.length - 1]);
  return { equityCurve, trades, costsRoundTripPct };
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
  const rl = limiter.guard(req, auth.userId); if (rl) return rl;
  try {
    const body = await req.json().catch(() => ({}));
    const strategyId = String(body?.strategy_id ?? "");
    if (!strategyId) return errorResponse(req, "strategy_id required");
    const years = clampYears(body?.period_years);

    const svc = svcClient();
    const { data, error } = await svc.from("market_saved_strategies")
      .select("id,user_id,strategy")
      .eq("id", strategyId)
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (error) return errorResponse(req, error.message, 500);
    const s = data as Strategy | null;
    if (!s) return errorResponse(req, "Strategy not found", 404);

    const symbol = String(s.strategy?.symbol ?? "").toUpperCase();
    const exchange = String(s.strategy?.exchange ?? "NSE").toUpperCase();
    const rule = String(s.strategy?.rule ?? "ema_cross_20_50");
    if (!symbol) return errorResponse(req, "Strategy has no symbol", 400);
    const stopLossPct = Number(s.strategy?.stop_loss_pct);
    const targetPct = Number(s.strategy?.target_pct);
    const effectiveStopLoss = Number.isFinite(stopLossPct) && stopLossPct > 0 ? stopLossPct : 8;
    const effectiveTarget = Number.isFinite(targetPct) && targetPct > 0 ? targetPct : 18;
    const brokeragePct = Number.isFinite(Number(s.strategy?.brokerage_pct)) ? Number(s.strategy?.brokerage_pct) : DEFAULT_BROKERAGE_PCT;
    const slippagePct = Number.isFinite(Number(s.strategy?.slippage_pct)) ? Number(s.strategy?.slippage_pct) : DEFAULT_SLIPPAGE_PCT;
    const direction = s.strategy?.direction === "short" ? "short" : "long";

    // Bucket must always cover the requested period_years — "1y" for a
    // 2-year request silently under-fetched candle history (the cutoff
    // filter below can't reject anything the fetch never returned), so the
    // backtest ran on less data than period_years claimed with no error.
    const range = years > 5 ? "10y" : years > 2 ? "5y" : years > 1 ? "2y" : "1y";
    // Route through the active provider (Kotak Neo when connected — falls
    // back to Yahoo automatically when the symbol has no instrument token or
    // Kotak returns empty).
    const { provider } = await getReadProvider(svc, auth.userId, "candles_1d");
    const allCandles = await provider.getOHLCV(symbol, exchange, range, "1d");
    const cutoff = Math.floor(Date.now() / 1000 - years * 365.25 * 86_400);
    const candles = allCandles.filter((c) => c.time >= cutoff);
    if (candles.length < 80) return errorResponse(req, "Not enough candle history for backtest", 400);

    const { equityCurve, trades, costsRoundTripPct } = runRule(
      candles, rule, effectiveStopLoss, effectiveTarget,
      brokeragePct, slippagePct, direction,
    );
    const returns = trades.map((t) => t.return_pct);
    const wins = returns.filter((r) => r > 0);
    const losses = returns.filter((r) => r <= 0);
    const start = equityCurve[0]?.v ?? 100_000;
    const end = equityCurve[equityCurve.length - 1]?.v ?? start;
    const totalReturn = pct(end, start);
    const actualYears = Math.max(1 / 252, (candles[candles.length - 1].time - candles[0].time) / (365.25 * 86_400));
    const dailyReturns = equityCurve.slice(1).map((p, i) => pct(p.v, equityCurve[i].v) / 100);
    const sigma = stdev(dailyReturns);
    const downside = stdev(dailyReturns.filter((r) => r < 0));
    const avgDaily = mean(dailyReturns);
    const metrics = {
      win_rate: trades.length ? (wins.length / trades.length) * 100 : 0,
      profit_factor: Math.abs(losses.reduce((a, b) => a + b, 0)) > 0 ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0)) : wins.length ? 99 : 0,
      sharpe: sigma ? (avgDaily / sigma) * Math.sqrt(252) : 0,
      sortino: downside ? (avgDaily / downside) * Math.sqrt(252) : 0,
      max_drawdown: maxDrawdown(equityCurve.map((p) => p.v)),
      total_trades: trades.length,
      total_return: totalReturn,
      cagr: ((end / start) ** (1 / actualYears) - 1) * 100,
      // P1.12: expose what costs are subtracting from raw returns so users
      // can compare gross vs net at a glance.
      brokerage_pct: brokeragePct,
      slippage_pct: slippagePct,
      costs_round_trip_pct: costsRoundTripPct,
      direction,
    };

    const { data: inserted, error: insertError } = await svc.from("market_backtest_results")
      .insert({ user_id: auth.userId, strategy_id: strategyId, period_years: years, metrics, equity_curve: equityCurve, trades })
      .select("id")
      .single();
    if (insertError) return errorResponse(req, insertError.message, 500);
    return jsonResponse(req, { ok: true, id: inserted?.id, metrics, trades: trades.length });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 502);
  }
});
