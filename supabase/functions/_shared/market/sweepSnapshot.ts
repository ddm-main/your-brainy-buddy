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

// Bump whenever the encoded payload or authoritative universe semantics change.
// This is part of reuse eligibility, so a same-day deployment cannot keep an
// obsolete watched-only snapshot alive for the rest of the session.
// v4: the universe is read in explicit pages. v3 snapshots were silently
// truncated to PostgREST's 1 000-row ceiling (universe = 1 441), which failed
// the run/snapshot equality guard on every sweep and froze the live plane.
const SNAPSHOT_VERSION = 4;

/** PostgREST caps an unranged response; the universe must be paged explicitly. */
const UNIVERSE_PAGE = 1000;

/** Read the whole sweep universe, page by page.
 *  A single `.rpc()` call returns at most `db-max-rows` (1 000) rows, so an
 *  unpaged read silently truncated a 1 441-symbol universe — the snapshot then
 *  disagreed with the run's SQL-side `expected_count` and every sweep failed
 *  with "universe mismatch". Paging is the only way to prove completeness. */
async function readUniverse(svc: SupabaseClient): Promise<UniverseRow[]> {
  const out: UniverseRow[] = [];
  for (let from = 0; ; from += UNIVERSE_PAGE) {
    const { data, error } = await svc
      .rpc("market_live_sweep_universe")
      .range(from, from + UNIVERSE_PAGE - 1);
    if (error) throw new Error(error.message);
    const page = ((data ?? []) as unknown as UniverseRow[]).filter((r) => r.symbol);
    out.push(...page);
    if (page.length < UNIVERSE_PAGE) break;
    // Hard stop: the universe is ~1.5 k symbols. Anything beyond this is a bug,
    // not a market.
    if (out.length > 50_000) break;
  }
  return out;
}

/** Stable fingerprint of the watched set, so a snapshot is rebuilt the moment
 *  a symbol is added to a watchlist / holding / alert and not before. */
