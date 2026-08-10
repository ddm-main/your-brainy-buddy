// Live-sweep reference snapshot.
//
// EGRESS: a five-minute sweep is a chain of COLD edge invocations, one per
// chunk of symbols. Every chunk used to re-resolve the same reference data
// from PostgREST — the universe page (`market_stocks`, 4 cols), the Kotak
// instrument tokens (5 cols) and the settled
// anchors RPC. Measured on 2026-08-10 that was ~27 MB/day for data that does
// not change inside a sweep.
//
// Now the FIRST invocation of a sweep resolves all of it once and writes a
// single `market_sweep_snapshot` row whose payload is keyed by chunk index.
// Every chained chunk then reads exactly its own slice with a jsonb path
// projection (`payload->c3`), so a chunk costs one small response instead of
// four reference reads.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type SnapshotSymbol = {
  /** symbol */
  s: string;
  /** yahoo_symbol */
  y: string | null;
  /** series */
  se: string;
  /** total_shares_cr */
  sh: number | null;
};

export type SweepChunk = {
  symbols: SnapshotSymbol[];
  /** symbol -> previous settled close */
  anchors: Record<string, number>;
  /** "NSE:SYMBOL" -> Kotak instrument token */
  kotak: Record<string, { token: string; segment: string }>;
};

type UniverseRow = {
  symbol: string;
  yahoo_symbol: string | null;
  series: string | null;
  total_shares_cr: number | string | null;
  token: string | null;
  kotak_segment: string | null;
};

/**
 * Resolve the whole tradable universe plus its reference data and store it as
 * one snapshot row. Returns the number of chunks the sweep will walk.
 *
 * EGRESS: the snapshot is keyed by SESSION DATE, not by sweep. The universe and
 * the previous settled closes cannot change inside a trading day, so rebuilding
 * them every five minutes was paying ~360 KB (universe pages + anchors RPC) ~75
 * times a day for an identical answer. The first sweep of the session builds
 * it; every later sweep reuses the same row and pays only for its own chunk.
 *
 * `market_universe` is the single definition of "the tradable universe":
 * active, non-penny. Reading it here means the penny rule cannot be forgotten
 * by the sweep, and 36% of the rows never cross the wire at all.
 */
export async function buildSweepSnapshot(
  svc: SupabaseClient,
  sweepId: string,
  sessionDate: string,
  chunkSize: number,
): Promise<{ chunkCount: number; symbolCount: number; reused: boolean }> {
  // Reuse this session's snapshot when one is already built at the same chunk
  // size and still inside its lifetime.
  const { data: existing } = await svc
    .from("market_sweep_snapshot")
    .select("chunk_count,symbol_count,chunk_size,expires_at")
    .eq("session_date", sessionDate)
    .maybeSingle();
  if (
    existing &&
    Number(existing.chunk_size) === chunkSize &&
    Date.parse(String(existing.expires_at)) > Date.now()
  ) {
    return {
      chunkCount: Number(existing.chunk_count),
      symbolCount: Number(existing.symbol_count),
      reused: true,
    };
  }

  const rows: UniverseRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await svc
      .from("market_universe")
      .select("symbol,yahoo_symbol,series,total_shares_cr,token,kotak_segment")
      .eq("exchange", "NSE")
      .eq("instrument_type", "EQ")
      .order("symbol", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as unknown as UniverseRow[]));
    if (!data || data.length < PAGE) break;
  }


  // Settled anchors for the whole sweep, resolved once. The `_lean` RPC
  // returns two fields per symbol, so even the full universe is ~40 KB.
  const anchors = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 1000) {
    const symbols = rows.slice(i, i + 1000).map((r) => r.symbol);
    const { data } = await svc.rpc("market_live_settled_anchors_lean", {
      _symbols: symbols,
      _before: sessionDate,
    });
    for (const r of (data ?? []) as Array<{ symbol: string; prev_close: number | string | null }>) {
      const v = r.prev_close != null ? Number(r.prev_close) : null;
      if (v != null && v > 0) anchors.set(String(r.symbol), v);
    }
  }

  const payload: Record<string, SweepChunk> = {};
  let chunkCount = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    const chunk: SweepChunk = { symbols: [], anchors: {}, kotak: {} };
    for (const r of slice) {
      const symbol = String(r.symbol);
      chunk.symbols.push({
        s: symbol,
        y: r.yahoo_symbol ?? null,
        se: String(r.series ?? "EQ"),
        sh: r.total_shares_cr != null ? Number(r.total_shares_cr) : null,
      });
      const anchor = anchors.get(symbol);
      if (anchor != null) chunk.anchors[symbol] = anchor;
      const key = `NSE:${symbol}`;
      if (r.token) {
        chunk.kotak[key] = { token: String(r.token), segment: r.kotak_segment || "nse_cm" };
      }
    }
    payload[`c${chunkCount}`] = chunk;
    chunkCount++;
  }

  const { error: upErr } = await svc.from("market_sweep_snapshot").upsert({
    sweep_id: sweepId,
    session_date: sessionDate,
    chunk_count: chunkCount,
    symbol_count: rows.length,
    chunk_size: chunkSize,
    payload,
    // Long enough to cover a full trading session, so a session is built once.
    expires_at: new Date(Date.now() + 10 * 3_600_000).toISOString(),
  }, { onConflict: "session_date" });
  if (upErr) throw new Error(upErr.message);

  return { chunkCount, symbolCount: rows.length, reused: false };
}

/**
 * Read one chunk of the session's snapshot. The jsonb path projection means the
 * response carries only this chunk, never the whole payload.
 */
export async function readSweepChunk(
  svc: SupabaseClient,
  sessionDate: string,
  index: number,
): Promise<SweepChunk | null> {
  const { data, error } = await svc
    .from("market_sweep_snapshot")
    .select(`chunk:payload->c${index}`)
    .eq("session_date", sessionDate)
    .maybeSingle();
  if (error || !data) return null;
  const chunk = (data as unknown as { chunk: SweepChunk | null }).chunk;
  if (!chunk || !Array.isArray(chunk.symbols)) return null;
  return {
    symbols: chunk.symbols,
    anchors: chunk.anchors ?? {},
    kotak: chunk.kotak ?? {},
  };
}


/** Snapshots are disposable; drop anything past its expiry. Cheap, no-op most calls. */
export async function pruneSweepSnapshots(svc: SupabaseClient): Promise<void> {
  await svc.from("market_sweep_snapshot").delete().lt("expires_at", new Date().toISOString());
}
