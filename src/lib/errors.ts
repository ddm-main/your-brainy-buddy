// Client-side mirror of the edge functions' sanitizeError: a raw
// PostgrestError (constraint names, column detail) should never reach a
// toast verbatim. Full detail still goes to the browser devtools console —
// for a single-developer app that's exactly as reachable as server logs.
export function toSafeError(err: unknown, publicMessage: string): Error {
  console.error(publicMessage + ":", err);
  const code = (err as { code?: string } | null)?.code;
  if (code === "23505") return new Error(`${publicMessage} — that value is already in use.`);
  return new Error(publicMessage);
}