async function hashSymbols(symbols: string[]): Promise<string> {
  const buf = new TextEncoder().encode(symbols.join(","));
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Resolve the FULL mainboard sweep universe plus its reference data and store it
 * as one snapshot row. Returns the number of chunks the sweep will walk.
 *
 * Why full universe: `promote_market_live_sweep` measures coverage against every
 * active non-penny NSE EQ mainboard row. Quoting only the watched set (~169
 * symbols) made coverage structurally ~10%, so no sweep was ever promoted and
 * the live plane froze — which is exactly why the screener disagreed with
 * Economic Times. `market_live_sweep_universe()` returns the same plane
 * promotion counts, watched symbols first so held names survive a late-chunk
 * failure.
 *
 * EGRESS: the universe, its Kotak tokens and the settled anchors are resolved
 * ONCE per session into `market_sweep_snapshot`; every chained chunk reads only
 * its own columnar slice. With a 400-symbol chunk a full sweep is ~5 chained
 * invocations instead of ~9, so the per-invocation reference overhead is paid
 * half as often.
 *
 * The snapshot is keyed by SESSION DATE and fingerprinted by the universe, so
 * it is built once per session and rebuilt only when the universe changes.
 */
export async function buildSweepSnapshot(
  svc: SupabaseClient,
  sweepId: string,
  sessionDate: string,
  chunkSize: number,
  /** The run's SQL-side population count. When given, a snapshot that does not
   *  match it is rejected here with a truncation-aware message instead of
   *  silently producing a short universe. */
  expectedCount?: number | null,
): Promise<{ chunkCount: number; symbolCount: number; reused: boolean }> {
  const rows = await readUniverse(svc);
  if (expectedCount != null && expectedCount > 0 && rows.length !== expectedCount) {
    throw new Error(
      `universe read incomplete: expected ${expectedCount}, read ${rows.length}` +
      (rows.length % UNIVERSE_PAGE === 0 ? " (looks like a truncated PostgREST page)" : ""),
    );
  }
  const watchHash = await hashSymbols(rows.map((r) => String(r.symbol)));

  // Reuse this session's snapshot when one is already built for the same
  // watched set at the same chunk size and still inside its lifetime.
  const { data: existing } = await svc
    .from("market_sweep_snapshot")
    .select("chunk_count,symbol_count,chunk_size,expires_at,watch_hash,snapshot_version")
    .eq("session_date", sessionDate)
    .maybeSingle();
  if (
    existing &&
    Number(existing.snapshot_version) === SNAPSHOT_VERSION &&
    Number(existing.chunk_size) === chunkSize &&
    String(existing.watch_hash ?? "") === watchHash &&
    Date.parse(String(existing.expires_at)) > Date.now()
  ) {
    return {
      chunkCount: Number(existing.chunk_count),
      symbolCount: Number(existing.symbol_count),
      reused: true,
    };
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

  // EGRESS: the payload used to be one JSON object per symbol
  // (`{"s":…,"y":…,"se":…,"sh":…}` plus a keyed `kotak` entry) — 63 KB on the
  // wire for 169 symbols, read once per invocation, 15.7 MB/day. Columnar
  // parallel arrays with the common values elided (yahoo = `SYMBOL.NS`,
  // series = EQ, segment = nse_cm) carry the same data in ~10 KB.
  const payload: Record<string, ColumnarChunk> = {};
  let chunkCount = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    const chunk: ColumnarChunk = { v: 2, s: [], y: [], se: [], sh: [], a: [], t: [], g: [] };
    for (const r of slice) {
      const symbol = String(r.symbol);
      const yahoo = r.yahoo_symbol ?? null;
      const series = String(r.series ?? "EQ");
      const segment = r.kotak_segment || "nse_cm";
      chunk.s.push(symbol);
      chunk.y.push(!yahoo || yahoo === `${symbol}.NS` ? 0 : yahoo);
      chunk.se.push(series === "EQ" ? 0 : series);
      chunk.sh.push(r.total_shares_cr != null ? Number(r.total_shares_cr) : 0);
      chunk.a.push(anchors.get(symbol) ?? 0);
      chunk.t.push(r.token ? String(r.token) : 0);
      chunk.g.push(r.token ? (segment === "nse_cm" ? 0 : segment) : 0);
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
    watch_hash: watchHash,
    snapshot_version: SNAPSHOT_VERSION,
    payload,

    // Long enough to cover a full trading session, so a session is built once.
    expires_at: new Date(Date.now() + 10 * 3_600_000).toISOString(),
  }, { onConflict: "session_date" });
  if (upErr) throw new Error(upErr.message);

  // The builder already holds every chunk in memory: seed the memo so the
  // first chunk of this sweep costs no read at all.
  chunkMemo.clear();
  for (let i = 0; i < chunkCount; i++) {
    const decoded = decodeChunk(payload[`c${i}`]);
    if (decoded) chunkMemo.set(`${sessionDate}|${i}`, { chunk: decoded, expiresAt: Date.now() + CHUNK_MEMO_MS });
  }
  return { chunkCount, symbolCount: rows.length, reused: false };
}

/** Columnar on-the-wire shape. `0` means "the common value" (see encoder). */
type ColumnarChunk = {
  v: 2;
  s: string[];
  y: (string | 0)[];
  se: (string | 0)[];
  sh: number[];
  a: number[];
  t: (string | 0)[];
  g: (string | 0)[];
};

function decodeChunk(raw: unknown): SweepChunk | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<ColumnarChunk> & Partial<SweepChunk>;
  // Legacy (v1) object-per-symbol payload, still readable mid-migration.
  if (Array.isArray(c.symbols)) {
    return { symbols: c.symbols, anchors: c.anchors ?? {}, kotak: c.kotak ?? {} };
  }
  if (!Array.isArray(c.s)) return null;
  const out: SweepChunk = { symbols: [], anchors: {}, kotak: {} };
  for (let i = 0; i < c.s.length; i++) {
    const symbol = String(c.s[i]);
    out.symbols.push({
      s: symbol,
      y: (c.y?.[i] || `${symbol}.NS`) as string,
      se: (c.se?.[i] || "EQ") as string,
      sh: Number(c.sh?.[i] ?? 0) || null,
    });
    const anchor = Number(c.a?.[i] ?? 0);
    if (anchor > 0) out.anchors[symbol] = anchor;
    const token = c.t?.[i];
    if (token) {
      out.kotak[`NSE:${symbol}`] = { token: String(token), segment: (c.g?.[i] || "nse_cm") as string };
    }
  }
  return out;
}

// EGRESS: a warm isolate serving several chunks of the same sweep should read
// the snapshot once, not once per chunk. Cleared whenever a snapshot is built.
const chunkMemo = new Map<string, { chunk: SweepChunk; expiresAt: number }>();
const CHUNK_MEMO_MS = 5.5 * 60_000;

/**
 * Read one chunk of the session's snapshot. The jsonb path projection means the
 * response carries only this chunk, never the whole payload.
 */
export async function readSweepChunk(
  svc: SupabaseClient,
  sessionDate: string,
  index: number,
): Promise<SweepChunk | null> {
  const memoKey = `${sessionDate}|${index}`;
  const memo = chunkMemo.get(memoKey);
  if (memo && memo.expiresAt > Date.now()) return memo.chunk;

  const { data, error } = await svc
    .from("market_sweep_snapshot")
    .select(`chunk:payload->c${index}`)
    .eq("session_date", sessionDate)
    .maybeSingle();
  if (error || !data) return null;
  const chunk = decodeChunk((data as unknown as { chunk: unknown }).chunk);
  if (!chunk) return null;
  chunkMemo.set(memoKey, { chunk, expiresAt: Date.now() + CHUNK_MEMO_MS });
  return chunk;
}


/** Snapshots are disposable; drop anything past its expiry. Cheap, no-op most calls. */
export async function pruneSweepSnapshots(svc: SupabaseClient): Promise<void> {
  await svc.from("market_sweep_snapshot").delete().lt("expires_at", new Date().toISOString());
}

