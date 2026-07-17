// Client-side mirror of the edge functions' sanitizeError: a raw
// PostgrestError (constraint names, column detail) should never reach a
// toast verbatim. Full detail still goes to the browser devtools console —
// for a single-developer app that's exactly as reachable as server logs.
export function toSafeError(err: unknown, publicMessage: string): Error {
  console.error(publicMessage + ":", err);
  const code = (err as { code?: string } | null)?.code;
  if (code === "23505") return new Error(`${publicMessage} — that value is already in use.`);
  // Our edge functions return an already-sanitized `{ error: msg }`, which
  // callFn rethrows as a plain Error. Surface that reason instead of swallowing
  // it — a bare "Login failed" is useless for diagnosing broker/API problems.
  // Raw PostgrestErrors (objects with a `.code`, not Error instances) still
  // fall through to the generic message so SQL detail never reaches a toast.
  if (err instanceof Error) {
    const msg = err.message.trim();
    if (msg && msg.toLowerCase() !== "failed to fetch") {
      return new Error(`${publicMessage}: ${msg}`);
    }
    if (msg.toLowerCase() === "failed to fetch") {
      return new Error(`${publicMessage} — network error reaching the server.`);
    }
  }
  return new Error(publicMessage);
}
