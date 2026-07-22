// market-value-audit — compares the active screener rows against Tickertape's
// public stock reference and writes both audit rows and metric consensus rows.
import { preflight, jsonResponse, errorResponse, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { fetchTickertapeMetrics, persistTickertapeParity } from "../_shared/market/parity.ts";

const SAMPLE = 100;

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const gate = await requireCronSecret(req); if (gate) return gate;
  try {
    const svc = svcClient();
    const { data: run, error: runErr } = await svc.from("market_reference_audit_runs").insert({
      source: "tickertape", mode: "sample", status: "running", symbols_requested: SAMPLE,
    }).select("id").single();
    if (runErr) return errorResponse(req, runErr.message, 500);

    const { data: rows, error } = await svc.from("market_screener_rows")
      .select("symbol, exchange, company_name, market_cap, close, pe_ttm, pb, eps_ttm, book_value, dividend_yield, roe, roce, debt_to_equity, high_52w, low_52w, volume, data_provenance")
      .eq("exchange", "NSE")
      .not("market_cap", "is", null)
      .order("fundamentals_updated_at", { ascending: false, nullsFirst: false })
      .limit(SAMPLE);
    if (error) return errorResponse(req, error.message, 500);

    let checked = 0, missing = 0, mismatches = 0, rowsWritten = 0, consensusRows = 0;

    for (const s of rows ?? []) {
      const tt = await fetchTickertapeMetrics(s as any, svc);
      if (!tt) { missing++; continue; }
      checked++;
      const persisted = await persistTickertapeParity(svc, s as any, tt, run?.id ?? null);
      mismatches += persisted.mismatches;
      rowsWritten += persisted.auditRows;
      consensusRows += persisted.consensusRows;
      // Gentle throttle — Tickertape's public API is unauthenticated but we
      // don't want to be rude and get IP-banned.
      await new Promise((r) => setTimeout(r, 120));
    }

    await svc.from("market_reference_audit_runs").update({
      status: missing > checked ? "partial" : "ok",
      symbols_checked: checked,
      mismatches,
      finished_at: new Date().toISOString(),
      metadata: { missing, rows_written: rowsWritten, consensus_rows: consensusRows },
    }).eq("id", run?.id);

    return jsonResponse(req, {
      ok: true, run_id: run?.id, sampled: rows?.length ?? 0, checked, missing,
      mismatches, rows_written: rowsWritten, consensus_rows: consensusRows,
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
