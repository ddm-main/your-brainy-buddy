// Frontend client for the gmail-* edge functions.
import { authFetch } from "@/lib/authFetch";

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
    throw new GmailApiError(e?.message ?? "network error", 0, String(e));
  }
  const raw = await r.text();
  let j: any = {};
  try { j = raw ? JSON.parse(raw) : {}; } catch { j = { error: raw }; }
  if (!r.ok) {
    const msg = j?.error ?? j?.message ?? r.statusText ?? `${name} failed`;
    throw new GmailApiError(String(msg), r.status, raw || undefined, j?.hint);
  }
  return j as T;
}

export const gmail = {
  startOAuth: (account_id: string) => call<{ url: string }>("gmail-oauth-start", { account_id }),
  sync: (account_id: string, max = 50) => call<{ ok: boolean; inserted: number; total: number }>("gmail-sync", { account_id, max }),
  message: (email_id: string) => call<{ body_text: string | null; body_html: string | null }>("gmail-message", { email_id }),
};
