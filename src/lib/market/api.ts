// Single entry point for market edge-function calls.
import { SAFE_SUPABASE_URL } from "@/lib/supabaseSafe";
import { authFetch } from "@/lib/authFetch";

export class MarketFunctionError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly sessionExpired: boolean;
  readonly retryable: boolean;
  readonly verificationRequired: boolean;

  constructor(message: string, status: number, payload: Record<string, unknown>) {
    super(message);
    this.name = "MarketFunctionError";
    this.status = status;
    this.code = typeof payload.code === "string" ? payload.code : undefined;
    this.sessionExpired = payload.session_expired === true;
    this.retryable = payload.retryable !== false;
    this.verificationRequired = payload.verification_required === true;
  }
}

export async function callMarketFn<T = any>(name: string, body: Record<string, unknown> = {}): Promise<T> {
  const url = `${SAFE_SUPABASE_URL}/functions/v1/${name}`;
  const r = await authFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j: Record<string, unknown> = await r.json().catch(() => ({}));
  if (!r.ok) {
    const message = typeof j.error === "string" ? j.error : r.statusText;
    throw new MarketFunctionError(message, r.status, j);
  }
  return j as T;
}
