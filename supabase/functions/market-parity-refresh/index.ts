// market-parity-refresh — manual or cron-safe parity refresh for selected
// symbols/current screener rows. Writes provider observations, consensus rows,
// and audit deltas against Tickertape where the public endpoint is available.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { fetchTickertapeMetrics, persistTickertapeParity } from "../_shared/market/parity.ts";

const MAX_SYMBOLS = 200;
const DEFAULT_LIMIT = 50;

function cleanSymbols(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") continue;
    const s = v.trim().toUpperCase().replace(/[^A-Z0-9&-]/g, "");
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_SYMBOLS) break;
  }
  return out;
}

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
    const body = await req.json().catch(() => ({}));
    const symbols = cleanSymbols(body?.symbols);
    const limit = Math.max(1, Math.min(Number(body?.limit) || DEFAULT_LIMIT, MAX_SYMBOLS));
    const mode = symbols.length > 0 ? "symbols" : "sample";

    const { data: run, error: runErr } = await svc.from("market_reference_audit_runs").insert({
      source: "tickertape", mode, status: "running", symbols_requested: symbols.length || limit,
      metadata: { requested_symbols: symbols },
    }).select("id").single();
    if (runErr) return errorResponse(req, runErr.message, 500);

    let q = svc.from("market_screener_rows")
      .select("symbol, exchange, company_name, market_cap, close, pe_ttm, pb, eps_ttm, book_value, dividend_yield, roe, roce, debt_to_equity, high_52w, low_52w, volume, data_provenance")
      .eq("exchange", "NSE")
      .limit(limit);
    if (symbols.length > 0) q = q.in("symbol", symbols);
    else q = q.order("market_cap", { ascending: false, nullsFirst: false });

    const { data: rows, error } = await q;
    if (error) return errorResponse(req, error.message, 500);

    let checked = 0, missing = 0, mismatches = 0, auditRows = 0, consensusRows = 0;
    const failed: string[] = [];
    for (const row of rows ?? []) {
      const tt = await fetchTickertapeMetrics(row as any, svc);
      if (!tt) { missing++; failed.push(row.symbol); continue; }
      checked++;
      const saved = await persistTickertapeParity(svc, row as any, tt, run?.id ?? null);
      mismatches += saved.mismatches;
      auditRows += saved.auditRows;
      consensusRows += saved.consensusRows;
      await new Promise((r) => setTimeout(r, 120));
    }

    await svc.from("market_reference_audit_runs").update({
      status: missing > checked ? "partial" : "ok",
      symbols_checked: checked,
      mismatches,
      finished_at: new Date().toISOString(),
      metadata: { requested_symbols: symbols, missing_symbols: failed.slice(0, 100), audit_rows: auditRows, consensus_rows: consensusRows },
    }).eq("id", run?.id);

    return jsonResponse(req, {
      ok: true, run_id: run?.id, requested: symbols.length || limit, checked, missing,
      mismatches, audit_rows: auditRows, consensus_rows: consensusRows,
      missing_symbols: failed.slice(0, 30),
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});