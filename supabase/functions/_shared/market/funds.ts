// Shared funds snapshot/cooldown helper for market edge functions.
// Kotak's limits endpoint can return hard 429/5xx bursts. Centralizing the
// cooldown prevents Funds + Holdings sync + Positions sync from hammering it.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { FundsSnapshot, MarketProvider } from "./provider.ts";

export type FundsReasonCode = "not_connected" | "session_expired" | "rate_limited" | "upstream_down" | "unknown";

type CachedFunds = {
  user_id: string;
  net_cash: number | null;
  available_margin: number | null;
  used_margin: number | null;
  collateral: number | null;
  payin_amount: number | null;
  payload: any;
  synced_at: string | null;
};

export type FundsRefreshResult = {
  funds: (CachedFunds & {
    cash_balance?: number | null;
    payout_amount?: number | null;
    span_margin?: number | null;
    exposure_margin?: number | null;
    realized_mtm?: number | null;
    unrealized_mtm?: number | null;
  }) | null;
  source: "kotak" | "stale" | "unavailable";
  stale_since: string | null;
  reason?: string;
  reason_code?: FundsReasonCode;
  retry_after?: number;
  retry_after_at?: string | null;
  not_connected?: boolean;
};

export function classifyFundsError(e: unknown): { code: FundsReasonCode; message: string; retryMs: number } {
  const status = (e as any)?.status;
  const msg = e instanceof Error ? e.message : String(e);
  if (typeof status === "number") {
    if (status === 401 || status === 403) return { code: "session_expired", message: "Broker session expired — reconnect to refresh", retryMs: 0 };
    if (status === 429) return { code: "rate_limited", message: "Broker rate limit hit — retrying shortly", retryMs: 90_000 };
    if (status >= 500) return { code: "upstream_down", message: "Broker margin service is temporarily unavailable", retryMs: 20_000 };
  }
  if (/rate.?limit|too many/i.test(msg)) return { code: "rate_limited", message: "Broker rate limit hit — retrying shortly", retryMs: 90_000 };
  return { code: "unknown", message: msg || "Live margin unavailable", retryMs: 20_000 };
}

function expandCached(row: CachedFunds | null | undefined): FundsRefreshResult["funds"] {
  if (!row) return null;
  const extended = row.payload?.extended ?? {};
  return { ...row, ...extended };
}

function snapshotRow(userId: string, snap: FundsSnapshot) {
  const extended = {
    cash_balance: snap.cash_balance ?? null,
    payout_amount: snap.payout_amount ?? null,
    span_margin: snap.span_margin ?? null,
    exposure_margin: snap.exposure_margin ?? null,
    realized_mtm: snap.realized_mtm ?? null,
    unrealized_mtm: snap.unrealized_mtm ?? null,
  };
  return {
    user_id: userId,
    net_cash: snap.net_cash,
    available_margin: snap.available_margin,
    used_margin: snap.used_margin,
    collateral: snap.collateral,
    payin_amount: snap.payin_amount,
    payload: { extended, raw: snap.raw ?? null } as any,
    synced_at: new Date().toISOString(),
  };
}

async function readCachedFunds(svc: SupabaseClient, userId: string): Promise<CachedFunds | null> {
  const { data } = await svc.from("market_funds").select("*").eq("user_id", userId).maybeSingle();
  return (data as CachedFunds | null) ?? null;
}

export async function refreshFundsSnapshot(opts: {
  svc: SupabaseClient;
  userId: string;
  settingsId?: string | null;
  provider: MarketProvider;
  respectCooldown?: boolean;
}): Promise<FundsRefreshResult> {
  const { svc, userId, settingsId, provider, respectCooldown = true } = opts;
  const cached = await readCachedFunds(svc, userId);

  if (provider.name !== "kotak_neo") {
    return {
      funds: expandCached(cached),
      source: cached ? "stale" : "unavailable",
      not_connected: true,
      reason_code: "not_connected",
      reason: "Connect Kotak Neo to see live margin",
      stale_since: cached?.synced_at ?? null,
    };
  }

  // Cold-start bypass — if no snapshot has ever succeeded, ignore the cooldown
  // once so a manual refresh isn't stuck waiting on a stale error window.
  const hasEverSnapshotted = !!cached?.synced_at;
  if (respectCooldown && settingsId && hasEverSnapshotted) {
    const { data: settings } = await svc
      .from("market_api_settings")
      .select("funds_retry_after_at,funds_last_error_code")
      .eq("id", settingsId)
      .maybeSingle();
    const retryAt = settings?.funds_retry_after_at ? new Date(settings.funds_retry_after_at).getTime() : 0;
    if (retryAt > Date.now()) {
      const retryAfter = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
      const code = (settings?.funds_last_error_code as FundsReasonCode | null) ?? "rate_limited";
      const message = code === "rate_limited"
        ? "Broker rate limit hit — retrying shortly"
        : code === "upstream_down"
          ? "Broker margin service is temporarily unavailable"
          : "Live margin temporarily paused";
      return {
        funds: expandCached(cached),
        source: cached ? "stale" : "unavailable",
        stale_since: cached?.synced_at ?? null,
        reason: message,
        reason_code: code,
        retry_after: retryAfter,
        retry_after_at: settings?.funds_retry_after_at ?? null,
      };
    }
  }

  if (settingsId) {
    await svc.from("market_api_settings").update({ funds_last_attempt_at: new Date().toISOString() }).eq("id", settingsId);
  }

  try {
    const snap = await provider.getFunds();
    const row = snapshotRow(userId, snap);
    await svc.from("market_funds").upsert(row, { onConflict: "user_id" });
    if (settingsId) {
      await svc.from("market_api_settings")
        .update({ funds_last_error_code: null, funds_retry_after_at: null })
        .eq("id", settingsId);
    }
    return { funds: expandCached(row as CachedFunds), source: "kotak", stale_since: null };
  } catch (e) {
    const { code, message, retryMs } = classifyFundsError(e);
    const retryAfterAt = retryMs > 0 ? new Date(Date.now() + retryMs).toISOString() : null;
    if (settingsId) {
      await svc.from("market_api_settings")
        .update({ funds_last_error_code: code, funds_retry_after_at: retryAfterAt })
        .eq("id", settingsId);
    }
    return {
      funds: expandCached(cached),
      source: cached ? "stale" : "unavailable",
      stale_since: cached?.synced_at ?? null,
      reason: message,
      reason_code: code,
      retry_after: retryAfterAt ? Math.ceil(retryMs / 1000) : undefined,
      retry_after_at: retryAfterAt,
    };
  }
}