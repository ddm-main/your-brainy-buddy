import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export interface SlidingWindowLimiter {
  check(uid: string): { ok: true } | { ok: false; retryAfter: number };
}

// In-memory per-isolate sliding window. Each function gets its OWN instance —
// state can't and shouldn't be shared across separately-deployed functions,
// this just extracts jarvis-chat's original inline algorithm into a reusable
// factory so every AI endpoint uses the identical implementation.
export function createSlidingWindowLimiter(max: number, windowMs: number): SlidingWindowLimiter {
  const buckets = new Map<string, number[]>();
  return {
    check(uid: string) {
      const now = Date.now();
      const cutoff = now - windowMs;
      const arr = (buckets.get(uid) ?? []).filter((t) => t > cutoff);
      if (arr.length >= max) {
        const retryAfter = Math.ceil((arr[0] + windowMs - now) / 1000);
        buckets.set(uid, arr);
        return { ok: false, retryAfter: Math.max(1, retryAfter) };
      }
      arr.push(now);
      buckets.set(uid, arr);
      return { ok: true };
    },
  };
}

export interface QuotaResult {
  ok: boolean;
  reason?: string;
  requests: number;
  tokens: number;
}

export interface DailyQuotaOptions {
  endpoint: "chat" | "tts" | "transcribe" | "vision" | "vision_upload" | "finance_summarize";
  requestCap: number;
  tokenCap?: number;
  svc: SupabaseClient;
}

// Durable, DB-backed daily budget — genuinely shared infra, unlike the
// sliding window above. Each endpoint gets its own (user_id, day, endpoint)
// row so continuous STT dictation (polling every ~2.5s) can't exhaust the
// counter that gates legitimate jarvis-chat requests.
export async function checkAndBumpDailyQuota(userId: string, opts: DailyQuotaOptions): Promise<QuotaResult> {
  const { data, error } = await opts.svc.rpc("increment_jarvis_usage", {
    _user_id: userId, _requests: 1, _tokens: 0, _endpoint: opts.endpoint,
  });
  if (error) {
    console.error(`quota rpc failed (${opts.endpoint}):`, error.message);
    return { ok: true, requests: 0, tokens: 0 }; // fail-open on infra error, same as jarvis-chat's original behavior
  }
  const row = Array.isArray(data) ? data[0] : data;
  const requests = Number(row?.requests ?? 0);
  const tokens = Number(row?.tokens ?? 0);
  if (requests > opts.requestCap) return { ok: false, reason: "daily_request_cap", requests, tokens };
  if (opts.tokenCap && tokens > opts.tokenCap) return { ok: false, reason: "daily_token_cap", requests, tokens };
  return { ok: true, requests, tokens };
}

export async function addTokenUsage(svc: SupabaseClient, userId: string, endpoint: string, tokens: number): Promise<void> {
  if (!tokens || tokens <= 0) return;
  try {
    await svc.rpc("increment_jarvis_usage", { _user_id: userId, _requests: 0, _tokens: tokens, _endpoint: endpoint });
  } catch (e) {
    console.error("token bump failed:", e instanceof Error ? e.message : String(e));
  }
}
