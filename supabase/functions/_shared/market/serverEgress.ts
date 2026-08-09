// Server-side egress meter.
//
// The browser meter (src/lib/egressMeter.ts) only sees traffic from open tabs,
// so cron jobs and edge functions — which read PostgREST over the public URL
// with the service key, and are billed exactly the same — were invisible. That
// is where the missing GBs in the quota panel were hiding.
//
// This patches the isolate's `fetch` once, counts Supabase response bytes, and
// flushes them into `system_egress_daily` through `record_egress` (same table
// the client writes, so the panel totals both). Routes are prefixed `srv:` so
// server traffic stays distinguishable from browser traffic.

type Row = { bytes: number; requests: number };

const pending = new Map<string, Row>();
const HEADER_OVERHEAD = 220;
const FLUSH_AFTER_REQUESTS = 25;
const FLUSH_AFTER_MS = 10_000;
// Any single server-side read over this is a missing filter, not a big table.
// Tag it in the route label so `system_egress_daily` names the offender.
// Mirrors the browser meter's ceiling in src/lib/egressMeter.ts.
const OVERSIZE_BYTES = 128 * 1024;

let installed = false;
let originalFetch: typeof fetch | null = null;
let flushTimer: number | undefined;
let flushing = false;

function classify(url: string): { source: string; route: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!u.hostname.endsWith(".supabase.co") && !u.hostname.endsWith(".supabase.in")) return null;
  const p = u.pathname;
  const tail = p.split("/").filter(Boolean).slice(2).join("/") || p;
  if (p.includes("/rest/v1/")) return { source: "postgrest", route: `srv:${tail}` };
  if (p.includes("/functions/v1/")) return { source: "functions", route: `srv:${tail}` };
  if (p.includes("/storage/v1/")) return { source: "storage", route: `srv:${tail.split("/").slice(0, 3).join("/")}` };
  if (p.includes("/auth/v1/")) return { source: "auth", route: `srv:${tail}` };
  return null;
}

function bump(key: string, bytes: number) {
  if (bytes >= OVERSIZE_BYTES) {
    key = `${key} !OVER`;
    console.warn(`[egress] BUDGET: ${key} → ${Math.round(bytes / 1024)} KB in one response`);
  }
  const row = pending.get(key) ?? { bytes: 0, requests: 0 };
  row.bytes += bytes;
  row.requests += 1;
  pending.set(key, row);
}

function pendingRequests(): number {
  let n = 0;
  for (const r of pending.values()) n += r.requests;
  return n;
}

/** Push what we have measured so far into system_egress_daily. */
export async function flushServerEgress(): Promise<void> {
  if (flushing || pending.size === 0) return;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) { pending.clear(); return; }

  flushing = true;
  const snapshot = [...pending.entries()];
  pending.clear();
  const bySource = new Map<string, { route: string; bytes: number; requests: number }[]>();
  for (const [k, row] of snapshot) {
    const [source, ...rest] = k.split("|");
    const list = bySource.get(source) ?? [];
    list.push({ route: rest.join("|").slice(0, 120), bytes: Math.round(row.bytes), requests: row.requests });
    bySource.set(source, list);
  }

  const doFetch = originalFetch ?? fetch;
  try {
    for (const [source, rows] of bySource) {
      const top = rows.sort((a, b) => b.bytes - a.bytes).slice(0, 40);
      await doFetch(`${url}/rest/v1/rpc/record_egress`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ _source: source, _rows: top }),
      }).then((r) => r.text()).catch(() => "");
    }
  } finally {
    flushing = false;
  }
}

/** Patch fetch once per isolate so every Supabase read is counted. */
export function installServerEgressMeter(): void {
  if (installed) return;
  installed = true;
  originalFetch = globalThis.fetch.bind(globalThis);
  const original = originalFetch;

  globalThis.fetch = async (input: Request | URL | string, init?: RequestInit) => {
    const res = await original(input as any, init);
    try {
      const href = typeof input === "string" ? input
        : input instanceof URL ? input.toString()
        : (input as Request).url;
      const hit = classify(href);
      // Never meter the meter.
      if (!hit || hit.route.includes("rpc/record_egress")) return res;

      const cl = Number(res.headers.get("content-length"));
      if (Number.isFinite(cl) && cl > 0) {
        bump(`${hit.source}|${hit.route}`, cl + HEADER_OVERHEAD);
      } else {
        // Cloning a large body costs memory; only do it when we must.
        res.clone().arrayBuffer()
          .then((b) => bump(`${hit.source}|${hit.route}`, b.byteLength + HEADER_OVERHEAD))
          .catch(() => bump(`${hit.source}|${hit.route}`, HEADER_OVERHEAD));
      }

      if (pendingRequests() >= FLUSH_AFTER_REQUESTS) {
        void flushServerEgress();
      } else if (flushTimer === undefined) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          void flushServerEgress();
        }, FLUSH_AFTER_MS) as unknown as number;
      }
    } catch { /* metering must never break a request */ }
    return res;
  };
}
