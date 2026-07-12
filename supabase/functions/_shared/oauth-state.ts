// Signed HMAC state token for OAuth flows.
// Prevents CSRF and lets the public callback trust the payload.

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(new Uint8Array(sig));
}

// Fail closed: signing/verifying OAuth state with a hardcoded fallback would
// let anyone forge a valid state token using that publicly-known string.
function SECRET(): string {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured — cannot sign OAuth state");
  return key;
}

export async function signState(payload: Record<string, unknown>, ttlSec = 600): Promise<string> {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const p = b64url(enc.encode(JSON.stringify(body)));
  const sig = await hmac(SECRET(), p);
  return `${p}.${sig}`;
}

export async function verifyState<T = Record<string, unknown>>(token: string): Promise<T | null> {
  const [p, sig] = token.split(".");
  if (!p || !sig) return null;
  const expected = await hmac(SECRET(), p);
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(dec.decode(b64urlDecode(p))) as T & { exp?: number };
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}
