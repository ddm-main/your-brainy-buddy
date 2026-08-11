// Data validation engine — nightly, after the sync jobs settle.
//
// Rewritten: the previous version read `market_data`, a table that no longer
// exists, so every run failed before it checked anything. It also *mutated*
// rows (nulling market caps, overwriting PE) from a job nobody was reading —
// silent writes from a validator are how bad data becomes permanent. This
// version is strictly read-only and reports against the tables the pipeline
// actually writes today:
//
//   market_stocks              — reference universe
//   market_fundamentals_global — fundamentals plane
//   market_daily_prices        — settled bars
//   market_stock_scores        — derived scores
//   market_live_prices / _runs — atomic live plane
//
// Anything it finds is returned as an error (breaks an invariant) or a warning
// (suspicious, needs eyes). Fixes belong in the sync job that produced the row.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { installServerEgressMeter, setEgressCaller } from "../_shared/market/serverEgress.ts";
installServerEgressMeter();
setEgressCaller("market-data-validation");


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PAGE = 1000;

/** Supabase caps a single select at 1000 rows; page through it explicitly so a
 *  "clean" report can never just mean "we only looked at the first 1000". */
async function selectAll<T = any>(
  supabase: any,
  table: string,
  columns: string,
  build: (q: any) => any = (q) => q,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(supabase.from(table).select(columns)).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < PAGE) return out;
    if (out.length > 60_000) return out; // safety valve
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const started = Date.now();
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const errors: string[] = [];
    const warnings: string[] = [];
    const checks: Record<string, unknown> = {};
    let validated = 0;

    // ---- 1. Reference universe -------------------------------------------
    const stocks = await selectAll<any>(
      supabase, "market_stocks", "symbol,exchange,market_cap,roe,is_active,series,instrument_type,in_universe",
      (q) => q.eq("is_active", true),
    );
    validated += stocks.length;
    checks.active_symbols = stocks.length;

    const seen = new Set<string>();
    let dupes = 0;
    let nullCapInUniverse = 0;
    let indexInUniverse = 0;
    for (const s of stocks) {
      const key = `${s.exchange}:${s.symbol}`;
      if (seen.has(key)) { dupes++; errors.push(`duplicate active row: ${key}`); }
      seen.add(key);
      if (s.in_universe === true) {
        // The universe gate requires a known market cap and excludes index
        // rows — either state means the monthly sweep left drift behind.
        if (s.market_cap == null) {
          nullCapInUniverse++;
          errors.push(`${s.symbol}: in universe with no market_cap`);
        }
        if (String(s.instrument_type ?? "EQ") === "INDEX") {
          indexInUniverse++;
          errors.push(`${s.symbol}: index row marked in_universe`);
        }
      }
      if (s.market_cap != null && Number(s.market_cap) <= 0) {
        warnings.push(`${s.symbol}: non-positive market_cap (${s.market_cap})`);
      }
      if (s.roe != null && Math.abs(Number(s.roe)) > 300) {
        warnings.push(`${s.symbol}: implausible ROE (${s.roe}%)`);
      }
    }
    checks.duplicate_symbols = dupes;
    checks.universe_null_market_cap = nullCapInUniverse;
    checks.universe_index_rows = indexInUniverse;

    // ---- 2. Fundamentals plane -------------------------------------------
    const funds = await selectAll<any>(
      supabase, "market_fundamentals_global",
      "symbol,exchange,price,pe_ttm,eps_ttm,debt_to_equity,market_cap_cr,high_52w,low_52w,data_as_of",
    );
    validated += funds.length;
    checks.fundamentals_rows = funds.length;

    let peMismatch = 0;
    for (const f of funds) {
      const price = f.price == null ? null : Number(f.price);
      const eps = f.eps_ttm == null ? null : Number(f.eps_ttm);
      const pe = f.pe_ttm == null ? null : Number(f.pe_ttm);
      if (price != null && eps != null && eps > 0 && pe != null && pe > 0) {
        const expected = price / eps;
        if (Math.abs((pe - expected) / expected) > 0.1) {
          peMismatch++;
          warnings.push(`${f.symbol}: PE ${pe.toFixed(2)} vs price/EPS ${expected.toFixed(2)}`);
        }
      }
      if (f.debt_to_equity != null && Number(f.debt_to_equity) < 0) {
        warnings.push(`${f.symbol}: negative debt/equity (${f.debt_to_equity})`);
      }
      if (f.high_52w != null && f.low_52w != null && Number(f.high_52w) < Number(f.low_52w)) {
        errors.push(`${f.symbol}: 52w high (${f.high_52w}) < 52w low (${f.low_52w})`);
      }
      if (price != null && f.high_52w != null && Number(price) > Number(f.high_52w) * 1.02) {
        warnings.push(`${f.symbol}: price ${price} above 52w high ${f.high_52w}`);
      }
    }
    checks.pe_mismatches = peMismatch;

    // ---- 2b. Reference cap vs fundamentals cap ---------------------------
    // market_stocks.market_cap is derived (yahoo shares x close). When a split
    // or bonus lands, the shares count and the close drift apart and the cap
    // inflates — CUPID showed ~35,000 Cr against a real ~1,100 Cr, which then
    // silently passed a "market cap > 1000 Cr" screener filter. The
    // fundamentals plane carries an independently sourced cap, so a wide gap
    // between the two is the honest signal that one of them is stale.
    const fundCapByKey = new Map<string, number>();
    for (const f of funds) {
      if (f.market_cap_cr == null) continue;
      const v = Number(f.market_cap_cr);
      if (Number.isFinite(v) && v > 0) fundCapByKey.set(`${f.exchange}:${f.symbol}`, v);
    }
    let capDivergence = 0;
    for (const s of stocks) {
      const ref = s.market_cap == null ? null : Number(s.market_cap);
      const alt = fundCapByKey.get(`${s.exchange}:${s.symbol}`);
      if (ref == null || !Number.isFinite(ref) || ref <= 0 || alt == null) continue;
      const ratio = ref / alt;
      if (ratio > 1.5 || ratio < 1 / 1.5) {
        capDivergence++;
        warnings.push(
          `${s.symbol}: market_cap ${Math.round(ref)} Cr vs fundamentals ${Math.round(alt)} Cr ` +
          `(${ratio.toFixed(2)}x) — likely stale shares outstanding or unadjusted split`,
        );
      }
    }
    checks.market_cap_divergences = capDivergence;

    // ---- 3. Settled bars --------------------------------------------------
    const { data: latestPriceRow } = await supabase
      .from("market_daily_prices").select("trade_date")
      .order("trade_date", { ascending: false }).limit(1).maybeSingle();
    const latestDate = latestPriceRow?.trade_date as string | undefined;
    checks.latest_price_session = latestDate ?? null;

    if (!latestDate) {
      errors.push("market_daily_prices is empty — the EOD pipeline has never landed a bar");
    } else {
      const priceRows = await selectAll<any>(
        supabase, "market_daily_prices", "symbol,exchange,open,high,low,close,volume",
        (q) => q.eq("trade_date", latestDate),
      );
      validated += priceRows.length;
      checks.latest_session_rows = priceRows.length;
      // Coverage: a session that priced a fraction of the universe is a failed
      // ingest even when every row it *did* write is internally consistent.
      const coverage = stocks.length > 0 ? (priceRows.length / stocks.length) * 100 : null;
      checks.latest_session_coverage_pct = coverage == null ? null : Number(coverage.toFixed(2));
      if (coverage != null && coverage < 90) {
        errors.push(`settled session ${latestDate} covers only ${coverage.toFixed(1)}% of the active universe`);
      }
      for (const r of priceRows) {
        const { symbol, open, high, low, close } = r;
        if (close != null && Number(close) <= 0) { errors.push(`${symbol}: non-positive close (${close}) on ${latestDate}`); continue; }
        if (high != null && low != null && Number(high) < Number(low)) { errors.push(`${symbol}: high (${high}) < low (${low}) on ${latestDate}`); continue; }
        if (low != null && high != null) {
          if (close != null && (Number(close) < Number(low) || Number(close) > Number(high))) {
            errors.push(`${symbol}: close (${close}) outside [${low}, ${high}] on ${latestDate}`);
          }
          if (open != null && (Number(open) < Number(low) || Number(open) > Number(high))) {
            errors.push(`${symbol}: open (${open}) outside [${low}, ${high}] on ${latestDate}`);
          }
        }
        if (r.volume != null && Number(r.volume) < 0) errors.push(`${symbol}: negative volume on ${latestDate}`);
      }
    }

    // ---- 4. Scores --------------------------------------------------------
    const { data: latestScoreRow } = await supabase
      .from("market_stock_scores").select("trade_date")
      .order("trade_date", { ascending: false }).limit(1).maybeSingle();
    const scoreDate = latestScoreRow?.trade_date as string | undefined;
    checks.latest_score_session = scoreDate ?? null;
    if (scoreDate) {
      if (latestDate && scoreDate < latestDate) {
        warnings.push(`scores lag prices: scores ${scoreDate} vs prices ${latestDate}`);
      }
      const scoreRows = await selectAll<any>(
        supabase, "market_stock_scores", "symbol,close", (q) => q.eq("trade_date", scoreDate),
      );
      validated += scoreRows.length;
      checks.latest_score_rows = scoreRows.length;
      for (const r of scoreRows) {
        if (r.close != null && Number(r.close) <= 0) {
          errors.push(`${r.symbol}: non-positive close (${r.close}) in scores on ${scoreDate}`);
        }
      }
    } else {
      warnings.push("market_stock_scores is empty");
    }

    // ---- 5. Live plane ----------------------------------------------------
    // The screener reads the live plane directly, so its integrity is now a
    // first-class check: a promoted sweep must be recent, near-complete, and
    // must not disagree wildly with the settled anchor it was priced against.
    const { data: run } = await supabase
      .from("market_live_price_runs")
      .select("sweep_id,session_date,as_of,status,expected_count,priced_count,failed_count")
      .eq("status", "complete").order("as_of", { ascending: false }).limit(1).maybeSingle();

    if (!run) {
      warnings.push("no completed live sweep on record");
      checks.live_plane = null;
    } else {
      const expected = Number(run.expected_count ?? 0);
      const priced = Number(run.priced_count ?? 0);
      const cov = expected > 0 ? (priced / expected) * 100 : null;
      const ageMin = run.as_of ? Math.round((Date.now() - Date.parse(run.as_of)) / 60_000) : null;
      checks.live_plane = {
        sweep_id: run.sweep_id, session_date: run.session_date,
        priced, expected, coverage_pct: cov == null ? null : Number(cov.toFixed(2)),
        failed: Number(run.failed_count ?? 0), age_minutes: ageMin,
      };
      if (cov != null && cov < 95) errors.push(`live sweep coverage ${cov.toFixed(1)}% (${priced}/${expected})`);

      const liveRows = await selectAll<any>(
        supabase, "market_live_prices", "symbol,ltp,prev_close,change_pct",
        (q) => q.eq("sweep_id", run.sweep_id),
      );
      validated += liveRows.length;
      let published = 0, wild = 0;
      for (const r of liveRows) {
        published++;
        if (r.ltp != null && Number(r.ltp) <= 0) errors.push(`${r.symbol}: non-positive live ltp (${r.ltp})`);
        if (r.change_pct != null && Math.abs(Number(r.change_pct)) > 25) {
          wild++;
          warnings.push(`${r.symbol}: live change ${Number(r.change_pct).toFixed(1)}% — verify against the settled anchor`);
        }
        if (r.ltp != null && r.prev_close != null && Number(r.prev_close) > 0) {
          const derived = (Number(r.ltp) - Number(r.prev_close)) / Number(r.prev_close) * 100;
          if (r.change_pct != null && Math.abs(derived - Number(r.change_pct)) > 0.5) {
            errors.push(`${r.symbol}: change_pct ${r.change_pct} disagrees with ltp/prev_close (${derived.toFixed(2)})`);
          }
        }
      }
      (checks.live_plane as any).published_rows = published;
      (checks.live_plane as any).outlier_moves = wild;
      if (published !== priced) {
        warnings.push(`live sweep says ${priced} priced but ${published} rows are published`);
      }

      // ---- 5b. Settled anchor parity ------------------------------------
      // A wrong prev_close silently poisons every 1D-return filter, so the
      // anchor is compared against the last settled bhavcopy close.
      const { data: prevSession } = await supabase
        .from("market_eod_nse").select("trade_date")
        .lt("trade_date", run.session_date)
        .order("trade_date", { ascending: false }).limit(1).maybeSingle();
      const prevDate = prevSession?.trade_date as string | undefined;
      (checks.live_plane as any).anchor_session = prevDate ?? null;
      if (prevDate) {
        const eod = await selectAll<any>(
          supabase, "market_eod_nse", "symbol,close", (q) => q.eq("trade_date", prevDate),
        );
        const closeBy = new Map(eod.map((r: any) => [r.symbol, Number(r.close)]));
        let anchorDrift = 0;
        for (const r of liveRows) {
          const settled = closeBy.get(r.symbol);
          if (settled == null || !(settled > 0) || r.prev_close == null) continue;
          if (Math.abs(Number(r.prev_close) - settled) / settled > 0.005) {
            anchorDrift++;
            if (anchorDrift <= 25) {
              warnings.push(`${r.symbol}: prev_close ${r.prev_close} vs settled ${prevDate} close ${settled}`);
            }
          }
        }
        (checks.live_plane as any).anchor_drift = anchorDrift;
      }

      // ---- 5c. Symbols the sweep failed to price -------------------------
      const { data: staged } = await supabase
        .from("market_live_price_stage").select("symbol,error")
        .eq("sweep_id", run.sweep_id).not("error", "is", null).limit(50);
      const failedSymbols = (staged ?? []).map((s: any) => s.symbol);
      (checks.live_plane as any).failed_symbols = failedSymbols;
      if (failedSymbols.length > 0) {
        warnings.push(`sweep could not price: ${failedSymbols.join(", ")}`);
      }
    }

    // ---- 6. Market-cap parity --------------------------------------------
    // The screener revalues the *reported* cap at the live price. If the
    // internally-derived cap disagrees by a wide margin, the fundamentals
    // plane (shares outstanding) is stale for that symbol.
    {
      const capRows = await selectAll<any>(
        supabase, "market_screener_rows",
        "symbol,market_cap,market_cap_reported,mcap_basis",
        (q) => q.eq("is_active", true).eq("exchange", "NSE").eq("instrument_type", "EQ"),
      );
      let drifted = 0, unreported = 0;
      for (const r of capRows) {
        if (r.mcap_basis === "derived" || r.mcap_basis === "none") { unreported++; continue; }
        const rep = r.market_cap_reported == null ? null : Number(r.market_cap_reported);
        const cap = r.market_cap == null ? null : Number(r.market_cap);
        if (rep == null || cap == null || !(rep > 0)) continue;
        // Revaluation at the live price is expected to move the cap, but a
        // >50% gap means the reported cap and the price basis disagree.
        if (Math.abs(cap - rep) / rep > 0.5) {
          drifted++;
          if (drifted <= 25) warnings.push(`${r.symbol}: market cap ${cap.toFixed(0)} vs reported ${rep.toFixed(0)} Cr`);
        }
      }
      checks.market_cap = { rows: capRows.length, drifted, no_reported_cap: unreported };
    }

    const summary = {
      ok: errors.length === 0,
      validated,
      errors: errors.length,
      warnings: warnings.length,
      duration_ms: Date.now() - started,
      checks,
      details: { errors: errors.slice(0, 50), warnings: warnings.slice(0, 50) },
    };

    console.log("validation summary:", JSON.stringify({ ...summary, details: undefined }));

    // 200 even when invariants break: this is a report, and a non-2xx makes the
    // cron scheduler retry a job whose whole output is the body.
    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    console.error("validation failed:", error);
    return new Response(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});
