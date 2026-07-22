import { describe, it, expect } from "vitest";
import { filterMatches, excludedByMissingData, coverageOf, latestTradeDateOf, type ActiveFilter } from "../src/lib/market/screenerCatalog";

// A row with a full EOD triple (ltp/change_pct/volume via trade_date) but no
// technical indicators synced yet — the exact shape that used to get dropped
// by unrelated filters before scope-aware applicability was added.
const rowWithEodNoTech = {
  symbol: "FOO", exchange: "NSE", instrument_type: "EQ",
  trade_date: "2026-07-21",
  market_cap: 5000, ltp: 250, change_pct: 2.5, volume: 100000,
  rsi: null, adx: null,
};

// No EOD row at all — fully outside the "tech" scope, not just missing one field.
const rowWithNoEod = {
  symbol: "BAR", exchange: "NSE", instrument_type: "EQ",
  trade_date: null,
  market_cap: 8000, ltp: null, change_pct: null, volume: null,
  rsi: null, adx: null,
};

describe("filterMatches — scope-aware applicability", () => {
  it("a filter on an unrelated field still matches a row missing technicals", () => {
    const af: ActiveFilter = { id: "market_cap", min: 1000 };
    expect(filterMatches(rowWithEodNoTech, af)).toBe(true);
  });

  it("an RSI filter excludes a row that has an EOD row but a null RSI value", () => {
    const af: ActiveFilter = { id: "rsi", min: 50 };
    expect(filterMatches(rowWithEodNoTech, af)).toBe(false);
  });

  it("an RSI filter strictly excludes a row with no EOD row at all — it can't prove a match", () => {
    const af: ActiveFilter = { id: "rsi", min: 50 };
    expect(filterMatches(rowWithNoEod, af)).toBe(false);
  });

  it("a non-tech-scoped filter (e.g. PE) passes through a row outside its scope untouched", () => {
    const etfRow = { symbol: "ETF1", exchange: "NSE", instrument_type: "ETF", trade_date: "2026-07-21", pe: null };
    const af: ActiveFilter = { id: "pe", min: 10 };
    expect(filterMatches(etfRow, af)).toBe(true);
  });
});

describe("excludedByMissingData — names both missing-field and out-of-scope rows", () => {
  it("counts a row with an EOD row but a null RSI as missing data", () => {
    const active: ActiveFilter[] = [{ id: "rsi", min: 50 }];
    expect(excludedByMissingData([rowWithEodNoTech], active)).toBe(1);
  });

  it("also counts a row with no EOD row at all under a tech-scoped filter", () => {
    const active: ActiveFilter[] = [{ id: "rsi", min: 50 }];
    expect(excludedByMissingData([rowWithNoEod], active)).toBe(1);
  });

  it("doesn't double-count a row missing data for two active filters", () => {
    const active: ActiveFilter[] = [{ id: "rsi", min: 50 }, { id: "adx", min: 20 }];
    expect(excludedByMissingData([rowWithEodNoTech], active)).toBe(1);
  });

  it("ignores filters with no bound set", () => {
    const active: ActiveFilter[] = [{ id: "rsi" }];
    expect(excludedByMissingData([rowWithEodNoTech], active)).toBe(0);
  });
});

describe("latestTradeDateOf + stale-trade_date gating", () => {
  // market-pipeline-eod stamps a symbol's sync cursor even when its Yahoo
  // fetch fails, so a symbol stuck on an old date still reads as "synced" —
  // its change_pct is for whatever day it last succeeded, not today.
  const freshRow = { symbol: "FRESH", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-21", change_pct: 6, volume: 500000 };
  const staleRow = { symbol: "STALE", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-14", change_pct: 6, volume: 500000 };
  const rows = [freshRow, staleRow];

  it("picks the max trade_date across the loaded rows", () => {
    expect(latestTradeDateOf(rows)).toBe("2026-07-21");
    expect(latestTradeDateOf([])).toBeNull();
  });

  it("a 1D-Return filter matches the fresh row but excludes the stale one when given the latest date", () => {
    const latest = latestTradeDateOf(rows);
    const af: ActiveFilter = { id: "change_pct", min: 5, max: 10 };
    expect(filterMatches(freshRow, af, latest)).toBe(true);
    expect(filterMatches(staleRow, af, latest)).toBe(false);
  });

  it("without a latest date supplied, both rows match — same as today's default, for callers not yet passing it", () => {
    const af: ActiveFilter = { id: "change_pct", min: 5, max: 10 };
    expect(filterMatches(freshRow, af)).toBe(true);
    expect(filterMatches(staleRow, af)).toBe(true);
  });

  it("excludedByMissingData names the stale row as missing, not as a genuine 5-10% match", () => {
    const af: ActiveFilter[] = [{ id: "change_pct", min: 5, max: 10 }];
    expect(excludedByMissingData(rows, af, latestTradeDateOf(rows))).toBe(1);
  });

  it("a row lagging the latest by 1-3 days is still accepted — a symbol Yahoo skipped for a session, not a stale-forever row", () => {
    const lag1 = { symbol: "LAG1", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-20", change_pct: 6, volume: 500000 };
    const lag3 = { symbol: "LAG3", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-18", change_pct: 6, volume: 500000 };
    const lag4 = { symbol: "LAG4", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-17", change_pct: 6, volume: 500000 };
    const af: ActiveFilter = { id: "change_pct", min: 5, max: 10 };
    expect(filterMatches(lag1, af, "2026-07-21")).toBe(true);
    expect(filterMatches(lag3, af, "2026-07-21")).toBe(true);
    expect(filterMatches(lag4, af, "2026-07-21")).toBe(false);
  });
});

describe("coverageOf — denominator is the scoped set, numerator is fields actually present", () => {
  it("rsi coverage excludes rows with no EOD row from the denominator", () => {
    const c = coverageOf([rowWithEodNoTech, rowWithNoEod], "rsi");
    expect(c.total).toBe(1); // only rowWithEodNoTech is in "tech" scope
    expect(c.has).toBe(0);   // its rsi is null
  });

  it("market_cap coverage counts both rows (scope 'all')", () => {
    const c = coverageOf([rowWithEodNoTech, rowWithNoEod], "market_cap");
    expect(c.total).toBe(2);
    expect(c.has).toBe(2);
  });
});
