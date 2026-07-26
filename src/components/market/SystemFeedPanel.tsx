// SystemFeedPanel — visibility (and admin control) over the app-wide
// market-data feed. Prices for every user come from ONE designated Kotak Neo
// connection; personal broker connections are only for account data. This
// panel makes that split explicit so nobody connects a broker hoping to fix
// "delayed prices".
import { useMemo } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { useDesignateSystemFeed, useMarketSettings, useSystemFeed } from "@/lib/market/hooks";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";

export default function SystemFeedPanel() {
  const push = useUi((s) => s.push);
  const { data: feed, isLoading } = useSystemFeed();
  const { data: settings = [] } = useMarketSettings();
  const designate = useDesignateSystemFeed();

  const kotakRows = useMemo(
    () => (settings as any[]).filter((s) => s.active_provider === "kotak_neo"),
    [settings],
  );

  const tone = feed?.healthy ? "ok" : feed?.configured ? "warn" : "neutral";
  const label = isLoading
    ? "checking…"
    : feed?.healthy
    ? "live · kotak"
    : feed?.configured
    ? `degraded · ${feed.status}`
    : "not configured";

  return (
    <HudPanel title="System Price Feed" index="SF" live={feed?.healthy ? "ok" : "warn"}
      actions={<Chip tone={tone as any}>{label}</Chip>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12, color: "var(--text-dim, var(--text-muted))" }}>
        <div>
          Quotes, indices, charts and screener prices are served to every user from one shared
          Kotak Neo connection. You do <b>not</b> need your own broker connected for real-time prices —
          connect below only to trade and to sync your holdings, positions, orders and funds.
        </div>
        {feed?.configured && !feed.designated && (
          <div style={{ color: "var(--warn, #f5a524)" }}>
            No connection is explicitly designated — the app is falling back to the most recently
            updated connected Kotak session, which can change without warning.
          </div>
        )}
        {!feed?.configured && (
          <div style={{ color: "var(--warn, #f5a524)" }}>
            No Kotak Neo connection is designated as the system feed. Designate one below to serve real-time quotes to every user.
          </div>
        )}
        {feed?.last_error && (
          <div style={{ color: "var(--danger, #ef4444)" }}>Last error: {feed.last_error}</div>
        )}
        {feed?.last_sync_at && (
          <div className="hud-label">Last sync {new Date(feed.last_sync_at).toLocaleString()}</div>
        )}

        {feed?.is_admin && kotakRows.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
            <div className="hud-label">Designate the feed connection</div>
            {kotakRows.map((row) => {
              const active = feed?.id === row.id && feed?.designated;
              return (
                <div key={row.id} style={{
                  display: "flex", alignItems: "center", gap: 8,
                  border: "1px solid var(--edge)", padding: "6px 8px", borderRadius: 2,
                }}>
                  <span style={{ flex: 1 }}>{row.ucc ?? row.greeting_name ?? row.id.slice(0, 8)}</span>
                  <Chip tone={row.connection_status === "connected" ? "ok" : "warn"}>{row.connection_status ?? "unknown"}</Chip>
                  {active ? <Chip tone="accent">system feed</Chip> : (
                    <Btn size="sm" disabled={designate.isPending}
                      onClick={async () => {
                        try { await designate.mutateAsync(row.id); push("System feed updated", "ok"); }
                        catch (e) { push(toSafeError(e, "Could not designate feed").message, "err"); }
                      }}>use as feed</Btn>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </HudPanel>
  );
}
