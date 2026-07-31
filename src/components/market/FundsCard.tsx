// FundsCard — Kotak Neo account balance snapshot with a manual refresh button.
// Renders the full industry-standard breakdown (Available / Used / Cash /
// Collateral / SPAN / Exposure / Realized / Unrealized) when the extended
// fields are present, and falls back to the classic 4-tile grid otherwise.
// State handling:
//  - `not_connected` (never had a session) → "Connect broker" CTA (no data).
//  - live snapshot fresh → normal grid.
//  - `session_expired` / `rate_limited` / `upstream_down` → grid with a
//    banner using the appropriate copy + reconnect link when relevant.
import { Link } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn } from "@/components/hud/HudControls";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useFunds, type FundsReasonCode } from "@/lib/market/orderHooks";

const inr = (n: number | null | undefined) =>
  n == null ? "—" : `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n)}`;

function formatSyncedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatRetry(iso: string | null | undefined, fallbackSeconds?: number): string | null {
  if (iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (Number.isFinite(ms) && ms > 0) return `${Math.ceil(ms / 1000)}s`;
  }
  if (fallbackSeconds && fallbackSeconds > 0) return `${Math.ceil(fallbackSeconds)}s`;
  return null;
}

function reasonCopy(code: FundsReasonCode | undefined, fallback: string | undefined): { message: string; showReconnect: boolean } {
  switch (code) {
    case "session_expired":
      return { message: "Broker session expired — reconnect to refresh", showReconnect: true };
    case "rate_limited":
      return { message: "Broker rate limit hit — retrying shortly", showReconnect: false };
    case "upstream_down":
      return { message: "Broker margin service is temporarily unavailable", showReconnect: false };
    case "not_connected":
      return { message: "Connect Kotak Neo to see live margin", showReconnect: true };
    default:
      return { message: fallback ?? "Live margin unavailable", showReconnect: false };
  }
}

