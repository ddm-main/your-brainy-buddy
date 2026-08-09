// Shared Market group definitions — used by both the Market page and the
// global TopBar so promoting Market sub-sections into the header stays in sync.
export type MarketGroup = {
  key: string;
  label: string;
  to: string;
  match: (p: string) => boolean;
};

export const MARKET_GROUPS: MarketGroup[] = [
  {
    key: "overview",
    label: "Overview",
    to: "/market",
    match: (p) => p === "/market" || p === "/market/" || /^\/market\/index\//.test(p),
  },
  {
    key: "screener",
    label: "Screener",
    to: "/market/screener",
    match: (p) => /^\/market\/screener/.test(p),
  },
  {
    key: "breakout",
    label: "Breakout",
    to: "/market/breakout",
    // Backtesting and the trade planner are part of the same research loop —
    // they were reachable only by typing the URL before this.
    match: (p) => /^\/market\/(breakout|score|backtesting|planner)/.test(p),
  },

  {
    key: "portfolio",
    label: "Portfolio",
    to: "/market/portfolio",
    match: (p) => /^\/market\/(portfolio|holdings|positions|orders|gtt)/.test(p),
  },
  {
    key: "autotrade",
    label: "AutoTrade",
    to: "/market/autotrade",
    match: (p) => /^\/market\/autotrade/.test(p),
  },
  {
    key: "settings",
    label: "Settings",
    to: "/market/settings",
    match: (p) => /^\/market\/settings/.test(p),
  },
];

export type MarketSub = { to: string; label: string };
export const MARKET_SUBS: Record<string, MarketSub[]> = {
  breakout: [
    { to: "/market/breakout", label: "Breakout" },
    { to: "/market/backtesting", label: "Backtesting" },
    { to: "/market/planner", label: "Planner" },
  ],
  portfolio: [
    { to: "/market/portfolio", label: "Overview" },
    { to: "/market/holdings", label: "Holdings" },
    { to: "/market/positions", label: "Positions" },
    { to: "/market/orders", label: "Orders" },
    { to: "/market/gtt", label: "GTT" },
  ],
};

