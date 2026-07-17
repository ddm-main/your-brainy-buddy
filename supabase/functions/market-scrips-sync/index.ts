// market-scrips-sync — populate market_stocks from the Kotak scrip master
// (nse_cm CSV, ~20 MB, stream-parsed) and flag the pipeline universe
// (NIFTY 500 ∪ user holdings/watchlist/positions symbols).
// Invoked by weekly cron or manually (cron secret or authenticated user).
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

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    const svc = svcClient();
    if (req.headers.get("x-cron-secret") != null) {
      const guard = requireCronSecret(req);
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

    if (settings) {
      const paths = await kotakScripFilePaths(settings);
      const nseCm = paths.find((p) => /nse_cm/i.test(p) && p.endsWith(".csv"));
      if (!nseCm) return errorResponse(req, "nse_cm scrip file not found in Kotak file paths", 502);

      const r = await fetch(nseCm);
      if (!r.ok || !r.body) return errorResponse(req, `scrip master fetch failed: HTTP ${r.status}`, 502);

      let header: string[] | null = null;
      let col: Record<string, number> = {};
      let batch: ScripRow[] = [];

      const flush = async () => {
        if (batch.length === 0) return;
        const { error } = await svc.from("market_stocks").upsert(batch, { onConflict: "symbol,exchange" });
        if (!error) upserted += batch.length;
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
          exchange: "NSE",
          token,
          company_name: cells[col["pSymbolName"]]?.trim() || cells[col["pDesc"]]?.trim() || null,
          series,
          isin: cells[col["pISIN"]]?.trim() || null,
          lot_size: parseInt(cells[col["lLotSize"]] ?? "") || null,
          tick_size: parseFloat(cells[col["dTickSize"]] ?? "") || null,
          instrument_type: cells[col["pInstType"]]?.trim() || null,
          yahoo_symbol: `${symbol}.NS`,
          is_active: true,
        });
        if (batch.length >= 500) await flush();
      }
      await flush();
    }

    // Universe flags: NIFTY 500 (or fallback list) ∪ user symbols
    const [n500, holdingsRes, watchRes, posRes] = await Promise.all([
      fetchNifty500(),
      svc.from("market_holdings").select("symbol"),
      svc.from("market_watchlist_items").select("symbol"),
      svc.from("market_positions").select("symbol"),
    ]);
    const universe = dedupe([
      ...(n500.length > 50 ? n500 : FALLBACK_UNIVERSE),
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
    }
    await svc.from("market_stocks").update({ in_universe: false }).eq("in_universe", true);
    for (let i = 0; i < universe.length; i += 200) {
      await svc.from("market_stocks")
        .update({ in_universe: true })
        .in("symbol", universe.slice(i, i + 200))
        .eq("exchange", "NSE");
    }

    return jsonResponse(req, {
      ok: true,
      scrips_parsed: parsed,
      scrips_upserted: upserted,
      universe_size: universe.length,
      nifty500_source: n500.length > 50 ? "nse_archives" : "fallback_static",
      kotak_master_used: !!settings,
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
