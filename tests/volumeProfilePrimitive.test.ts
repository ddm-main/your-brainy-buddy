import { describe, it, expect } from "vitest";
import { VolumeProfilePrimitive } from "@/components/market/volumeProfilePrimitive";

describe("volume profile primitive", () => {
  it("draws stacked buy/sell rows for the visible range", () => {
    const candles = Array.from({ length: 30 }, (_, i) => ({
      time: 1_722_000_000 + i * 300,
      open: 100 + (i % 5), high: 101 + (i % 5), low: 99 + (i % 5), close: 100 + ((i * 3) % 7), volume: 100 + i,
    })) as any[];
    const vp = new VolumeProfilePrimitive(candles, {
      rows: 10, valueAreaPct: 70, widthPct: 25, rightSide: true,
      upColor: "#6bffb0", downColor: "#ff5f6d", pocColor: "#f7c948",
    });
    const unsub: any[] = [];
    const chart: any = { timeScale: () => ({
      getVisibleLogicalRange: () => ({ from: 0, to: 29 }),
      subscribeVisibleLogicalRangeChange: (f: any) => unsub.push(f),
      unsubscribeVisibleLogicalRangeChange: () => {},
    }) };
    const series: any = { priceToCoordinate: (p: number) => 400 - (p - 95) * 20 };
    vp.attached({ chart, series, requestUpdate: () => {} });
    const calls: string[] = [];
    const ctx: any = new Proxy({}, {
      get: (_t, k) => {
        if (k === "save" || k === "restore" || k === "beginPath" || k === "stroke" || k === "setLineDash" || k === "moveTo" || k === "lineTo") return () => calls.push(String(k));
        if (k === "fillRect") return () => calls.push("fillRect");
        return undefined;
      },
      set: () => true,
    });
    const target = { useMediaCoordinateSpace: (cb: any) => cb({ context: ctx, mediaSize: { width: 800, height: 500 } }) };
    vp.paneViews()[0].renderer().draw(target);
    expect(calls.filter((c) => c === "fillRect").length).toBeGreaterThan(0);
    expect(vp.latest?.poc).not.toBeNull();
    vp.detached();
  });
});
