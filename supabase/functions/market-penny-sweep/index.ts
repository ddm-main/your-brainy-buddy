// market-penny-sweep — monthly penny-stock purge for the tradable universe.
//
// A stock is a penny stock when EITHER holds:
//   * market cap < ₹1,000 Cr  (market_stocks.market_cap is stored in ₹ crores)
//   * last settled close < ₹50
// The last close is looked up by SYMBOL only (latest non-null close in the past
// 10 sessions), so an exchange mismatch can never make a ₹12 stock look
// priceless and therefore clean.
//
// Penny names get penny_excluded=true and drop out of in_universe; the flag is
// what keeps them out, because market-scrips-sync / nse-master-sync /
// bse-bhavcopy-sync / index-constituents all force in_universe=true on their
// own schedules. A BEFORE trigger on market_stocks (enforce_penny_exclusion)
// re-asserts in_universe=false for any flagged row those jobs touch, and
// block_penny_rows drops derived writes for flagged symbols on 18 tables.
//
// Reinstatement requires POSITIVE proof: cap known and >= ₹1,000 Cr AND close
// known and >= ₹50. An unproven name (missing cap or missing price) stays out
// of the universe instead of being let back in — that leak is what previously
// collapsed a correct 1,200-symbol exclusion down to 235.
//
// All of the above runs inside public.market_penny_sweep(), which also purges
// every derived row for symbols newly flagged in the run and refreshes the
// screener snapshot. Keeping it in one SQL statement means no universe egress
// and no partial state if the invocation is cut short.
import { preflight, jsonResponse, errorResponse, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";

const MIN_MARKET_CAP_CR = 1000;
const MIN_PRICE = 50;

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const gate = await requireCronSecret(req); if (gate) return gate;

  try {
    const svc = svcClient();
    const { data, error } = await svc.rpc("market_penny_sweep", {
      _min_cap_cr: MIN_MARKET_CAP_CR,
      _min_price: MIN_PRICE,
    });
    if (error) return errorResponse(req, error.message, 500);

    const result = (data ?? {}) as Record<string, unknown>;
    if (result.ok === false) {
      return errorResponse(req, String(result.error ?? "penny sweep failed"), 503);
    }
    if (result.snapshot_error) {
      // A stale snapshot means the screener still serves the pre-sweep
      // universe — surface it as an error, not a footnote.
      return errorResponse(req, `snapshot refresh failed: ${result.snapshot_error}`, 500);
    }

    return jsonResponse(req, {
      ...result,
      thresholds: { min_market_cap_cr: MIN_MARKET_CAP_CR, min_price: MIN_PRICE },
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
