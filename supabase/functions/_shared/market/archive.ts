// Cold-storage archive reader.
//
// Daily bars older than the hot window live in the private `market-archive`
// bucket as gzipped JSON (written by market-archive-prices). Anything that
// needs deep history reads them back through here instead of Postgres.
//
// This also protects the archive: without it, a symbol whose old bars were
// evicted looks "shallow" to market-candles / market-history-backfill and gets
// re-downloaded straight back into the database.
const BUCKET = "market-archive";

export interface ArchivedBar {
  time: string; open: number; high: number; low: number; close: number; volume: number;
}

export interface ArchiveMeta { path: string; lastDate: string; bars: number }

// deno-lint-ignore no-explicit-any
type Svc = any;

const metaCache = new Map<string, { at: number; meta: ArchiveMeta | null }>();
const barsCache = new Map<string, { at: number; bars: ArchivedBar[] }>();
const TTL_MS = 30 * 60_000;

export async function getArchiveMeta(svc: Svc, symbol: string, exchange: string): Promise<ArchiveMeta | null> {
  const key = `${exchange}:${symbol}`;
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.meta;

  const { data } = await svc.from("market_archive_index")
    .select("object_path,last_date,bars")
    .eq("symbol", symbol).eq("exchange", exchange).maybeSingle();

  const meta: ArchiveMeta | null = data
    ? { path: data.object_path as string, lastDate: String(data.last_date ?? ""), bars: Number(data.bars ?? 0) }
    : null;
  metaCache.set(key, { at: Date.now(), meta });
  return meta;
}

export async function loadArchivedBars(svc: Svc, symbol: string, exchange: string): Promise<ArchivedBar[]> {
  const key = `${exchange}:${symbol}`;
  const hit = barsCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.bars;

  const meta = await getArchiveMeta(svc, symbol, exchange);
  if (!meta) return [];

  try {
    const { data, error } = await svc.storage.from(BUCKET).download(meta.path);
    if (error || !data) return [];
    const text = await new Response(
      new Blob([new Uint8Array(await data.arrayBuffer())]).stream()
        .pipeThrough(new DecompressionStream("gzip")),
    ).text();
    const parsed = JSON.parse(text) as { bars: (string | number | null)[][] };
    const bars: ArchivedBar[] = (parsed.bars ?? [])
      .map((b) => ({
        time: String(b[0]).slice(0, 10),
        open: Number(b[1]), high: Number(b[2]), low: Number(b[3]),
        close: Number(b[4]), volume: Number(b[5] ?? 0),
      }))
      .filter((b) => Number.isFinite(b.close));
    barsCache.set(key, { at: Date.now(), bars });
    return bars;
  } catch {
    return [];
  }
}
