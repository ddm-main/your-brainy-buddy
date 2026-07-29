// Shared helpers for the Providers section.
import { SAFE_SUPABASE_URL } from "@/lib/supabaseSafe";
import { authFetch } from "@/lib/authFetch";

export function ago(ts: string | null | undefined): string {
  if (!ts) return "";
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Broker error pages come back as raw HTML — keep the readable part only. */
export function clean(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const text = detail.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 197)}…` : text || null;
}

export async function callCreds(body: Record<string, unknown>) {
  const r = await authFetch(`${SAFE_SUPABASE_URL}/functions/v1/market-provider-credentials`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(j?.error ?? r.statusText);
  return j;
}

export type SurfaceState = "ok" | "degraded" | "failed";
export type SurfaceResult = {
  ok: boolean;
  /** New three-state signal; older payloads only carry `ok`. */
  state?: SurfaceState;
  provider_used: string;
  detail: string;
  checked_at?: string;
};
export type SurfaceReport = Record<string, SurfaceResult>;

export async function callTest(body: Record<string, unknown>) {
  const r = await authFetch(`${SAFE_SUPABASE_URL}/functions/v1/market-test-connection`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return (await r.json().catch(() => ({}))) as Record<string, unknown>;
}

export type CredRow = {
  provider: string; key_set: boolean; key_hint: string | null;
  last_tested_at: string | null; last_test_ok: boolean | null; last_test_detail: string | null;
  updated_at: string | null;
};

export type HealthRow = { provider: string; ok: boolean; error: string | null; created_at: string };
