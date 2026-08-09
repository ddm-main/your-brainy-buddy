// SystemFeedPanel — read-only visibility of the app-wide market-data feed on
// the user page. Configuration and designation live in Admin Config → Market
// Config → Providers; users see only whether prices are healthy, so a broker
// account problem is never mistaken for a price-feed problem.
import HudPanel from "@/components/hud/HudPanel";
import { Chip } from "@/components/hud/HudControls";
import { useSystemFeed } from "@/lib/market/hooks";

export default function SystemFeedPanel() {
  const { data: feed, isLoading } = useSystemFeed();

  const tone = feed?.healthy ? "ok" : feed?.configured ? "warn" : "neutral";
  const label = isLoading
    ? "checking…"
    : feed?.healthy
    ? `live · ${feed.provider ?? "broker feed"}`
    : feed?.configured
    ? `degraded · ${feed.status}`
    : "public vendors";

  return (
    <HudPanel title="App Price Feed" index="SF" live={feed?.healthy ? "ok" : "warn"}
      actions={<Chip tone={tone as any}>{label}</Chip>}>
      <div style={{ fontSize: 12, color: "var(--text-dim, var(--text-muted))", lineHeight: 1.6 }}>
        Quotes, indices, charts and screener prices come from the app-wide data feed managed by the
        operator. You do <b>not</b> need your own broker connected for prices — connect below only to
        trade and to sync your holdings, positions, orders and funds.
        {feed?.last_sync_at && (
          <div className="hud-label" style={{ marginTop: 6 }}>
            Last sync {new Date(feed.last_sync_at).toLocaleString()}
          </div>
        )}
      </div>
    </HudPanel>
  );
}