export function FundsCard({ compact = false }: { compact?: boolean }) {
  const { data, isFetching, refresh } = useFunds();
  const funds = data?.funds ?? null;
  const source = data?.source ?? "unknown";
  const reasonCode = data?.reason_code as FundsReasonCode | undefined;
  const notConnected = data?.not_connected === true || reasonCode === "not_connected";

  // Live-tick countdown so the retry timer visibly decrements. 1s cadence.
  // Stops itself the moment the cooldown expires — it used to keep ticking
  // (and re-rendering the whole card) forever after the window passed.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!data?.retry_after_at) return;
    const endsAt = new Date(data.retry_after_at).getTime();
    if (!Number.isFinite(endsAt) || endsAt <= Date.now()) return;
    const id = setInterval(() => {
      setNow((n) => n + 1);
      if (Date.now() >= endsAt) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [data?.retry_after_at]);

  const retryMs = data?.retry_after_at ? new Date(data.retry_after_at).getTime() - Date.now() : 0;
  const cooling = retryMs > 0;

  // "Not connected AND no cached snapshot" — first-time / never-linked state.
  if (notConnected && !funds) {
    return (
      <HudPanel flow title="Funds" index="MK.FN">
        <div className="hud-label" style={{ color: "var(--text-dim)", marginBottom: 8 }}>
          Live margin needs a Kotak Neo connection.
        </div>
        <Link to="/market/settings"><Btn size="sm">Connect broker</Btn></Link>
      </HudPanel>
    );
  }

  const stale = source === "stale";
  const liveFailed = source === "unavailable" && !notConnected;
  const showBanner = stale || liveFailed || (notConnected && !!funds);
  const { message, showReconnect } = reasonCopy(reasonCode, data?.reason);
  const staleTime = formatSyncedAt(data?.stale_since ?? funds?.synced_at);
  const retryIn = formatRetry(data?.retry_after_at, data?.retry_after);

  // Tile set: prefer richer breakdown when Kotak surfaced extended fields.
  const hasExtended = funds && (
    funds.cash_balance != null ||
    funds.span_margin != null ||
    funds.exposure_margin != null ||
    funds.realized_mtm != null ||
    funds.unrealized_mtm != null
  );
  const items = hasExtended ? [
    { label: "Cash balance", value: funds?.cash_balance ?? funds?.net_cash },
    { label: "Margin from shares", value: funds?.collateral },
    { label: "Used margin", value: funds?.used_margin, tone: "warn" as const },
    { label: "Available margin", value: funds?.available_margin, tone: "ok" as const },
    { label: "Available for options", value: funds?.payin_amount ?? funds?.payout_amount },
    { label: "SPAN", value: funds?.span_margin, mute: true },
    { label: "Exposure", value: funds?.exposure_margin, mute: true },
    { label: "Realized (today)", value: funds?.realized_mtm, tone: (funds?.realized_mtm ?? 0) >= 0 ? "ok" as const : "err" as const },
    { label: "Unrealized M2M", value: funds?.unrealized_mtm, tone: (funds?.unrealized_mtm ?? 0) >= 0 ? "ok" as const : "err" as const },
  ] : [
    { label: "Cash balance", value: funds?.net_cash },
    { label: "Margin from shares", value: funds?.collateral },
    { label: "Used margin", value: funds?.used_margin, tone: "warn" as const },
    { label: "Available margin", value: funds?.available_margin, tone: "ok" as const },
    { label: "Payin", value: funds?.payin_amount, mute: true },
  ];
  const visible = items.filter((it) => it.value != null || !it.mute);

  return (
    <HudPanel flow title="Funds" index="MK.FN" actions={
      <Btn size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending || isFetching || cooling}>
        <RefreshCw size={11} style={{ marginRight: 4 }} />
        {refresh.isPending || isFetching ? "refreshing…" : cooling && retryIn ? `retry in ${retryIn}` : "refresh"}
      </Btn>
    }>
      {showBanner && (
        <div className="hud-label" style={{ color: "var(--warn, var(--text-dim))", marginBottom: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span>
            {message}
            {staleTime ? ` — snapshot ${staleTime}` : funds ? "" : retryIn ? ` — retry in ${retryIn}` : " — no snapshot yet"}.
          </span>
          {showReconnect && (
            <Link to="/market/settings" style={{ color: "var(--accent)", textDecoration: "none" }}>
              Broker settings →
            </Link>
          )}
        </div>
      )}
      {!funds && !notConnected && (
        <div style={{ border: "1px dashed var(--edge)", padding: 12, marginBottom: 8 }}>
          <div className="hud-label" style={{ color: "var(--text-dim)", marginBottom: 8 }}>
            {retryIn ? `Waiting ${retryIn} before the next broker retry.` : "Waiting for the first broker snapshot."}
          </div>
          {reasonCode === "rate_limited" && (
            <div className="hud-label" style={{ color: "var(--text-dim)", marginBottom: 8, fontSize: 10 }}>
              Kotak's margin endpoint is unstable — snapshot will appear on next successful fetch.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }} aria-hidden>
            {[0, 1, 2, 3].map((i) => <div key={i} style={{ height: 34, border: "1px solid var(--edge)", opacity: 0.35 }} />)}
          </div>
        </div>
      )}
      {funds && <div style={{ display: "grid", gridTemplateColumns: compact ? "repeat(2, 1fr)" : "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
        {visible.map((it) => (
          <div key={it.label} style={{ padding: 8, border: "1px solid var(--edge)", borderRadius: 3 }}>
            <div className="hud-label" style={{ color: "var(--text-dim)" }}>{it.label}</div>
            <div style={{ fontSize: compact ? 14 : 16, color: it.value != null && it.tone === "ok" && it.value > 0 ? "var(--ok)" : it.value != null && it.tone === "err" && it.value < 0 ? "var(--danger, var(--err))" : "var(--text)", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
              {inr(it.value)}
            </div>
          </div>
        ))}
      </div>}
      {funds?.synced_at && !showBanner && (
        <div className="hud-label" style={{ color: "var(--text-dim)", marginTop: 8 }}>
          Synced {new Date(funds.synced_at).toLocaleTimeString()}
        </div>
      )}
    </HudPanel>
  );
}
