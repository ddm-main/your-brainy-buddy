import { describe, expect, it } from "vitest";
import { tallyRows, type FeedRow, type Status } from "../src/lib/market/feedStatus";
import type { RoutedFeed } from "../src/components/config/providers/feedCatalog";

const row = (id: string, status: Status, perUser = false): FeedRow => ({
  f: { id, label: id, desc: id, group: perUser ? "account" : "live", chain: ["kotak"], perUser } as RoutedFeed,
  status,
  detail: "",
  servedBy: "",
  health: "",
  primaryProbe: null,
});

describe("feed health tallies", () => {
  it("counts live, fallback, and intentional idle as healthy", () => {
    const tally = tallyRows([row("live", "LIVE"), row("fallback", "FALLBACK"), row("idle", "IDLE")]);
    expect(tally).toMatchObject({ total: 3, ok: 3, live: 1, fallback: 1, idle: 1, down: 0 });
  });

  it("keeps platform and account failures in separate scopes", () => {
    const rows = [row("quote", "LIVE"), row("funds", "DOWN", true), row("orders", "IDLE", true)];
    expect(tallyRows(rows, "platform")).toMatchObject({ total: 1, ok: 1, down: 0 });
    expect(tallyRows(rows, "account")).toMatchObject({ total: 2, ok: 1, down: 1, affected: ["funds"] });
  });
});