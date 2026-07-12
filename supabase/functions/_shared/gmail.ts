// Shared Gmail helpers: token refresh + parsing.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export function svcClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
}

export async function ensureAccessToken(svc: SupabaseClient, account: any): Promise<string> {
  const now = Date.now();
  const exp = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (account.access_token && exp - 60_000 > now) return account.access_token;
  if (!account.refresh_token) throw new Error("no refresh_token — reconnect Gmail");

  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: account.refresh_token, grant_type: "refresh_token" }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`token refresh failed: ${j.error_description || j.error}`);
  const newExp = new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000).toISOString();
  await svc.from("email_accounts").update({ access_token: j.access_token, token_expires_at: newExp }).eq("id", account.id);
  return j.access_token;
}

export async function gapi(token: string, path: string): Promise<any> {
  const res = await fetch(`https://gmail.googleapis.com${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`gmail ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export function parseHeaders(headers: { name: string; value: string }[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) out[h.name.toLowerCase()] = h.value;
  return out;
}

export function parseFrom(v: string | undefined): { name: string | null; email: string | null } {
  if (!v) return { name: null, email: null };
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim() };
  return { name: null, email: v.trim() };
}

function b64urlToText(s: string): string {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  try {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch { return ""; }
}

export function extractBody(payload: any): { text: string | null; html: string | null } {
  let text: string | null = null;
  let html: string | null = null;
  const walk = (p: any) => {
    if (!p) return;
    const mime = p.mimeType || "";
    const data = p.body?.data;
    if (data && mime === "text/plain" && !text) text = b64urlToText(data);
    else if (data && mime === "text/html" && !html) html = b64urlToText(data);
    if (p.parts) for (const c of p.parts) walk(c);
  };
  walk(payload);
  return { text, html };
}

export interface GmailAttachmentMeta { attachmentId: string; filename: string; mimeType: string; size: number }

// Walk the message payload for parts that have both a filename and an
// attachmentId — the analogous walk to extractBody(), but collecting real
// attachments (statement PDFs) instead of inline text/html.
export function listAttachments(payload: any): GmailAttachmentMeta[] {
  const out: GmailAttachmentMeta[] = [];
  const walk = (p: any) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) {
      out.push({
        attachmentId: p.body.attachmentId,
        filename: p.filename,
        mimeType: p.mimeType ?? "",
        size: p.body.size ?? 0,
      });
    }
    if (p.parts) for (const c of p.parts) walk(c);
  };
  walk(payload);
  return out;
}

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function downloadAttachment(token: string, messageId: string, attachmentId: string): Promise<Uint8Array> {
  const res = await gapi(token, `/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`);
  return b64urlToBytes(res.data);
}
