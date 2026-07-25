// market-backtest-run — simple deterministic rule backtester over stored/Yahoo candles.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient, corsFor } from "../_shared/market/common.ts";
import { yahooChartRetry, toYahooSymbol } from "../_shared/market/yahooClient.ts";
import { ema, rsi, type Candle } from "../_shared/market/indicators.ts";

type Strategy = {
  id: string;
  user_id: string;
  strategy: { rule?: string; symbol?: string; exchange?: string; stop_loss_pct?: number; target_pct?: number };
};

type Trade = {
  entry_time: string;
  exit_time: string;
  entry: number;
  exit: number;
  return_pct: number;
};

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

function runRule(candles: Candle[], rule: string, stopLossPct: number, targetPct: number) {
  const closes = candles.map((c) => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const rs = rsi(closes, 14);

  let inPos = false;
  let entry = 0;
  let entryTime = 0;
  let equity = 100_000;
  const equityCurve: Array<{ t: string; v: number }> = [];
  const trades: Trade[] = [];

  const enter = (i: number) => { inPos = true; entry = closes[i]; entryTime = candles[i].time; };
  const exit = (i: number) => {
    const ret = pct(closes[i], entry);
    equity *= 1 + ret / 100;
    trades.push({ entry_time: isoDay(entryTime), exit_time: isoDay(candles[i].time), entry, exit: closes[i], return_pct: ret });
    inPos = false;
    entry = 0;
  };

  for (let i = 55; i < candles.length; i++) {
    const prior20High = Math.max(...candles.slice(Math.max(0, i - 20), i).map((c) => c.high));
    if (!inPos) {
      if (rule === "ema_cross_20_50" && crossAbove(e20, e50, i)) enter(i);
      else if (rule === "rsi_reversion" && rs[i - 1] != null && rs[i - 1]! < 30 && rs[i] != null && rs[i]! >= 30) enter(i);
      else if (rule === "breakout_20d" && closes[i] > prior20High) enter(i);
    } else {
      const ret = pct(closes[i], entry);
      const shouldExit =
        ret <= -Math.abs(stopLossPct) ||
        ret >= Math.abs(targetPct) ||
        (rule === "ema_cross_20_50" && crossBelow(e20, e50, i)) ||
        (rule === "rsi_reversion" && rs[i] != null && rs[i]! > 70) ||
        (rule === "breakout_20d" && closes[i] < (e20[i] ?? closes[i] * 0.92));
      if (shouldExit) exit(i);
    }
    equityCurve.push({ t: isoDay(candles[i].time), v: Math.round(equity) });
  }
  if (inPos) exit(candles.length - 1);
  return { equityCurve, trades };
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const auth = await requireUserId(req);
  if ("error" in auth) return new Response("unauthorized", { status: 401, headers: corsFor(req) });
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
    // Defaults preserve the historical -8%/+18% band for strategies saved
    // before these fields existed; new strategies set their own via the UI.
    const stopLossPct = Number(s.strategy?.stop_loss_pct);
    const targetPct = Number(s.strategy?.target_pct);
    const effectiveStopLoss = Number.isFinite(stopLossPct) && stopLossPct > 0 ? stopLossPct : 8;
    const effectiveTarget = Number.isFinite(targetPct) && targetPct > 0 ? targetPct : 18;

    const range = years >= 10 ? "10y" : years >= 3 ? "5y" : "1y";
    const allCandles = await yahooChartRetry(toYahooSymbol(symbol, exchange), range, "1d", 3);
    const cutoff = Math.floor(Date.now() / 1000 - years * 365.25 * 86_400);
    const candles = allCandles.filter((c) => c.time >= cutoff);
    if (candles.length < 80) return errorResponse(req, "Not enough candle history for backtest", 400);

    const { equityCurve, trades } = runRule(candles, rule, effectiveStopLoss, effectiveTarget);
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