// Central mapper: turns any thrown error into a short, user-safe string.
// Strips edge-function URLs, Supabase project hosts, UUIDs, storage paths,
// and stack traces before the message reaches a toast or error panel. Full
// detail still goes to the devtools console.

const SUPABASE_HOST_RE = /https?:\/\/[a-z0-9-]+\.supabase\.co[^\s"']*/gi;
const EDGE_FN_PATH_RE = /\/functions\/v1\/[a-z0-9-]+/gi;
const STORAGE_PATH_RE = /\/storage\/v1\/[^\s"']+/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const AUTHORIZATION_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

// Errors returned by sanitizeError already look like "Something failed (ref abcd1234)".
// Preserve the ref suffix for support diagnostics while dropping everything else.
const REF_RE = /\(ref [0-9a-f]{6,10}\)/i;

/** Sanitize an arbitrary error/message into a short public string. */
export function toUserError(err: unknown, fallback = "Something went wrong"): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!raw) return fallback;
  let s = raw
    .replace(SUPABASE_HOST_RE, "")
    .replace(EDGE_FN_PATH_RE, "")
    .replace(STORAGE_PATH_RE, "")
    .replace(AUTHORIZATION_RE, "$1***")
    .replace(UUID_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  // Discard raw JSON blobs / stack-trace fragments that leaked through.
  if (s.startsWith("{") || s.startsWith("[") || /\n\s+at\s/.test(raw)) s = fallback;
  if (s.length > 200) s = s.slice(0, 197) + "…";
  const refMatch = raw.match(REF_RE);
  if (refMatch && !s.includes(refMatch[0])) s = `${s || fallback} ${refMatch[0]}`;
  return s || fallback;
}

/** Convenience: log the raw error to the console, return sanitized copy for UI. */
export function reportError(err: unknown, fallback?: string): string {
  // eslint-disable-next-line no-console
  console.error(fallback ?? "error:", err);
  return toUserError(err, fallback);
}