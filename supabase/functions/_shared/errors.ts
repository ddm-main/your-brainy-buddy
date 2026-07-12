// Every edge function already does console.error(...) with full exception
// detail server-side (correct — inspectable via the Supabase dashboard or
// the get_logs MCP tool). The bug this fixes is what ALSO gets sent back to
// the browser: today it's the raw exception message, which can be a
// Postgres constraint name, an internal path, or an upstream API's raw
// JSON body. sanitizeError() keeps the console.error, and returns a short,
// generic, call-site-authored public message instead, plus an 8-char
// correlation ref so a specific failure is easy to find in the logs even
// with several errors close together in time.

export interface SafeErrorBody {
  error: string;
  ref: string;
}

export function sanitizeError(err: unknown, publicMessage: string, logContext: string): SafeErrorBody {
  const ref = crypto.randomUUID().slice(0, 8);
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`${logContext} [ref ${ref}]:`, detail);
  return { error: `${publicMessage} (ref ${ref})`, ref };
}

// Convenience for the common "500 JSON error response" shape.
export function sanitizedErrorResponse(
  err: unknown,
  publicMessage: string,
  logContext: string,
  cors: Record<string, string>,
  status = 500,
): Response {
  const body = sanitizeError(err, publicMessage, logContext);
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
