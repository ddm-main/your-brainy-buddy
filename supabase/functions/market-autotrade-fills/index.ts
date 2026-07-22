// market-autotrade-fills — 1-min cron during IST market hours. Reads every
// AutoTrade order still marked "placed"/"partial" with a broker_order_id and
// asks the user's Kotak account for its current status + fill price, then
// writes it back to market_autotrade_orders. Without this, orders sent to
// Kotak stayed "placed" forever, which corrupted the circuit-breaker P&L,
// duplicate-fire guard, and history — see autotradeReconcile.ts header.
//
// Read-only against Kotak; writes are confined to our own ledger.
import { preflight, jsonResponse, errorResponse, svcClient } from "../_shared/market/common.ts";
import { requireCronSecret, istTradeDate, isTradingHoliday } from "../_shared/market/cron.ts";
import { getActiveProvider } from "../_shared/market/provider.ts";
import { withKotakSession, KOTAK_SETTINGS_COLS, type KotakSettings } from "../_shared/market/kotakClient.ts";
import { encryptStatementPassword } from "../_shared/crypto.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const encryptValue = async (v: string): Promise<string> =>
  JSON.stringify(await encryptStatementPassword(v));

function marketOpenNow(): boolean {
  const d = new Date();
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  const day = ist.getUTCDay(); if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  // Extend 30 min past close so late fills settle into the ledger.
  return mins >= 9 * 60 + 15 && mins <= 16 * 60;
}

// Normalize Kotak status strings into our ledger enum.
function normalizeKotakStatus(s: string): "filled" | "cancelled" | "rejected" | "partial" | "placed" {
  const t = (s || "").toLowerCase();
  if (t.includes("complete") || t.includes("filled") || t === "fill" || t === "traded") return "filled";
  if (t.includes("cancel")) return "cancelled";
  if (t.includes("reject")) return "rejected";
  if (t.includes("partial")) return "partial";
  return "placed";
}

// Kotak /quick/user/orders returns a list. Field names vary; try common spellings.
async function kotakOrderBook(s: KotakSettings): Promise<any[]> {
  const editToken = await (async () => {
    // decrypt session token via crypto's mirror of what sessionHeaders would do
    // — reuse the sessionHeaders helper indirectly by calling kotakFetch here.
    // Simplest: hit the endpoint directly.
    return null;
  })().catch(() => null);
  // Fall through: call via withKotakSession using a lightweight direct fetch
  return [];
}

async function fetchOrderBook(svc: SupabaseClient, settings: KotakSettings): Promise<any[]> {
  // Delegate to kotakClient's sessioned fetch by importing the raw fetch
  // helper via a local minimal request. To avoid duplicating decrypt logic
  // we reuse withKotakSession + a direct fetch to /quick/user/orders.
  const doFetch = async (s: KotakSettings) => {
    // sessionHeaders lives inside kotakClient.ts and isn't exported; build
    // headers here from the encrypted session fields.
    const { decryptStatementPassword } = await import("../_shared/crypto.ts");
    const editToken = s.session_token_enc
      ? await decryptStatementPassword(JSON.parse(s.session_token_enc))
      : null;
    if (!editToken || !s.sid || !s.consumer_key || !s.base_url) return [];
    const base = s.base_url.replace(/\/+$/, "");
    const r = await fetch(`${base}/quick/user/orders`, {
      headers: {
        Authorization: s.consumer_key,
        Auth: editToken,
        Sid: s.sid,
        accept: "application/json",
      },
    });
    if (!r.ok) throw new Error(`Kotak order book HTTP ${r.status}`);
    const j = await r.json().catch(() => ({}));
    const d = j?.data ?? j ?? [];
    return Array.isArray(d) ? d : [d].filter(Boolean);
  };
  return withKotakSession(svc, settings, encryptValue, doFetch);
}

function pickOrderId(o: any): string {
  return String(o?.nOrdNo ?? o?.orderId ?? o?.order_id ?? o?.OrdNo ?? "");
}
function pickStatus(o: any): string {
  return String(o?.ordSt ?? o?.status ?? o?.stat ?? o?.OrdSt ?? "");
}
function pickAvgPrice(o: any): number | null {
  const raw = o?.avgPrc ?? o?.averagePrice ?? o?.filledPrice ?? o?.avgPrice ?? o?.prc ?? null;
  const n = typeof raw === "string" ? parseFloat(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
function pickFilledAt(o: any): string | null {
  const raw = o?.exchTs ?? o?.exchTime ?? o?.updateTime ?? o?.filledAt ?? null;
  if (!raw) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  const d = Number.isFinite(n) ? new Date(n > 9_999_999_999 ? n : n * 1000) : new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const gate = await requireCronSecret(req); if (gate) return gate;
  try {
    if (!marketOpenNow()) return jsonResponse(req, { ok: true, note: "market_closed" });
    const svc = svcClient();
    if (await isTradingHoliday(svc, istTradeDate())) return jsonResponse(req, { ok: true, note: "market_closed_holiday" });

    // One row per user with any outstanding placed/partial order that has a broker id.
    const { data: pending } = await svc.from("market_autotrade_orders")
      .select("id,user_id,broker_order_id,status,leg,symbol,exchange")
      .in("status", ["placed", "partial"])
      .not("broker_order_id", "is", null)
      .limit(1000);
    if (!pending?.length) return jsonResponse(req, { ok: true, updated: 0, users: 0 });

    const byUser = new Map<string, typeof pending>();
    for (const p of pending) {
      const arr = byUser.get(p.user_id) ?? [];
      arr.push(p); byUser.set(p.user_id, arr);
    }

    let updated = 0, users = 0, errored = 0;
    for (const [userId, orders] of byUser) {
      users++;
      try {
        const { provider, settings } = await getActiveProvider(svc, userId);
        if (provider.name !== "kotak_neo" || !settings || settings.connection_status !== "connected") continue;
        const book = await fetchOrderBook(svc, settings as KotakSettings);
        const byId = new Map<string, any>();
        for (const b of book) {
          const id = pickOrderId(b);
          if (id) byId.set(id, b);
        }
        const nowIso = new Date().toISOString();
        for (const our of orders) {
          const remote = byId.get(String(our.broker_order_id));
          if (!remote) {
            // Broker doesn't know this order id anymore. Leave as-is; wait for
            // manual reconciliation rather than guessing a status.
            await svc.from("market_autotrade_orders")
              .update({ last_broker_sync_at: nowIso }).eq("id", our.id);
            continue;
          }
          const status = normalizeKotakStatus(pickStatus(remote));
          const avg = pickAvgPrice(remote);
          const filledAt = status === "filled" ? (pickFilledAt(remote) ?? nowIso) : null;
          const patch: Record<string, unknown> = { status, last_broker_sync_at: nowIso };
          if (avg != null) patch.filled_price = avg;
          if (filledAt) patch.filled_at = filledAt;
          const { error } = await svc.from("market_autotrade_orders")
            .update(patch).eq("id", our.id);
          if (!error) updated++;
        }
      } catch (e) {
        errored++;
        await svc.from("market_autotrade_log").insert({
          user_id: userId, level: "error",
          message: `Fills reconciler failed: ${e instanceof Error ? e.message : String(e)}`,
        }).then(() => {}, () => {});
      }
    }

    return jsonResponse(req, { ok: true, users, updated, errored, checked: pending.length });
  } catch (e) {
    return errorResponse(req, e instanceof Error ? e.message : String(e), 500);
  }
});
