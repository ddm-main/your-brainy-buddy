import { describe, expect, it } from "vitest";
import { tallyRows, feedFreshness, statusForFeed, type FeedRow, type Status } from "../src/lib/market/feedStatus";
import type { RoutedFeed } from "../src/components/config/providers/feedCatalog";

const row = (id: string, status: Status, perUser = false): FeedRow => ({
  f: { id, label: id, desc: id, group: perUser ? "account" : "live", chain: ["kotak"], perUser } as RoutedFeed,
  status,
  detail: "",
  servedBy: "",
  health: "",
  primaryProbe: null,
  chainHealth: [],
  autoSwitched: false,
  checkedAt: null,
});

describe("feed health tallies", () => {
  it("counts live, cached, fallback, and intentional idle as healthy", () => {
    const tally = tallyRows([row("live", "LIVE"), row("c", "CACHED"), row("fallback", "FALLBACK"), row("idle", "IDLE")]);
    expect(tally).toMatchObject({ total: 4, ok: 4, live: 1, cached: 1, fallback: 1, idle: 1, down: 0 });
  });

  it("keeps platform and account failures in separate scopes", () => {
    const rows = [row("quote", "LIVE"), row("funds", "DOWN", true), row("orders", "IDLE", true)];
    expect(tallyRows(rows, "platform")).toMatchObject({ total: 1, ok: 1, down: 0 });
    expect(tallyRows(rows, "account")).toMatchObject({ total: 2, ok: 1, down: 1, affected: ["funds"] });
  });
});

const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

describe("one staleness rule", () => {
  it("compares age against the feed's own window", () => {
    const f = { freshMins: 10 } as RoutedFeed;
    expect(feedFreshness(f, ago(5), true)).toMatchObject({ window: 10, fresh: true });
    expect(feedFreshness(f, ago(30), true)).toMatchObject({ window: 10, fresh: false });
  });

  it("widens the window for session-only feeds outside market hours", () => {
    const f = { freshMins: 5, sessionOnly: true } as RoutedFeed;
    expect(feedFreshness(f, ago(600), false).fresh).toBe(true);
    expect(feedFreshness(f, ago(600), true).fresh).toBe(false);
  });

  it("treats a missing timestamp as not fresh, not as age zero", () => {
    expect(feedFreshness({ freshMins: 10 } as RoutedFeed, null, true)).toMatchObject({ ageMin: null, fresh: false });
  });
});

const feed = (over: Partial<RoutedFeed> = {}): RoutedFeed => ({
  id: "candles_1d", label: "Daily candles", desc: "", group: "live",
  chain: ["yahoo"], heartbeat: "candles_daily", freshMins: 60, ...over,
} as RoutedFeed);

const inputs = (hbPath: string | null) => ({
  surfaces: {},
  bySurfaceProvider: {},
  heartbeats: {
    candles_daily: {
      feed_id: "candles_daily", provider: "yahoo", ok: true, latency_ms: 12,
      detail: null, symbols: 1, observed_at: ago(2), path: hbPath,
    },
  },
  freshness: {},
  prefs: [],
  sessionOpen: true,
});

describe("cache path is its own state", () => {
  it("marks a fresh in-chain cache hit CACHED, not DELAYED", () => {
    expect(statusForFeed(feed(), inputs("cache") as never).status).toBe("CACHED");
    expect(statusForFeed(feed(), inputs("quote") as never).status).toBe("CACHED");
  });

  it("keeps a real tick and a mixed batch LIVE", () => {
    expect(statusForFeed(feed(), inputs("live") as never).status).toBe("LIVE");
    expect(statusForFeed(feed(), inputs("mixed") as never).status).toBe("LIVE");
    expect(statusForFeed(feed(), inputs(null) as never).status).toBe("LIVE");
  });

  it("reserves DELAYED for evidence older than the window", () => {
    const i = inputs("live") as never as ReturnType<typeof inputs>;
    i.heartbeats.candles_daily.observed_at = ago(600);
    expect(statusForFeed(feed(), i as never).status).toBe("DELAYED");
  });
});
