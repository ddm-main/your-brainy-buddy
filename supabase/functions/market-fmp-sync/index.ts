// Kotak Neo has no coverage for this data (fundamentals / news / reference / option-chain) — vendor-specific by design; do not re-route to getActiveProvider.
// market-fmp-sync — nightly trickle sync of Financial Modeling Prep data
// (Priority 2 fundamentals per the multi-provider spec). FMP's free tier is
// 250 requests/day; fmpFundamentals() costs 6 calls/symbol, so this budgets
// ~35 symbols/run to stay well under quota with headroom for manual triggers
// the same day. Cursor-based (fmp_synced_at) so it self-drains across the
// universe over ~2 months and re-covers on a rolling basis.
//
// Only writes fields FMP actually returned (partial update, not full upsert)
// so it layers on top of — never blanks out — the Yahoo/NSE data already in
// market_data from market-fundamentals-global-sync.
import { preflight, jsonResponse, errorResponse, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { requireUserId } from "../_shared/auth.ts";
import { fmpFundamentals } from "../_shared/market/fmpClient.ts";
import { lowBandwidthMode } from "../_shared/market/cron.ts";

const CHUNK = 35;
const CONCURRENCY = 3;

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.headers.get("x-cron-secret") != null) {
    const guard = await requireCronSecret(req);
    if (guard) return guard;
  } else {
    const auth = await requireUserId(req);
    if ("error" in auth) return auth.error;
  }

  try {
    const svc = svcClient();
    // Free-plan brake: skip non-essential syncs when a quota meter is hot.
    if (await lowBandwidthMode(svc)) return jsonResponse(req, { ok: true, skipped: "low_bandwidth" });

    if (!Deno.env.get("FINANCIAL_MODELING_PREP_API_KEY")) {
      return jsonResponse(req, { ok: true, note: "FMP API key not configured — skipping", processed: 0 });
    }

    const { data: stocks, error } = await svc.from("market_data")
      .select("symbol,exchange")
      .eq("is_active", true)
      .eq("instrument_type", "EQ")
      .order("fmp_synced_at", { ascending: true, nullsFirst: true })
      .limit(CHUNK);
    if (error) return errorResponse(req, error.message, 500);
    if (!stocks || stocks.length === 0) {
      return jsonResponse(req, { ok: true, processed: 0, drained: true });
    }

    let synced = 0;
    let failed = 0;
    const work = [...stocks];

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (work.length > 0) {
        const s = work.shift();
        if (!s) break;
        const now = new Date().toISOString();
        try {
          const bundle = await fmpFundamentals(s.symbol, s.exchange);
          const { profile, ratios, income, balance, cashFlow, growth } = bundle;

          const update: Record<string, unknown> = { fmp_synced_at: now };
          const src: Record<string, string> = {};

          if (profile?.market_cap != null) { update.market_cap = profile.market_cap; src.market_cap = "fmp"; }
          if (profile?.enterprise_value != null) { update.enterprise_value = profile.enterprise_value; src.enterprise_value = "fmp"; }
          if (profile?.shares_outstanding != null) { update.shares_outstanding = profile.shares_outstanding; src.shares_outstanding = "fmp"; }
          if (profile?.beta != null) { update.beta = profile.beta; src.beta = "fmp"; }
          if (profile?.sector) { update.sector = profile.sector; src.sector = "fmp"; }
          if (profile?.industry) { update.industry = profile.industry; src.industry = "fmp"; }
          if (profile?.company_name) { update.company_name = profile.company_name; src.company_name = "fmp"; }

          if (ratios?.pe != null) { update.pe = ratios.pe; src.pe = "fmp"; }
          if (ratios?.pb != null) { update.pb = ratios.pb; src.pb = "fmp"; }
          if (ratios?.peg != null) { update.peg = ratios.peg; src.peg = "fmp"; }
          if (ratios?.roe != null) { update.roe = ratios.roe; src.roe = "fmp"; }
          if (ratios?.roce != null) { update.roce = ratios.roce; src.roce = "fmp"; }
          if (ratios?.roa != null) { update.roa = ratios.roa; src.roa = "fmp"; }
          if (ratios?.debt_equity != null) { update.debt_equity = ratios.debt_equity; src.debt_equity = "fmp"; }
          if (ratios?.current_ratio != null) { update.current_ratio = ratios.current_ratio; src.current_ratio = "fmp"; }
          if (ratios?.quick_ratio != null) { update.quick_ratio = ratios.quick_ratio; src.quick_ratio = "fmp"; }
          if (ratios?.interest_coverage != null) { update.interest_coverage = ratios.interest_coverage; src.interest_coverage = "fmp"; }
          if (ratios?.dividend_yield != null) { update.dividend_yield = ratios.dividend_yield; src.dividend_yield = "fmp"; }
          if (ratios?.ev_ebitda != null) { update.ev_ebitda = ratios.ev_ebitda; src.ev_ebitda = "fmp"; }

          if (income?.sales != null) { update.sales = income.sales; src.sales = "fmp"; }
          if (income?.net_profit != null) { update.net_profit = income.net_profit; src.net_profit = "fmp"; }
          if (income?.eps != null) { update.eps = income.eps; src.eps = "fmp"; }
          if (income?.operating_margin != null) { update.operating_margin = income.operating_margin; src.operating_margin = "fmp"; }
          if (income?.net_margin != null) { update.net_margin = income.net_margin; src.net_margin = "fmp"; }

          if (balance?.debt != null) { update.debt = balance.debt; src.debt = "fmp"; }
          if (balance?.book_value != null) { update.book_value = balance.book_value; src.book_value = "fmp"; }

          if (cashFlow?.cash_flow != null) { update.cash_flow = cashFlow.cash_flow; src.cash_flow = "fmp"; }
          if (cashFlow?.free_cash_flow != null) { update.free_cash_flow = cashFlow.free_cash_flow; src.free_cash_flow = "fmp"; }

          if (growth?.sales_growth != null) { update.sales_growth = growth.sales_growth; src.sales_growth = "fmp"; }
          if (growth?.profit_growth != null) { update.profit_growth = growth.profit_growth; src.profit_growth = "fmp"; }
          if (growth?.eps_growth != null) { update.eps_growth = growth.eps_growth; src.eps_growth = "fmp"; }

          if (Object.keys(src).length > 0) {
            // Merge data_source at the app layer: read-then-write to avoid
            // clobbering keys other syncs (yahoo/nse) already set on this row.
            const { data: existing } = await svc.from("market_data")
              .select("data_source").eq("symbol", s.symbol).eq("exchange", s.exchange).maybeSingle();
            update.data_source = { ...(existing?.data_source ?? {}), ...src };
          }

          const { error: updErr } = await svc.from("market_data")
            .update(update).eq("symbol", s.symbol).eq("exchange", s.exchange);
          if (updErr) throw updErr;
          synced++;
        } catch (err) {
          failed++;
          await svc.from("market_data")
            .update({ fmp_synced_at: now })
            .eq("symbol", s.symbol).eq("exchange", s.exchange);
          await svc.from("market_provider_health").insert({
            provider: "fmp", endpoint: "market-fmp-sync", ok: false,
            error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          }).then(() => {}, () => {});
        }
      }
    });
    await Promise.all(workers);

    return jsonResponse(req, { ok: true, processed: stocks.length, synced, failed });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
