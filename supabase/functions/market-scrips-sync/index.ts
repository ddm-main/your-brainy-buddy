// market-scrips-sync — populate market_stocks from the Kotak scrip master
// (nse_cm + bse_cm CSVs, ~20 MB each, stream-parsed) and flag the pipeline
// universe (NIFTY 500 ∪ user holdings/watchlist/positions symbols).
// Invoked by weekly cron or manually (cron secret or authenticated user).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { KOTAK_SETTINGS_COLS, type KotakSettings, kotakScripFilePaths } from "../_shared/market/kotakClient.ts";
import { fetchNifty500, FALLBACK_UNIVERSE, dedupe } from "../_shared/market/universe.ts";

interface ScripRow {
  symbol: string;
  exchange: string;
  token: string;
  company_name: string | null;
  series: string | null;
  isin: string | null;
  lot_size: number | null;
  tick_size: number | null;
  instrument_type: string | null;
  yahoo_symbol: string;
  is_active: boolean;
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
    }
  }
  if (buf) yield buf;
}

// Stream-parse one Kotak scrip-master CSV (nse_cm or bse_cm) and upsert every
// EQ/BE row for the given exchange. Shared by both exchange branches below —
// same column layout, only the exchange tag and Yahoo suffix differ.
async function syncScripFile(
  svc: SupabaseClient,
  url: string,
  exchange: "NSE" | "BSE",
  yahooSuffix: string,
): Promise<{ parsed: number; upserted: number }> {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`${exchange} scrip master fetch failed: HTTP ${r.status}`);

  let header: string[] | null = null;
  let col: Record<string, number> = {};
  let batch: ScripRow[] = [];
  let parsed = 0;
  let upserted = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const { error } = await svc.from("market_stocks").upsert(batch, { onConflict: "symbol,exchange" });
    if (!error) upserted += batch.length;
    // Base rows into the unified market_data table so new listings enter the
    // EOD/fundamentals pipelines — those read their worklist off market_stocks
    // still, but the screener/alerts/autotrade paths read market_data only.
    await svc.from("market_data").upsert(
      batch.map((b) => ({
        symbol: b.symbol,
        exchange: b.exchange,
        company_name: b.company_name,
        instrument_type: b.instrument_type ?? "EQ",
        kotak_token: b.token,
        yahoo_symbol: b.yahoo_symbol,
        is_active: b.is_active,
      })),
      { onConflict: "symbol,exchange" },
    );
    batch = [];
  };

  for await (const line of lines(r.body)) {
    if (!line.trim()) continue;
    const cells = line.split(",");
    if (!header) {
      header = cells.map((c) => c.trim());
      col = Object.fromEntries(header.map((h, i) => [h, i]));
      continue;
    }
    parsed++;
    const series = cells[col["pSeries"] ?? col["pGroup"]]?.trim() ?? "";
    if (series !== "EQ" && series !== "BE") continue;
    const trd = cells[col["pTrdSymbol"]]?.trim() ?? "";
    const symbol = trd.replace(/-(EQ|BE)$/, "");
    const token = cells[col["pSymbol"]]?.trim();
    if (!symbol || !token) continue;
    batch.push({
      symbol,
      exchange,
      token,
      company_name: cells[col["pSymbolName"]]?.trim() || cells[col["pDesc"]]?.trim() || null,
      series,
      isin: cells[col["pISIN"]]?.trim() || null,
      lot_size: parseInt(cells[col["lLotSize"]] ?? "") || null,
      tick_size: parseFloat(cells[col["dTickSize"]] ?? "") || null,
      instrument_type: cells[col["pInstType"]]?.trim() || null,
      yahoo_symbol: `${symbol}${yahooSuffix}`,
      is_active: true,
    });
    if (batch.length >= 500) await flush();
  }
  await flush();
  return { parsed, upserted };
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const svc = svcClient();
    if (req.headers.get("x-cron-secret") != null) {
      const guard = await requireCronSecret(req);
      if (guard) return guard;
    } else {
      const auth = await requireUserId(req);
      if ("error" in auth) return auth.error;
    }

    // Any kotak row with a consumer key can fetch the scrip master
    const { data: settingsRows } = await svc.from("market_api_settings")
      .select(KOTAK_SETTINGS_COLS)
      .eq("active_provider", "kotak_neo")
      .not("consumer_key", "is", null)
      .limit(1);
    const settings = (settingsRows?.[0] ?? null) as KotakSettings | null;

    let parsed = 0;
    let upserted = 0;
    let bseParsed = 0;
    let bseUpserted = 0;
    let bseError: string | null = null;

    if (settings) {
      const paths = await kotakScripFilePaths(settings);
      const nseCm = paths.find((p) => /nse_cm/i.test(p) && p.endsWith(".csv"));
      if (!nseCm) return errorResponse(req, "nse_cm scrip file not found in Kotak file paths", 502);
      const nse = await syncScripFile(svc, nseCm, "NSE", ".NS");
      parsed = nse.parsed;
      upserted = nse.upserted;

      // BSE-only listings (never cross-listed on NSE) were previously never
      // ingested at all — the universe was structurally NSE-only. Best-effort:
      // a missing bse_cm path or a fetch failure doesn't fail the whole sync,
      // since NSE coverage is the primary, already-working path.
      try {
        const bseCm = paths.find((p) => /bse_cm/i.test(p) && p.endsWith(".csv"));
        if (bseCm) {
          const bse = await syncScripFile(svc, bseCm, "BSE", ".BO");
          bseParsed = bse.parsed;
          bseUpserted = bse.upserted;
        } else {
          bseError = "bse_cm scrip file not found in Kotak file paths";
        }
      } catch (e) {
        bseError = e instanceof Error ? e.message : String(e);
      }
    }

    // Universe flags: NIFTY 500 (or fallback list) ∪ user symbols
    const [n500, holdingsRes, watchRes, posRes] = await Promise.all([
      fetchNifty500(),
      svc.from("market_holdings").select("symbol"),
      svc.from("market_watchlist_items").select("symbol"),
      svc.from("market_positions").select("symbol"),
    ]);
    const nifty500List = n500.length > 50 ? n500 : FALLBACK_UNIVERSE;
    const universe = dedupe([
      ...nifty500List,
      ...(holdingsRes.data ?? []).map((r: any) => r.symbol),
      ...(watchRes.data ?? []).map((r: any) => r.symbol),
      ...(posRes.data ?? []).map((r: any) => r.symbol),
    ]);

    // Ensure user symbols exist even without a scrip master run
    for (const sym of universe) {
      await svc.from("market_stocks").upsert(
        { symbol: sym, exchange: "NSE", yahoo_symbol: `${sym}.NS`, is_active: true },
        { onConflict: "symbol,exchange", ignoreDuplicates: true },
      );
      await svc.from("market_data").upsert(
        { symbol: sym, exchange: "NSE", yahoo_symbol: `${sym}.NS`, is_active: true },
        { onConflict: "symbol,exchange", ignoreDuplicates: true },
      );
    }
    // Flag every active NSE equity as in_universe — the screener view and
    // sync pipelines now cover the full active set, not just Nifty 500 + user
    // holdings. Nifty 500 membership stays on is_nifty500 below.
    await svc.from("market_stocks").update({ in_universe: true }).eq("is_active", true).eq("exchange", "NSE");
    await svc.from("market_data").update({ in_universe: true }).eq("is_active", true).eq("exchange", "NSE");
    // Flag is_nifty500 on the official (or fallback) list
    await svc.from("market_stocks").update({ is_nifty500: false }).eq("is_nifty500", true);
    await svc.from("market_data").update({ is_nifty500: false }).eq("is_nifty500", true);
    for (let i = 0; i < nifty500List.length; i += 200) {
      const slice = nifty500List.slice(i, i + 200);
      await svc.from("market_stocks")
        .update({ is_nifty500: true })
        .in("symbol", slice)
        .eq("exchange", "NSE");
      await svc.from("market_data")
        .update({ is_nifty500: true })
        .in("symbol", slice)
        .eq("exchange", "NSE");
    }


    return jsonResponse(req, {
      ok: true,
      scrips_parsed: parsed,
      scrips_upserted: upserted,
      bse_scrips_parsed: bseParsed,
      bse_scrips_upserted: bseUpserted,
      bse_error: bseError,
      universe_size: universe.length,
      nifty500_source: n500.length > 50 ? "nse_archives" : "fallback_static",
      kotak_master_used: !!settings,
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
