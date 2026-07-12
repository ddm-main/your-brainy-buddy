// SSRF-hardened fetch wrapper. Blocks private/loopback/link-local hosts,
// enforces timeout and response-size caps.

const PRIVATE_HOST_RE =
  /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|::1$|fc|fd)/i;

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (PRIVATE_HOST_RE.test(h)) return true;
  // 172.16.0.0/12
  const m = h.match(/^172\.(\d+)\./);
  if (m) {
    const oct = parseInt(m[1], 10);
    if (oct >= 16 && oct <= 31) return true;
  }
  return false;
}

export interface SafeFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxBytes?: number;
  allowHosts?: string[]; // optional exact-host allowlist
}

export async function safeFetch(
  input: string | URL,
  opts: SafeFetchOptions = {},
): Promise<{ ok: boolean; status: number; bytes: Uint8Array; contentType: string; error?: string }> {
  const { timeoutMs = 8000, maxBytes = 2 * 1024 * 1024, allowHosts, ...init } = opts;
  let url: URL;
  try { url = new URL(input); } catch { return { ok: false, status: 0, bytes: new Uint8Array(), contentType: "", error: "invalid_url" }; }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, status: 0, bytes: new Uint8Array(), contentType: "", error: "blocked_scheme" };
  }
  if (isPrivateHost(url.hostname)) {
    return { ok: false, status: 0, bytes: new Uint8Array(), contentType: "", error: "blocked_private_host" };
  }
  if (allowHosts && !allowHosts.includes(url.hostname)) {
    return { ok: false, status: 0, bytes: new Uint8Array(), contentType: "", error: "host_not_allowed" };
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* noop */ }
          return { ok: false, status: res.status, bytes: new Uint8Array(), contentType: res.headers.get("content-type") ?? "", error: "response_too_large" };
        }
        chunks.push(value);
      }
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return { ok: res.ok, status: res.status, bytes: buf, contentType: res.headers.get("content-type") ?? "" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, bytes: new Uint8Array(), contentType: "", error: msg };
  } finally {
    clearTimeout(t);
  }
}

export function bytesToText(u: Uint8Array): string {
  return new TextDecoder("utf-8").decode(u);
}

/** Constant-time CRON secret verification for edge functions that run with
 * service-role privileges and no JWT gate. Reads CRON_SECRET from env,
 * fails closed on misconfiguration, and returns a ready-to-return Response
 * on failure so the caller can `if (bad) return bad;` and move on. */
export async function verifyCronSecret(req: Request): Promise<Response | null> {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret) {
    return new Response(JSON.stringify({ error: "misconfigured — CRON_SECRET not set" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
  const provided = req.headers.get("x-cron-secret") ?? "";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  const av = new Uint8Array(a), bv = new Uint8Array(b);
  let diff = av.length ^ bv.length;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  if (diff !== 0) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}
