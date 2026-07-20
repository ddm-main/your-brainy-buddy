// market-alerts-eval — 1-min cron during IST market hours. Evaluates every
// active alert against a live quote (via each user's own active provider —
// Kotak if connected, Yahoo otherwise) plus the latest indicator cache, and
// writes market_alert_events. Delivery to browser push / email is done by
// separate workers reading unfired events; this fn only detects and records.
import { corsFor, preflight, jsonResponse, errorResponse, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret, istTradeDate, isTradingHoliday } from "../_shared/market/cron.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";

function marketOpenNow(): boolean {
  const d = new Date();
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  const day = ist.getUTCDay(); if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const gate = await requireCronSecret(req); if (gate) return gate;
  try {
    if (!marketOpenNow()) return jsonResponse(req, { ok: true, note: "market_closed" });
    const svc = svcClient();
    if (await isTradingHoliday(svc, istTradeDate())) return jsonResponse(req, { ok: true, note: "market_closed_holiday" });
    const { data: alerts } = await svc.from("market_alerts")
      .select("id,user_id,symbol,exchange,alert_type,threshold,config,channel,triggered_at")
      .eq("is_active", true).is("triggered_at", null).limit(1000);
    if (!alerts?.length) return jsonResponse(req, { ok: true, fired: 0 });

    // Live prices come from each user's own active provider (Kotak if
    // connected, Yahoo fallback otherwise) — NOT market_quotes, which is only
    // ever populated by the unrelated personal-finance/mutual-fund sync and
    // never contains NSE equity prices for arbitrary alert symbols.
    const byUser = new Map<string, typeof alerts>();
    for (const a of alerts) {
      const list = byUser.get(a.user_id) ?? [];
      list.push(a);
      byUser.set(a.user_id, list);
    }
    const quoteMap = new Map<string, number>(); // "SYMBOL:EXCHANGE" -> price
    for (const [userId, userAlerts] of byUser) {
      const keys = [...new Set(userAlerts.map((a) => `${a.exchange}:${a.symbol}`))];
      try {
        const { provider } = await getActiveProvider(svc, userId);
        const rows = await provider.getQuotes(keys);
        for (const r of rows) {
          const [exchange, symbol] = r.key.split(":");
          quoteMap.set(`${symbol}:${exchange}`, r.price);
        }
      } catch {
        // one user's provider failing shouldn't block everyone else's alerts
      }
    }

    const symbols = [...new Set(alerts.map((a) => a.symbol))];
    const { data: scores } = await svc.from("market_stock_scores")
      .select("symbol,exchange,close,rsi14,ema20,ema50,ema200,breakout_score")
      .in("symbol", symbols);
    const scoreMap = new Map((scores ?? []).map((s) => [`${s.symbol}:${s.exchange}`, s]));

    const events: unknown[] = [];
    const firedIds: string[] = [];
    for (const a of alerts) {
      const sc = scoreMap.get(`${a.symbol}:${a.exchange}`);
      const px = quoteMap.get(`${a.symbol}:${a.exchange}`) ?? (sc?.close ? Number(sc.close) : undefined);
      let fires = false, val: number | null = null;
      switch (a.alert_type) {
        case "price_above": fires = px != null && px > (a.threshold ?? 0); val = px ?? null; break;
        case "price_below": fires = px != null && px < (a.threshold ?? 0); val = px ?? null; break;
        case "percent_change": {
          const base = sc?.close ? Number(sc.close) : null;
          if (px != null && base) { const p = ((px - base) / base) * 100; fires = Math.abs(p) >= (a.threshold ?? 0); val = p; }
          break;
        }
        case "rsi_above": fires = sc?.rsi14 != null && Number(sc.rsi14) > (a.threshold ?? 0); val = sc?.rsi14 ? Number(sc.rsi14) : null; break;
        case "rsi_below": fires = sc?.rsi14 != null && Number(sc.rsi14) < (a.threshold ?? 0); val = sc?.rsi14 ? Number(sc.rsi14) : null; break;
        case "ema_cross_up": fires = sc?.ema20 != null && sc?.ema50 != null && Number(sc.ema20) > Number(sc.ema50); val = sc?.ema20 ? Number(sc.ema20) : null; break;
        case "breakout": fires = sc?.breakout_score != null && Number(sc.breakout_score) >= (a.threshold ?? 70); val = sc?.breakout_score ? Number(sc.breakout_score) : null; break;
      }
      if (fires) {
        firedIds.push(a.id);
        events.push({
          alert_id: a.id, user_id: a.user_id, symbol: a.symbol, exchange: a.exchange,
          trigger_value: val, channel: a.channel, meta: { type: a.alert_type, threshold: a.threshold },
        });
      }
    }
    if (events.length > 0) {
      await svc.from("market_alert_events").insert(events);
      await svc.from("market_alerts").update({ triggered_at: new Date().toISOString() }).in("id", firedIds);
    }
    return jsonResponse(req, { ok: true, fired: events.length, scanned: alerts.length });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
