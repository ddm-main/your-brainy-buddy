// market-archive-prices — cold-storage offload for market_daily_prices.
//
// Postgres on the Supabase free plan is capped at 500 MB while file storage is
// capped at 1 GB. Daily bars older than the "hot" window are never touched by
// the screener, indicators or scores — only by deep charts and backtests — so
// they are written to the private `market-archive` bucket as gzipped JSON and
// deleted from Postgres. Gzip gets ~8:1 on OHLCV, so 170 MB of rows becomes
// roughly 20 MB of objects.
//
// Idempotent: each run claims a bounded batch of symbols, merges any existing
// archive object with the rows it is about to evict, re-uploads, verifies, and
// only then deletes from the table.
import { preflight, jsonResponse, errorResponse, requireUserId, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret } from "../_shared/market/cron.ts";
import { fetchAllRows } from "../_shared/market/paginate.ts";

const BUCKET = "market-archive";
// The archive backlog is the single biggest lever on database size, so the
// drain runs a wide batch until the queue is empty (the picker only returns
// symbols that still hold cold rows, so a drained universe costs one query).
const DEFAULT_LIMIT = 100;

type Bar = [string, number | null, number | null, number | null, number | null, number | null];

interface Body { limit?: number; mode?: "archive" | "prune" }

function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer().then((b) => new Uint8Array(b));
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  try {
    if (req.headers.get("x-cron-secret") != null) {
      const guard = await requireCronSecret(req);
      if (guard) return guard;
    } else {
      const auth = await requireUserId(req);
      if ("error" in auth) return auth.error;
    }

    const body: Body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const limit = Math.max(1, Math.min(Number(body.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 120));

    const svc = svcClient();

    // mode: "prune" — drop archive objects that must not exist any more:
    // anything belonging to a penny-flagged symbol, and anything whose whole
    // window sits beyond the 2-year history ceiling. SQL cannot delete bucket
    // objects, so the sweep lives here.
    if (body.mode === "prune") {
      const { data: cfg } = await svc.from("system_retention_config")
        .select("days").eq("key", "max_history_days").maybeSingle();
      const keepDays = Math.max(90, Number((cfg as any)?.days ?? 730));
      const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString().slice(0, 10);

      // Penny symbols must be paged: there are >1k of them and a plain select
      // silently stops at PostgREST's 1000-row default, leaving archives behind.
      const pennyRows = await fetchAllRows<{ symbol: string; exchange: string }>((from, to) =>
        svc.from("market_stocks").select("symbol,exchange")
          .eq("penny_excluded", true).order("symbol", { ascending: true }).range(from, to) as any,
      );
      const { data: oldRows } = await svc.from("market_archive_index")
        .select("symbol,exchange,object_path").lt("last_date", cutoff);
      const pennyKeys = new Set(pennyRows.map((r) => `${r.exchange}:${r.symbol}`));

      const idx = await fetchAllRows<{ symbol: string; exchange: string; object_path: string }>((from, to) =>
        svc.from("market_archive_index").select("symbol,exchange,object_path").range(from, to) as any,
      );
      const doomed = new Map<string, { symbol: string; exchange: string; object_path: string }>();
      for (const r of idx) {
        if (pennyKeys.has(`${r.exchange}:${r.symbol}`)) doomed.set(r.object_path, r);
      }
      for (const r of (oldRows ?? []) as any[]) doomed.set(r.object_path, r);

      const paths = [...doomed.keys()];
      let objectsRemoved = 0, indexRemoved = 0;
      for (let i = 0; i < paths.length; i += 100) {
        const batch = paths.slice(i, i + 100);
        const { error: rmErr } = await svc.storage.from(BUCKET).remove(batch);
        if (!rmErr) objectsRemoved += batch.length;
        for (const p of batch) {
          const row = doomed.get(p)!;
          const { error: delErr } = await svc.from("market_archive_index")
            .delete().eq("symbol", row.symbol).eq("exchange", row.exchange);
          if (!delErr) indexRemoved += 1;
        }
      }

      return jsonResponse(req, {
        ok: true, mode: "prune", cutoff,
        objects_removed: objectsRemoved, index_rows_removed: indexRemoved,
      });
    }


    // Hot windows come from the retention config so they can be tightened by
    // the governor without a redeploy.
    const { data: cfgRows } = await svc.from("system_retention_config")
      .select("key,days").in("key", ["prices_hot_tracked", "prices_hot_other"]);
    const cfg = new Map<string, number>((cfgRows ?? []).map((r) => [r.key as string, r.days as number]));
    const hotTracked = cfg.get("prices_hot_tracked") ?? 730;
    const hotOther = cfg.get("prices_hot_other") ?? 400;

    const { data: candidates, error: candErr } = await svc.rpc("market_archive_candidates", {
      _limit: limit, _hot_tracked: hotTracked, _hot_other: hotOther,
    });
    if (candErr) return errorResponse(req, candErr.message, 500);

    const work = (candidates ?? []) as { symbol: string; exchange: string; cutoff: string; cold_bars: number }[];
    if (work.length === 0) return jsonResponse(req, { ok: true, archived: 0, drained: true });

    let archived = 0, rowsMoved = 0, bytesWritten = 0;
    const failures: { symbol: string; error: string }[] = [];

    for (const item of work) {
      try {
        const path = `${item.exchange}/${item.symbol}.json.gz`;

        // Rows that are about to leave Postgres.
        // MUST be paged: `.limit(20000)` was capped at 1000 by the Data API,
        // so a symbol with more cold bars than that got only its oldest 1000
        // archived — and the delete below is driven by the same cutoff, which
        // would have destroyed the unarchived remainder.
        const cold = await fetchAllRows<{
          trade_date: string; open: number | null; high: number | null;
          low: number | null; close: number | null;
          close_adjusted: number | null; volume: number | null;
        }>((from, to) =>
          svc
            .from("market_daily_prices")
            .select("trade_date,open,high,low,close,close_adjusted,volume")
            .eq("symbol", item.symbol).eq("exchange", item.exchange)
            .lt("trade_date", item.cutoff)
            .order("trade_date", { ascending: true })
            .range(from, to) as any,
        );
        if (cold.length === 0) continue;

        const fresh: Bar[] = cold.map((r) => [
          r.trade_date as string,
          r.open as number | null,
          r.high as number | null,
          r.low as number | null,
          (r.close_adjusted ?? r.close) as number | null,
          r.volume as number | null,
        ]);

        // Merge with whatever is already archived for this symbol.
        let merged: Bar[] = fresh;
        const existing = await svc.storage.from(BUCKET).download(path);
        if (existing.data) {
          const text = await gunzip(new Uint8Array(await existing.data.arrayBuffer()));
          const prev = JSON.parse(text) as { bars: Bar[] };
          const byDate = new Map<string, Bar>();
          for (const b of prev.bars ?? []) byDate.set(b[0], b);
          for (const b of fresh) byDate.set(b[0], b);
          merged = [...byDate.values()].sort((a, b) => a[0].localeCompare(b[0]));
        }

        const payload = JSON.stringify({
          symbol: item.symbol, exchange: item.exchange, v: 1,
          fields: ["date", "open", "high", "low", "close", "volume"],
          bars: merged,
        });
        const gz = await gzip(new TextEncoder().encode(payload));

        const up = await svc.storage.from(BUCKET).upload(path, gz, {
          contentType: "application/gzip", upsert: true,
        });
        if (up.error) throw new Error(up.error.message);

        // Verify the object is readable before deleting anything.
        const verify = await svc.storage.from(BUCKET).download(path);
        if (verify.error || !verify.data) throw new Error("archive verification failed");

        // Delete year by year. PostgREST runs under an 8 s statement timeout,
        // and one DELETE covering a decade of bars for a heavily-indexed table
        // can exceed it — leaving the object uploaded but the rows behind.
        const years: string[] = [];
        for (let y = Number(fresh[0][0].slice(0, 4)); y <= Number(item.cutoff.slice(0, 4)); y++) {
          years.push(String(y));
        }
        for (const y of years) {
          const from = `${y}-01-01`;
          const to = Number(y) + 1 > Number(item.cutoff.slice(0, 4)) ? item.cutoff : `${Number(y) + 1}-01-01`;
          let delErr: { message: string } | null = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            const res = await svc.from("market_daily_prices")
              .delete().eq("symbol", item.symbol).eq("exchange", item.exchange)
              .gte("trade_date", from).lt("trade_date", to);
            delErr = res.error;
            if (!delErr) break;
            await new Promise((r) => setTimeout(r, 1000));
          }
          if (delErr) throw new Error(delErr.message);
        }


        await svc.from("market_archive_index").upsert({
          symbol: item.symbol, exchange: item.exchange, object_path: path,
          first_date: merged[0][0], last_date: merged[merged.length - 1][0],
          bars: merged.length, bytes: gz.byteLength, updated_at: new Date().toISOString(),
        }, { onConflict: "symbol,exchange" });

        archived += 1;
        rowsMoved += fresh.length;
        bytesWritten += gz.byteLength;
      } catch (e) {
        failures.push({ symbol: item.symbol, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return jsonResponse(req, {
      ok: true, archived, rows_moved: rowsMoved, bytes_written: bytesWritten,
      failures: failures.slice(0, 10), failure_count: failures.length,
    });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : "archive failed", 500);
  }
});
