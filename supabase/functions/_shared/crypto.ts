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

async function keyFromSecret(): Promise<CryptoKey> {
  const secret = Deno.env.get("STATEMENT_ENC_SECRET");
  if (!secret) throw new Error("STATEMENT_ENC_SECRET not configured");
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
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
  return new TextDecoder().decode(pt);
}
