import { describe, it, expect } from "vitest";
import { filterMatches, excludedByMissingData, coverageOf, latestTradeDateOf, type ActiveFilter } from "../src/lib/market/screenerCatalog";
import { colsFromActiveFilters } from "../src/lib/market/screenerColumnModel";

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
  it("an enum filter excludes a non-equity row that cannot prove a match", () => {
    const etf = { symbol: "ETF", instrument_type: "ETF", sector: null };
    expect(filterMatches(etf, { id: "sector", values: ["Technology"] })).toBe(false);
  });

  it("the volume-above-average boolean uses a strict comparison", () => {
    const equal = { symbol: "EQ", instrument_type: "EQ", trade_date: "2026-07-23", vol_gt_avg30: false };
    const above = { ...equal, vol_gt_avg30: true };
    expect(filterMatches(equal, { id: "vol_gt_avg30", bool: true }, "2026-07-23")).toBe(false);
    expect(filterMatches(above, { id: "vol_gt_avg30", bool: true }, "2026-07-23")).toBe(true);
  });
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

describe("saved screener column parity", () => {
  it("derives the same result columns for the Deep screeners filter in Screener and Overview", () => {
    const active: ActiveFilter[] = [
      { id: "market_cap", min: 1000, max: 100000 },
      { id: "ltp", min: 100, max: 10000 },
      { id: "change_pct", min: 5, max: 10 },
      { id: "vol_gt_avg30", bool: true },
    ];

    expect(colsFromActiveFilters(active, { skipBooleans: true })).toEqual([
      "symbol",
      "market_cap",
      "close",
      "change_pct",
    ]);
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

  it("requires the exact latest session for price and return predicates", () => {
    const lag1 = { symbol: "LAG1", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-20", change_pct: 6, volume: 500000 };
    const lag3 = { symbol: "LAG3", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-18", change_pct: 6, volume: 500000 };
    const lag4 = { symbol: "LAG4", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-17", change_pct: 6, volume: 500000 };
    const af: ActiveFilter = { id: "change_pct", min: 5, max: 10 };
    expect(filterMatches(lag1, af, "2026-07-21")).toBe(false);
    expect(filterMatches(lag3, af, "2026-07-21")).toBe(false);
    expect(filterMatches(lag4, af, "2026-07-21")).toBe(false);
  });

  it("still permits a one-session lag for slower technical indicators", () => {
    const row = { symbol: "LAG", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-20", rsi: 60 };
    expect(filterMatches(row, { id: "rsi", min: 50 }, "2026-07-21")).toBe(true);
  });

  it("a Price filter uses the same exact-session gate as Volume and 1D Return", () => {
    const freshEnough = { symbol: "OK", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-20", ltp: 250 };
    const stale = { symbol: "OLD", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-16", ltp: 250 };
    const af: ActiveFilter = { id: "ltp", min: 100, max: 1000 };
    expect(filterMatches(freshEnough, af, "2026-07-22")).toBe(false);
    expect(filterMatches(stale, af, "2026-07-22")).toBe(false);
  });

  it("applies an explicit Volume maximum as a real upper bound", () => {
    const highVolume = { symbol: "MARKSANS", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-22", volume: 4_278_354 };
    const af: ActiveFilter = { id: "volume", min: 100_000, max: 1_000_000 };
    expect(filterMatches(highVolume, af, "2026-07-22")).toBe(false);
  });

  it("Volume > 30D Avg Volume boolean matches when the view flag is true and the row is fresh", () => {
    const row = { symbol: "X", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-22", volume: 5_000_000, vol_avg30: 1_000_000, vol_gt_avg30: true };
    const af: ActiveFilter = { id: "vol_gt_avg30", bool: true };
    expect(filterMatches(row, af, "2026-07-22")).toBe(true);
  });

  it("Volume > 30D Avg Volume boolean excludes rows when the flag is false", () => {
    const row = { symbol: "Y", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-22", volume: 500_000, vol_avg30: 1_000_000, vol_gt_avg30: false };
    const af: ActiveFilter = { id: "vol_gt_avg30", bool: true };
    expect(filterMatches(row, af, "2026-07-22")).toBe(false);
  });

  it("Volume > 30D Avg Volume boolean respects the tech freshness gate", () => {
    const stale = { symbol: "Z", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-10", volume: 5_000_000, vol_avg30: 1_000_000, vol_gt_avg30: true };
    const af: ActiveFilter = { id: "vol_gt_avg30", bool: true };
    expect(filterMatches(stale, af, "2026-07-22")).toBe(false);
  });


  it("uses raw 1D return for boundary comparisons while display can remain rounded", () => {
    const roundedBoundary = {
      symbol: "GENESYS", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-22",
      change_pct: -7.00,
      change_pct_raw: -6.999382,
    };
    const af: ActiveFilter = { id: "change_pct", min: -15, max: -7 };
    expect(filterMatches(roundedBoundary, af, "2026-07-22")).toBe(false);
  });

  it("matches only rows inside the requested raw-share volume range", () => {
    const rows = [
      { symbol: "MARKSANS", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-22", market_cap: 11118.37, ltp: 241.10, change_pct_raw: -7.38, volume: 4_278_354 },
      { symbol: "MEDPLUS", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-22", market_cap: 8309.34, ltp: 691.95, change_pct_raw: -12.80, volume: 2_431_192 },
      { symbol: "TIPSMUSIC", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-22", market_cap: 7961.99, ltp: 622.85, change_pct_raw: -12.55, volume: 2_886_455 },
      { symbol: "MHRIL", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-22", market_cap: 4547.61, ltp: 211.70, change_pct_raw: -7.136904, volume: 1_012_352 },
      { symbol: "SUNTECK", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-22", market_cap: 4370.02, ltp: 290.70, change_pct_raw: -7.714286, volume: 908_279 },
      { symbol: "OSWALPUMPS", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-22", market_cap: 4062.56, ltp: 356.35, change_pct_raw: -8.80, volume: 1_927_456 },
      { symbol: "UNICHEMLAB", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-22", market_cap: 3813.88, ltp: 528.55, change_pct_raw: -9.96, volume: 314_223 },
      { symbol: "ORIENTHOT", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-22", market_cap: 2473.96, ltp: 135.49, change_pct_raw: -7.54, volume: 1_451_024 },
      { symbol: "INDOBORAX", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-22", market_cap: 1273.01, ltp: 396.70, change_pct_raw: -7.77, volume: 312_868 },
      { symbol: "BAJAJHCARE", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-22", market_cap: 1098.75, ltp: 323.30, change_pct_raw: -12.47, volume: 1_661_439 },
      { symbol: "GENESYS", exchange: "NSE", instrument_type: "EQ", trade_date: "2026-07-22", market_cap: 1257.68, ltp: 300.95, change_pct: -7.00, change_pct_raw: -6.999382, volume: 449_744 },
    ];
    const filters: ActiveFilter[] = [
      { id: "market_cap", min: 1000, max: 100000 },
      { id: "ltp", min: 100, max: 1000 },
      { id: "volume", min: 100000, max: 1000000 },
      { id: "change_pct", min: -15, max: -7 },
    ];
    const matches = rows.filter((row) => filters.every((af) => filterMatches(row, af, "2026-07-22"))).map((row) => row.symbol);
    expect(matches).toEqual(["SUNTECK", "UNICHEMLAB", "INDOBORAX"]);
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
