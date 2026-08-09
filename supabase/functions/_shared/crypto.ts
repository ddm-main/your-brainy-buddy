// AES-256-GCM encrypt/decrypt for bank/card statement passwords. Server-only.
//
// STATEMENT_ENC_SECRET must be set via `supabase secrets set
// STATEMENT_ENC_SECRET=<random 32+ chars>` — an Edge Function secret only.
// It must NEVER become a VITE_* variable or appear in any frontend-read
// .env: those get bundled into client JS and served to the browser.

export interface StatementPasswordRule {
  v: 1;
  alg: "aes-256-gcm";
  ciphertext_b64: string;
  iv_b64: string;
  auth_tag_b64: string;
  encrypted_at: string;
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Runtime-agnostic env read: this file is also imported directly (cross-folder,
// no bundling) by the local Node relay (Apps/relay/kotak-ws-relay.mjs), which
// has no `Deno` global — only `process.env`. Read via `globalThis` (rather
// than the bare `Deno`/`process` identifiers) so neither runtime's checker
// needs the other's ambient types declared.
function readEnv(name: string): string | undefined {
  const g = globalThis as Record<string, any>;
  if (g.Deno?.env?.get) return g.Deno.env.get(name);
  if (g.process?.env) return g.process.env[name];
  return undefined;
}

// Distinguishable failure modes, so the app can tell "the server has no key"
// apart from "the stored ciphertext was written under a different key and the
// credential must be entered again".
export const ENC_KEY_MISSING = "ENC_KEY_MISSING";
export const ENC_KEY_MISMATCH = "ENC_KEY_MISMATCH";

export function encFailureKind(err: unknown): typeof ENC_KEY_MISSING | typeof ENC_KEY_MISMATCH | null {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (msg.includes(ENC_KEY_MISSING)) return ENC_KEY_MISSING;
  if (msg.includes(ENC_KEY_MISMATCH)) return ENC_KEY_MISMATCH;
  return null;
}

async function keyFromSecret(): Promise<CryptoKey> {
  const secret = readEnv("STATEMENT_ENC_SECRET");
  if (!secret) {
    throw new Error(`${ENC_KEY_MISSING}: STATEMENT_ENC_SECRET is not configured on the server`);
  }
  // Derive a 32-byte AES-256 key from the configured secret via SHA-256.
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptStatementPassword(plaintext: string): Promise<StatementPasswordRule> {
  const key = await keyFromSecret();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  // Web Crypto's AES-GCM appends the 16-byte auth tag to the ciphertext —
  // split it off so it can be stored/verified explicitly.
  const bytes = new Uint8Array(ct);
  const tag = bytes.slice(bytes.length - 16);
  const cipher = bytes.slice(0, bytes.length - 16);
  return {
    v: 1,
    alg: "aes-256-gcm",
    ciphertext_b64: toB64(cipher),
    iv_b64: toB64(iv),
    auth_tag_b64: toB64(tag),
    encrypted_at: new Date().toISOString(),
  };
}

export async function decryptStatementPassword(rule: StatementPasswordRule): Promise<string> {
  const key = await keyFromSecret();
  const iv = fromB64(rule.iv_b64);
  const combined = concatBytes(fromB64(rule.ciphertext_b64), fromB64(rule.auth_tag_b64));
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv.slice().buffer }, key, combined.slice().buffer);
    return new TextDecoder().decode(pt);
  } catch {
    // Ciphertext written under a previous encryption key (or corrupted). It is
    // unrecoverable — the credential has to be re-entered once.
    throw new Error(`${ENC_KEY_MISMATCH}: stored credential cannot be decrypted with the current key — re-enter it in Market Config → Providers`);
  }
}

