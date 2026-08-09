// market-daily-sync — one-shot orchestrator run once per day at 09:00 IST.
// Runs the same 5-step chain the Screener's "Sync all" button uses, in order,
// draining the chunked ones until they report `drained: true`. Every step's
// outcome is written to market_ingestion_runs plus one summary row so we can
// see from the DB whether the daily sync landed cleanly.
import { preflight, jsonResponse, errorResponse, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type StepFn =
  | "market-nse-bhavcopy-sync"
  | "market-nse-master-sync"
  | "promote-market-eod-session"
  | "market-fundamentals-global-sync"
  | "market-shares-outstanding-sync"
  | "market-pipeline-eod"
  | "market-rescore-from-prices"
  | "market-pipeline-aggregates"
  | "market-parity-refresh";

const CHAIN: Array<{ fn: StepFn; label: string; chunked: boolean }> = [
  // Step 0a/0b: refresh the tradable universe BEFORE fundamentals/EOD run so
  // newly-listed and SME symbols land in market_stocks and any downstream
  // scan picks them up the same day.
  { fn: "market-nse-bhavcopy-sync",        label: "NSE bhavcopy",       chunked: false },
  { fn: "market-nse-master-sync",          label: "NSE master",         chunked: false },
  { fn: "promote-market-eod-session",      label: "Promote EOD prices", chunked: false },
  { fn: "market-rescore-from-prices",      label: "Price-table rescore", chunked: false },
  { fn: "market-pipeline-eod",             label: "EOD technicals",     chunked: true  },
  { fn: "market-pipeline-aggregates",      label: "Breadth aggregates", chunked: false },
  { fn: "market-fundamentals-global-sync", label: "Fundamentals",       chunked: true  },
  { fn: "market-shares-outstanding-sync",  label: "Shares outstanding", chunked: true  },
  { fn: "market-parity-refresh",           label: "Tickertape parity",  chunked: false },
];


const MAX_DRAIN_ITERATIONS = 40;

// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  // Two accepted callers:
  //  1) pg_cron via the vault-held x-cron-secret header (09:00 IST job)
  //  2) A signed-in user hitting "Sync all" (Screener) or the client
  //     auto-sync in useAutoSync.ts — throttled to once per day per client.
  // Anonymous callers are rejected.
  const hasCronHeader = req.headers.get("x-cron-secret") != null;
  if (hasCronHeader) {
    const gate = await requireCronSecret(req); if (gate) return gate;
  } else {
    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
    const token = auth.slice(7);
    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } } },
    );
    const { data, error } = await supa.auth.getClaims(token);
    if (error || !data?.claims?.sub) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
  }

  const svc = svcClient();
  // Forwarded to every chained step. Prefer the verified inbound cron header
  // (pg_cron's Vault value) so the chain works without an env-var copy of it.
  const cronSecret =
    req.headers.get("x-cron-secret") ??
    Deno.env.get("CRON_SECRET") ??
    Deno.env.get("SYNC_HOOK_SECRET") ??
    Deno.env.get("MARKET_CRON_SECRET") ??
    "";
  const baseUrl = Deno.env.get("SUPABASE_URL")!;

  const startedAt = Date.now();
  const summary: Array<{
    fn: StepFn; label: string; status: "ok" | "failed";
    iterations: number; last_response: unknown; error?: string; duration_ms: number;
  }> = [];

  // The Screener reads a precomputed snapshot table, not the multi-join view.
  // If this never runs, the screener sits a whole session behind the scores —
  // so it is invoked from a `finally`, not inline in the happy path.
  let snapshotDone = false;
  const refreshScreenerSnapshot = async () => {
    if (snapshotDone) return;
    snapshotDone = true;
    const snapStart = Date.now();
    const { data: rows, error: snapErr } = await svc.rpc("refresh_market_screener_snapshot");
    summary.push({
      fn: "market-screener-snapshot" as StepFn,
      label: "Screener snapshot",
      status: snapErr ? "failed" : "ok",
      iterations: 1,
      last_response: { rows: rows ?? null },
      error: snapErr?.message,
      duration_ms: Date.now() - snapStart,
    });
    await svc.from("market_ingestion_runs").insert({
      source: "daily_sync_orchestrator",
      stage: "market-screener-snapshot",
      status: snapErr ? "failed" : "ok",
      rows_ingested: typeof rows === "number" ? rows : 0,
      duration_ms: Date.now() - snapStart,
      metadata: { error: snapErr?.message ?? null },
      finished_at: new Date().toISOString(),
    });
  };

  const runChain = async () => {
   try {

    for (const step of CHAIN) {
      const stepStart = Date.now();
      let iterations = 0;
      let lastBody: unknown = null;
      let error: string | undefined;

      // 1 retry per step on transient failure (30s backoff).
      for (let attempt = 0; attempt < 2; attempt++) {
        iterations = 0;
        lastBody = null;
        error = undefined;
        try {
          if (step.fn === "promote-market-eod-session") {
            iterations++;
            const { data, error: rpcErr } = await svc.rpc("promote_market_eod_session", {
              _trade_date: null,
            });
            if (rpcErr) throw new Error(rpcErr.message);
            lastBody = Array.isArray(data) ? data[0] : data;
          } else if (step.fn === "market-rescore-from-prices") {
            // Keyset-batched: one 3000-symbol call exceeded the statement
            // timeout and aborted the whole recovery pass.
            let cursor: string | null = null;
            let total = 0;
            for (let b = 0; b < 12; b++) {
              iterations++;
              const { data, error: rpcErr } = await svc.rpc("market_rescore_prices_batch", {
                _trade_date: null,
                _limit: 400,
                _after_symbol: cursor,
              });
              if (rpcErr) throw new Error(rpcErr.message);
              const row = Array.isArray(data) ? data[0] : data;
              const processed = Number(row?.processed ?? 0);
              total += processed;
              cursor = (row?.last_symbol as string | null) ?? null;
              if (processed === 0 || !cursor) break;
            }
            lastBody = { rows: total };

          } else {
            for (let i = 0; i < (step.chunked ? MAX_DRAIN_ITERATIONS : 1); i++) {
              iterations++;
              const res = await fetch(`${baseUrl}/functions/v1/${step.fn}`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-cron-secret": cronSecret,
                },
                body: "{}",
              });
              const text = await res.text();
              let body: unknown = text;
              try { body = JSON.parse(text); } catch { /* keep raw text */ }
              lastBody = body;
              if (!res.ok) throw new Error(`${step.fn} → HTTP ${res.status}: ${text.slice(0, 300)}`);
              if (!step.chunked) break;
              if ((body as { drained?: boolean } | null)?.drained) break;
            }
          }
          break; // step succeeded
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
          if (attempt === 0) await new Promise((r) => setTimeout(r, 30_000));
        }
      }

      const status: "ok" | "failed" = error ? "failed" : "ok";
      const duration = Date.now() - stepStart;
      summary.push({ fn: step.fn, label: step.label, status, iterations, last_response: lastBody, error, duration_ms: duration });

      await svc.from("market_ingestion_runs").insert({
        source: "daily_sync_orchestrator",
        stage: step.fn,
        status,
        rows_ingested: 0,
        duration_ms: duration,
        metadata: { iterations, last_response: lastBody, error: error ?? null },
        finished_at: new Date().toISOString(),
      });

      // Continue the chain even on failure — later steps (technicals, aggregates)
      // must still run so the app has fresh scores; the failure is recorded above.
    }

    // Rebuild the screener snapshot before the freshness assertion. It also
    // runs from the `finally` below, so an earlier throw can never leave the
    // screener a session behind the scores.
    await refreshScreenerSnapshot();




    // ---- Freshness assertion ----
    // Every step can report "ok" while the thing users actually read — the
    // score table — is still on an older session. Compare it to the price
    // table and fail the run loudly when it lags.
    const [{ data: fp }, { data: fs }, { data: fe }] = await Promise.all([
      svc.from("market_daily_prices").select("trade_date").eq("exchange", "NSE")
        .order("trade_date", { ascending: false }).limit(1).maybeSingle(),
      svc.from("market_stock_scores").select("trade_date").eq("exchange", "NSE")
        .order("trade_date", { ascending: false }).limit(1).maybeSingle(),
      svc.from("market_eod_nse").select("trade_date").eq("exchange", "NSE")
        .order("trade_date", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const priceDate = (fp?.trade_date as string | null) ?? null;
    const scoreDate = (fs?.trade_date as string | null) ?? null;
    const sourceDate = (fe?.trade_date as string | null) ?? null;
    let sourceRows = 0;
    let priceRows = 0;
    let scoreRows = 0;
    let staleScores = 0;
    let missingSamples: string[] = [];
    if (sourceDate) {
      const [{ count: sourceCount }, { count: priceCount }, { count: scoreCount }, { count: staleCount }] = await Promise.all([
        svc.from("market_eod_nse").select("symbol", { count: "exact", head: true }).eq("exchange", "NSE").eq("trade_date", sourceDate),
        svc.from("market_daily_prices").select("symbol", { count: "exact", head: true }).eq("exchange", "NSE").eq("trade_date", sourceDate),
        svc.from("market_stock_scores").select("symbol", { count: "exact", head: true }).eq("exchange", "NSE").eq("trade_date", sourceDate),
        svc.from("market_stock_scores").select("symbol", { count: "exact", head: true }).eq("exchange", "NSE").lt("trade_date", sourceDate),
      ]);
      sourceRows = sourceCount ?? 0;
      priceRows = priceCount ?? 0;
      scoreRows = scoreCount ?? 0;
      staleScores = staleCount ?? 0;
      const { data: sourceSymbols } = await svc.from("market_eod_nse").select("symbol")
        .eq("exchange", "NSE").eq("trade_date", sourceDate).limit(200);
      const sampleSymbols = (sourceSymbols ?? []).map((row) => String(row.symbol));
      if (sampleSymbols.length > 0) {
        const { data: scoredSymbols } = await svc.from("market_stock_scores").select("symbol")
          .eq("exchange", "NSE").eq("trade_date", sourceDate).in("symbol", sampleSymbols);
        const scored = new Set((scoredSymbols ?? []).map((row) => String(row.symbol)));
        missingSamples = sampleSymbols.filter((symbol) => !scored.has(symbol)).slice(0, 10);
      }
    }
    const priceCoverage = sourceRows > 0 ? priceRows / sourceRows : 0;
    const scoreCoverage = priceRows > 0 ? scoreRows / priceRows : 0;
    const freshnessOk = !!sourceDate
      && priceDate === sourceDate
      && scoreDate === sourceDate
      && priceCoverage >= 0.8
      && scoreCoverage >= 0.8;

    const failedSteps = summary.filter((s) => s.status === "failed");
    await svc.from("market_ingestion_runs").insert({
      source: "daily_sync_orchestrator",
      stage: "summary",
      status: failedSteps.length === 0 && freshnessOk ? "ok" : "partial",
      rows_ingested: 0,
      duration_ms: Date.now() - startedAt,
      metadata: {
        steps: summary.map((s) => ({ fn: s.fn, status: s.status, duration_ms: s.duration_ms, iterations: s.iterations, error: s.error ?? null })),
        failed_count: failedSteps.length,
        freshness: {
          source_date: sourceDate,
          price_date: priceDate,
          score_date: scoreDate,
          source_rows: sourceRows,
          price_rows: priceRows,
          score_rows: scoreRows,
          price_coverage_pct: Math.round(priceCoverage * 1000) / 10,
          score_coverage_pct: Math.round(scoreCoverage * 1000) / 10,
          stale_scores: staleScores,
          missing_symbol_samples: missingSamples,
          ok: freshnessOk,
        },
      },
      finished_at: new Date().toISOString(),
    });


   } catch (e) {
     await svc.from("market_ingestion_runs").insert({
       source: "daily_sync_orchestrator", stage: "summary", status: "failed",
       rows_ingested: 0, duration_ms: Date.now() - startedAt,
       metadata: { error: e instanceof Error ? e.message : String(e), steps: summary },
       finished_at: new Date().toISOString(),
     });
   } finally {
     // The screener snapshot must never be skipped because an earlier step
     // blew up — that is exactly how the UI ended up a session behind.
     try { await refreshScreenerSnapshot(); } catch { /* recorded above */ }
   }

  };

  // Run the chain in the background — the orchestrator's total wall time
  // (fundamentals + EOD drains) exceeds the per-request CPU/wall budget and
  // triggers WORKER_RESOURCE_LIMIT. Return immediately and let waitUntil keep
  // the worker alive for the chain. Progress is visible in market_ingestion_runs.
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(runChain());
  } else {
    // Local dev fallback — don't await, but catch to avoid unhandled rejections.
    runChain().catch((e) => console.error("[daily-sync] background error", e));
  }
  return jsonResponse(req, { ok: true, started: true, mode: "background" });
});