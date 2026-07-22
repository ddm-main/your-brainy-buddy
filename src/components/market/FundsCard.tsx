// FundsCard — Kotak Neo account balance snapshot with a manual refresh button.
// Shows a "connect broker" nudge when no Kotak session, and a "stale" banner
// when the edge function returned a cached row after a live-fetch failure.
import { Link } from "react-router-dom";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn } from "@/components/hud/HudControls";
import { RefreshCw } from "lucide-react";
import { useFunds } from "@/lib/market/orderHooks";

const inr = (n: number | null | undefined) =>
  n == null ? "—" : `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n)}`;

export function FundsCard({ compact = false }: { compact?: boolean }) {
  const { data, isFetching, refresh } = useFunds();
  const funds = data?.funds ?? null;
  const source = data?.source ?? "unknown";

  if (source === "unavailable") {
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
  const items = [
    { label: "Available", value: funds?.available_margin, tone: "ok" as const },
    { label: "Used", value: funds?.used_margin },
    { label: "Net Cash", value: funds?.net_cash },
    { label: "Collateral", value: funds?.collateral },
  ];

  return (
    <HudPanel flow title="Funds" index="MK.FN" actions={
      <Btn size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending || isFetching}>
        <RefreshCw size={11} style={{ marginRight: 4 }} /> {refresh.isPending || isFetching ? "refreshing…" : "refresh"}
      </Btn>
    }>
      {stale && (
        <div className="hud-label" style={{ color: "var(--warn)", marginBottom: 8 }}>
          Live fetch failed — showing last snapshot. {data?.error ? `(${data.error})` : ""}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: compact ? "repeat(2, 1fr)" : "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
        {items.map((it) => (
          <div key={it.label} style={{ padding: 8, border: "1px solid var(--edge)", borderRadius: 3 }}>
            <div className="hud-label" style={{ color: "var(--text-dim)" }}>{it.label}</div>
            <div style={{ fontSize: compact ? 14 : 16, color: it.tone === "ok" && (it.value ?? 0) > 0 ? "var(--ok)" : "var(--text)", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
              {inr(it.value)}
            </div>
          </div>
        ))}
      </div>
      {funds?.synced_at && (
        <div className="hud-label" style={{ color: "var(--text-dim)", marginTop: 8 }}>
          Synced {new Date(funds.synced_at).toLocaleTimeString()}
        </div>
      )}
    </HudPanel>
  );
}
