// Single entry point for market edge-function calls.
import { SAFE_SUPABASE_URL } from "@/integrations/supabase/client";
import { authFetch } from "@/lib/authFetch";

export async function callMarketFn<T = any>(name: string, body: Record<string, unknown> = {}): Promise<T> {
  const url = `${SAFE_SUPABASE_URL}/functions/v1/${name}`;
  const r = await authFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error ?? r.statusText);
  return j as T;
}
