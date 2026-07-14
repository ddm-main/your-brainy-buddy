// Frontend client for the gmail-* edge functions.
import { authFetch } from "@/lib/authFetch";
import { toUserError } from "@/lib/userError";

const FN = (name: string) => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`;

export class GmailApiError extends Error {
  status: number;
  details?: string;
  hint?: string;
  constructor(message: string, status: number, details?: string, hint?: string) {
    super(message);
    this.name = "GmailApiError";
    this.status = status;
    this.details = details;
    this.hint = hint;
  }
}

async function call<T = any>(name: string, body: unknown): Promise<T> {
  let r: Response;
  try {
    r = await authFetch(FN(name), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    console.error(`gmail.${name} network failure:`, e);
    // `details` retained for the (server-side) log correlation flow — never
    // rendered verbatim in the UI (see EmailAccountsList: message-only).
    throw new GmailApiError("Could not reach the server. Check your connection and try again.", 0, String(e));
  }
  const raw = await r.text();
  let j: any = {};
  try { j = raw ? JSON.parse(raw) : {}; } catch { j = { error: raw }; }
  if (!r.ok) {
    const serverMsg = j?.error ?? j?.message ?? r.statusText ?? "request failed";
    // Scrub URLs / UUIDs / storage paths before it reaches the panel.
    const safe = toUserError(String(serverMsg), "Gmail request failed");
    // Keep raw for the console/log correlation; the UI must not display it.
    console.error(`gmail.${name} ${r.status}:`, raw);
    throw new GmailApiError(safe, r.status, undefined, j?.hint);
  }
  return j as T;
}

export const gmail = {
  startOAuth: (account_id: string) => call<{ url: string }>("gmail-oauth-start", { account_id }),
  sync: (account_id: string, max = 50) => call<{ ok: boolean; inserted: number; total: number }>("gmail-sync", { account_id, max }),
  message: (email_id: string) => call<{ body_text: string | null; body_html: string | null }>("gmail-message", { email_id }),
};
