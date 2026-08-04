// Egress meter — the app measures its own Supabase egress.
//
// Supabase's Management API no longer exposes per-project egress, and the free
// plan keeps only ~10 minutes of edge logs, so the only reliable source of
// truth is the client itself. This wraps `window.fetch`, records the response
// size of every Supabase read (PostgREST, edge functions, storage, auth) and
// flushes an aggregate to `record_egress` every 60s (and on page hide).
//
// The report is one small RPC per minute per open tab — negligible next to the
// reads it measures. In dev it also prints a per-read table via `__egress()`.

import { supabase } from "@/integrations/supabase/client";

type Row = { calls: number; bytes: number; max: number };
type Source = "postgrest" | "functions" | "storage" | "auth" | "realtime" | "unknown";

const WARN_BYTES = 256 * 1024; // one read shipping a quarter MB is worth a look
const FLUSH_MS = 60_000;

const session = new Map<string, Row>();          // dev table, per read label
const pending = new Map<string, Row>();          // not yet reported, per source|route

function classify(url: string): { source: Source; route: string } | null {
  let u: URL;
  try { u = new URL(url, window.location.origin); } catch { return null; }
  if (!u.hostname.endsWith(".supabase.co") && !u.hostname.endsWith(".supabase.in")) return null;
  const p = u.pathname;
  const tail = p.split("/").filter(Boolean).slice(2).join("/") || p;
  if (p.includes("/rest/v1/")) {
    const select = u.searchParams.get("select");
    const cols = select === "*" ? "*" : select ? `${select.split(",").length}c` : "";
    return { source: "postgrest", route: cols ? `${tail} (${cols})` : tail };
  }
  if (p.includes("/functions/v1/")) return { source: "functions", route: tail };
  if (p.includes("/storage/v1/")) return { source: "storage", route: tail.split("/").slice(0, 3).join("/") };
  if (p.includes("/auth/v1/")) return { source: "auth", route: tail };
  if (p.includes("/realtime/v1")) return { source: "realtime", route: "websocket" };
  return { source: "unknown", route: tail };
}

function bump(map: Map<string, Row>, key: string, bytes: number) {
  const row = map.get(key) ?? { calls: 0, bytes: 0, max: 0 };
  row.calls += 1;
  row.bytes += bytes;
  row.max = Math.max(row.max, bytes);
  map.set(key, row);
}

function human(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

let flushing = false;

async function flush(): Promise<void> {
  if (flushing || pending.size === 0) return;
  flushing = true;
  const snapshot = [...pending.entries()];
  pending.clear();
  // Group by source: `record_egress` takes one source per call.
  const bySource = new Map<string, { route: string; bytes: number; requests: number }[]>();
  for (const [key, row] of snapshot) {
    const [source, ...rest] = key.split("|");
    const list = bySource.get(source) ?? [];
    list.push({ route: rest.join("|"), bytes: Math.round(row.bytes), requests: row.calls });
    bySource.set(source, list);
  }
  try {
    for (const [source, rows] of bySource) {
      // Cap the payload so a long session cannot ship a huge report.
      const top = rows.sort((a, b) => b.bytes - a.bytes).slice(0, 40);
      const { error } = await (supabase as any).rpc("record_egress", { _source: source, _rows: top });
      if (error) throw error;
    }
  } catch {
    // Signed out or offline — put the counts back so nothing is lost.
    for (const [key, row] of snapshot) bump(pending, key, row.bytes);
  } finally {
    flushing = false;
  }
}

// Supabase bills wire bytes: the (compressed) body plus response headers.
// `arrayBuffer().byteLength` is the DECOMPRESSED body, so a gzipped JSON read
// used to be counted ~3x too high while its headers were not counted at all.
// Prefer content-length (already the encoded length), fall back to a gzip
// estimate for JSON, and add a flat per-response header allowance.
const HEADER_OVERHEAD = 220;
const GZIP_RATIO = 0.35;

function wireBytes(res: Response, decoded: number): number {
  const cl = Number(res.headers.get("content-length"));
  if (Number.isFinite(cl) && cl > 0) return cl + HEADER_OVERHEAD;
  const encoded = (res.headers.get("content-encoding") ?? "").toLowerCase();
  const compressible = encoded.includes("gzip") || encoded.includes("br") || encoded.includes("deflate");
  return Math.round(decoded * (compressible ? GZIP_RATIO : 1)) + HEADER_OVERHEAD;
}

// Realtime frames never went through fetch, so the websocket feed (tick relay,
// depth books) was invisible to the meter entirely.
function installRealtimeMeter() {
  const NativeWS = window.WebSocket;
  if (!NativeWS || (NativeWS as any).__metered) return;
  const Wrapped = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const ws = new NativeWS(url as any, protocols as any);
    const href = typeof url === "string" ? url : url.toString();
    if (/supabase\.(co|in)\/realtime/.test(href)) {
      ws.addEventListener("message", (ev: MessageEvent) => {
        const d = ev.data;
        const bytes = typeof d === "string" ? d.length
          : d instanceof ArrayBuffer ? d.byteLength
          : (d as Blob)?.size ?? 0;
        if (bytes > 0) {
          bump(pending, "realtime|websocket", bytes);
          bump(session, "realtime/websocket", bytes);
        }
      });
    }
    return ws;
  } as unknown as typeof WebSocket;
  Wrapped.prototype = NativeWS.prototype;
  (Wrapped as any).__metered = true;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
    (Wrapped as any)[k] = (NativeWS as any)[k];
  }
  window.WebSocket = Wrapped;
}

export function installEgressMeter() {
  if (typeof window === "undefined") return;
  if ((window as any).__egress) return;

  const original = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input as any, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const hit = classify(url);
    // Never meter the meter, or the read that renders the meter.
    if (!hit || hit.route.startsWith("rpc/record_egress")) return res;

    res.clone().arrayBuffer().then((buf) => {
      const bytes = wireBytes(res, buf.byteLength);
      if (bytes <= 0) return;
      bump(pending, `${hit.source}|${hit.route}`, bytes);
      bump(session, hit.route, bytes);
      if (import.meta.env.DEV && bytes >= WARN_BYTES) {
        // eslint-disable-next-line no-console
        console.warn(`[egress] ${hit.route} → ${human(bytes)} in one response`);
      }
    }).catch(() => {
      // Streamed bodies (SSE) are not measurable — count the headers at least.
      bump(pending, `${hit.source}|${hit.route}`, HEADER_OVERHEAD);
    });

    return res;
  };

  installRealtimeMeter();

  setInterval(() => { void flush(); }, FLUSH_MS);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush();
  });
  window.addEventListener("pagehide", () => { void flush(); });


  (window as any).__egress = () => {
    const rows = [...session.entries()]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([read, r]) => ({ read, calls: r.calls, total: human(r.bytes), largest: human(r.max) }));
    // eslint-disable-next-line no-console
    console.table(rows);
    return rows;
  };

  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.info("[egress] meter active — run __egress() for the per-read table");
  }
}
