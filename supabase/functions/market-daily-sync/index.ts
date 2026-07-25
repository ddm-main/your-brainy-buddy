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
  | "market-fundamentals-global-sync"
  | "market-shares-outstanding-sync"
  | "market-pipeline-eod"
  | "market-pipeline-aggregates"
  | "market-parity-refresh";

const CHAIN: Array<{ fn: StepFn; label: string; chunked: boolean }> = [
  // Step 0a/0b: refresh the tradable universe BEFORE fundamentals/EOD run so
  // newly-listed and SME symbols land in market_stocks and any downstream
  // scan picks them up the same day.
  { fn: "market-nse-bhavcopy-sync",        label: "NSE bhavcopy",       chunked: false },
  { fn: "market-nse-master-sync",          label: "NSE master",         chunked: false },
  { fn: "market-fundamentals-global-sync", label: "Fundamentals",       chunked: true  },
  { fn: "market-shares-outstanding-sync",  label: "Shares outstanding", chunked: true  },
  { fn: "market-pipeline-eod",             label: "EOD technicals",     chunked: true  },
  { fn: "market-pipeline-aggregates",      label: "Breadth aggregates", chunked: false },
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
  const cronSecret =
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

    const failedSteps = summary.filter((s) => s.status === "failed");
    await svc.from("market_ingestion_runs").insert({
      source: "daily_sync_orchestrator",
      stage: "summary",
      status: failedSteps.length === 0 ? "ok" : "partial",
      rows_ingested: 0,
      duration_ms: Date.now() - startedAt,
      metadata: {
        steps: summary.map((s) => ({ fn: s.fn, status: s.status, duration_ms: s.duration_ms, iterations: s.iterations, error: s.error ?? null })),
        failed_count: failedSteps.length,
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