// market-corp-actions-apply — reads unapplied rows from public.corporate_actions,
// builds a per-symbol cumulative adjustment factor, then backfills the *_adjusted
// columns on market_daily_prices. Idempotent: once a corporate action's applied_at
// is set, it is skipped on the next run. Chunked by symbol to keep each edge run
// under the 60-second budget.
//
// Split/bonus formula (post-adjust):
//   factor = ratio_to / ratio_from      (split 2-for-1 → factor 0.5)
//   bonus  1:1                          → factor 0.5 (2 new shares per 1)
// Dividend (cash):
//   factor = (close_prev - amount) / close_prev
//
// Every price on or before ex_date is multiplied by (product of factors for
// events with ex_date > that row's trade_date). This yields comparable
// long-horizon series (Yahoo "adjusted close" style).
import { preflight, jsonResponse, errorResponse, svcClient, corsFor } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";

const SYMBOL_BUDGET = 300;

interface Action {
  id: string;
  symbol: string;
  exchange: string;
  action_type: string;
  ex_date: string;
  ratio_from: number | null;
  ratio_to: number | null;
  amount: number | null;
}

function eventFactor(a: Action, closePrev: number | null): number | null {
  if (a.action_type === "split" || a.action_type === "bonus") {
    const from = Number(a.ratio_from);
    const to = Number(a.ratio_to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return null;
    if (a.action_type === "bonus") {
      // ratio_from:ratio_to bonus (e.g. 1:1) → factor = from / (from + to)
      return from / (from + to);
    }
    // split from-for-to → factor = to / from (e.g. 1 → 2 => 0.5)
    return to / from;
  }
  if (a.action_type === "dividend") {
    if (closePrev == null || closePrev <= 0) return null;
    const amt = Number(a.amount ?? 0);
    if (!Number.isFinite(amt) || amt <= 0) return null;
    return Math.max(0.0001, (closePrev - amt) / closePrev);
  }
  return null;
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const cronGuard = await requireCronSecret(req);
  if (cronGuard) return cronGuard;

  try {
    const svc = svcClient();
    // Pull unapplied actions, oldest first. Group by symbol.
    const { data: unapplied, error: fetchErr } = await svc
      .from("corporate_actions")
      .select("id,symbol,exchange,action_type,ex_date,ratio_from,ratio_to,amount")
      .is("applied_at", null)
      .order("symbol").order("ex_date", { ascending: true })
      .limit(5000);
    if (fetchErr) throw fetchErr;

    const bySymbol = new Map<string, Action[]>();
    for (const a of (unapplied ?? []) as Action[]) {
      const key = `${a.exchange}:${a.symbol}`;
      if (!bySymbol.has(key)) bySymbol.set(key, []);
      bySymbol.get(key)!.push(a);
    }

    let symbolsProcessed = 0, actionsApplied = 0, pricesUpdated = 0, skipped = 0;
    const appliedIds: string[] = [];
    const errors: string[] = [];
    const started = Date.now();

    for (const [key, actions] of bySymbol.entries()) {
      if (symbolsProcessed >= SYMBOL_BUDGET) break;
      if (Date.now() - started > 50_000) break;
      const [exchange, symbol] = key.split(":");

      const { data: rows, error: prcErr } = await svc
        .from("market_daily_prices")
        .select("id,trade_date,open,high,low,close,adj_factor")
        .eq("symbol", symbol).eq("exchange", exchange)
        .order("trade_date", { ascending: true });
      if (prcErr) { errors.push(`${symbol}: ${prcErr.message}`); continue; }
      if (!rows || rows.length === 0) { skipped++; continue; }

      // Build cumulative factor per trade_date: for each ex_date > date, multiply.
      // Walk actions oldest→newest; for dividend, need close on day before ex_date.
      const factors: Array<{ ex_date: string; factor: number; action_id: string }> = [];
      for (const a of actions) {
        // find close on the trading day strictly before ex_date
        const prior = rows.filter((r: any) => r.trade_date < a.ex_date).pop();
        const f = eventFactor(a, prior ? Number(prior.close) : null);
        if (f == null || f <= 0 || f > 5) continue;
        factors.push({ ex_date: a.ex_date, factor: f, action_id: a.id });
      }
      if (factors.length === 0) { skipped++; continue; }

      // Compose cumulative factor per row: product of factors whose ex_date > row.trade_date.
      const updates: Array<Record<string, unknown>> = [];
      for (const r of rows as any[]) {
        let cum = 1;
        for (const f of factors) if (f.ex_date > r.trade_date) cum *= f.factor;
        // Apply on top of any pre-existing adj_factor (idempotent).
        const base = Number(r.adj_factor ?? 1) || 1;
        const finalFactor = base * cum;
        if (Math.abs(finalFactor - base) < 1e-9) continue;
        updates.push({
          id: r.id,
          open_adjusted:  r.open  != null ? Number(r.open)  * cum : null,
          high_adjusted:  r.high  != null ? Number(r.high)  * cum : null,
          low_adjusted:   r.low   != null ? Number(r.low)   * cum : null,
          close_adjusted: r.close != null ? Number(r.close) * cum : null,
          adj_factor: finalFactor,
          adj_applied_at: new Date().toISOString(),
        });
      }

      // Batch upsert in chunks of 500. `id` is PK so upsert = update.
      // A symbol's `factors` are only ever marked applied together, below —
      // if any chunk fails partway through, none of this symbol's actions
      // are marked applied, so the whole symbol retries cleanly next run
      // instead of leaving a split/bonus factor discontinuity permanently
      // baked into part of the price history with no way to detect or fix it.
      let symbolFailed = false;
      for (let i = 0; i < updates.length; i += 500) {
        const chunk = updates.slice(i, i + 500);
        const { error: upErr } = await svc.from("market_daily_prices").upsert(chunk);
        if (upErr) { errors.push(`${symbol} price upsert: ${upErr.message}`); symbolFailed = true; break; }
        pricesUpdated += chunk.length;
      }
      if (symbolFailed) { skipped++; continue; }
      for (const f of factors) appliedIds.push(f.action_id);
      actionsApplied += factors.length;
      symbolsProcessed++;
    }

    // Mark actions as applied in one shot.
    if (appliedIds.length > 0) {
      const nowIso = new Date().toISOString();
      for (let i = 0; i < appliedIds.length; i += 500) {
        const chunk = appliedIds.slice(i, i + 500);
        await svc.from("corporate_actions").update({ applied_at: nowIso }).in("id", chunk);
      }
    }

    await svc.from("market_ingestion_runs").insert({
      source: "corp_actions_apply", stage: "apply",
      status: errors.length > 0 && pricesUpdated === 0 ? "error" : "ok",
      rows_ingested: pricesUpdated,
      duration_ms: Date.now() - started,
      metadata: { symbols: symbolsProcessed, actions_applied: actionsApplied, skipped, errors: errors.slice(0, 20) },
      finished_at: new Date().toISOString(),
    });

    return jsonResponse(req, {
      ok: true, symbols: symbolsProcessed, actions_applied: actionsApplied,
      prices_updated: pricesUpdated, skipped, errors: errors.length,
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});