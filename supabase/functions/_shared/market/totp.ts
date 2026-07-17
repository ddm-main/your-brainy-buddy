// RFC-6238 TOTP (SHA-1, 6 digits, 30s step) via WebCrypto.
// Pure — no Deno/npm imports — so vitest can exercise it directly.

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function hmacSha1(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, msg as unknown as ArrayBuffer);
  return new Uint8Array(sig);
}

export async function totp(
  secretBase32: string,
  opts: { timeMs?: number; stepSeconds?: number; digits?: number } = {},
): Promise<string> {
  const timeMs = opts.timeMs ?? Date.now();
  const step = opts.stepSeconds ?? 30;
  const digits = opts.digits ?? 6;
  const counter = Math.floor(timeMs / 1000 / step);

  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }

  const key = base32Decode(secretBase32);
  const hash = await hmacSha1(key, msg);
  const offset = hash[hash.length - 1] & 0x0f;
  const code =
    (((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      (hash[offset + 3] & 0xff)) %
    10 ** digits;
  return String(code).padStart(digits, "0");
}
