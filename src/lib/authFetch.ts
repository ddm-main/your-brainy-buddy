// Fetch helper that attaches the current Supabase session token to edge-fn calls.
// Falls back to the publishable key (apikey) so the request still passes the
// PostgREST gateway; edge fns then validate the JWT server-side.

import { supabase, SAFE_SUPABASE_KEY } from "@/integrations/supabase/client";

async function bearer(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function authHeaders(): Promise<Record<string, string>> {
  const token = await bearer();
  const h: Record<string, string> = { apikey: SAFE_SUPABASE_KEY };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const extra = await authHeaders();
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return fetch(input, { ...init, headers });
}
