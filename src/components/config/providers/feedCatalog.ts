// Provider feed catalog — the single place that declares, per data provider,
// which feeds it supplies, which surface probe proves the feed, which table it
// lands in (for a freshness read) and which app screens consume it.
export type ProviderId = "kotak_neo" | "yahoo" | "fmp" | "alpha_vantage" | "nse" | "bse";
export type EditKind = "kotak" | "broker" | "key" | "info";

/** Keys returned by market-test-connection `mode: "surfaces"`. */
export type SurfaceKey =
  | "quotes" | "index_quotes" | "depth" | "candles_1d" | "candles_index_1d" | "candles_intraday"
  | "funds" | "holdings" | "positions"
  | "fundamentals" | "company_info" | "shares" | "indicators"
  | "bhavcopy" | "constituents" | "corp_actions";

export type UsedBy = { label: string; to: string };

export type Feed = {
  id: string;
  label: string;
  /** What the feed actually carries. */
  desc: string;
  /** Surface probe that proves this feed end-to-end (Kotak / Yahoo only). */
  surface?: SurfaceKey;
  /** Table the feed persists into — used for the freshness read. */
  table?: { name: string; column: string };
  usedBy: UsedBy[];
  /** Shown when there is no probe and no table (e.g. write paths). */
  note?: string;
  /**
   * "account" feeds belong to one user's own broker login (funds, holdings,
   * positions, order placement). They are NOT part of the shared data feed, so
   * they never appear in Admin Config and never colour the app-wide status.
   */
  scope?: "data" | "account";
};

export type ProviderMeta = {
  id: ProviderId;
  name: string;
  role: string;
  primary?: boolean;
  edit: EditKind;
  docs?: string;
  envName?: string;
  /** Short line describing the provider's job in the pipeline. */
  summary: string;
  feeds: Feed[];
};

const MARKET_OVERVIEW: UsedBy = { label: "Market Overview", to: "/market" };
const SCREENER: UsedBy = { label: "Screener", to: "/market/screener" };
const HOLDINGS: UsedBy = { label: "Holdings", to: "/market/holdings" };
const POSITIONS: UsedBy = { label: "Positions", to: "/market/positions" };
const ORDERS: UsedBy = { label: "Orders", to: "/market/orders" };
const PORTFOLIO: UsedBy = { label: "Portfolio", to: "/market/portfolio" };
const BREAKOUT: UsedBy = { label: "Breakout", to: "/market/breakout" };
const AUTOTRADE: UsedBy = { label: "AutoTrade", to: "/market/autotrade" };
const GTT: UsedBy = { label: "GTT", to: "/market/gtt" };
const PLANNER: UsedBy = { label: "Planner", to: "/market/planner" };
const BACKTEST: UsedBy = { label: "Backtesting", to: "/market/backtesting" };
const INTEL: UsedBy = { label: "Finance Intelligence", to: "/finance/intelligence" };
const INVESTMENTS: UsedBy = { label: "Investments", to: "/finance/investments" };

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  kotak_neo: {
    id: "kotak_neo",
    name: "Kotak Neo",
    role: "Primary quotes / EOD / trading",
    primary: true,
    edit: "kotak",
    summary:
      "Broker session. Serves real-time quotes, depth, index quotes and the account surfaces (funds, holdings, positions, orders). Historical chart candles use Yahoo/NSE because Kotak Neo does not publish a usable candle feed.",
    feeds: [
      {
        id: "ltp", label: "Live LTP / quotes", desc: "Last traded price, day OHLC, change %, volume",
        surface: "quotes", table: { name: "market_quotes", column: "fetched_at" },
        usedBy: [MARKET_OVERVIEW, SCREENER, HOLDINGS, POSITIONS, INTEL],
      },
      {
        id: "depth", label: "Market depth", desc: "5-level bid / ask ladder",
        surface: "depth",
        usedBy: [ORDERS, { label: "Stock Analysis", to: "/market/screener" }],
        note: "Live-only — never persisted.",
      },
      {
        id: "candles_1d", label: "Daily candles", desc: "Unsupported by Kotak Neo; served by Yahoo/NSE history",
        table: { name: "market_daily_prices", column: "created_at" },
        usedBy: [SCREENER, BREAKOUT, BACKTEST],
        note: "Not probed against Kotak — the broker publishes no candle API.",
      },
      {
        id: "candles_intraday", label: "Intraday candles", desc: "Unsupported by Kotak Neo; served by Yahoo chart fallback",
        table: { name: "market_intraday_prices", column: "fetched_at" },
        usedBy: [MARKET_OVERVIEW, PLANNER, AUTOTRADE],
        note: "Not probed against Kotak — the broker publishes no candle API.",
      },
      {
        id: "indices", label: "Index quotes", desc: "Unsupported by Kotak Neo; Nifty / Bank Nifty levels come from Yahoo/NSE",
        usedBy: [MARKET_OVERVIEW],
        note: "Not probed against Kotak — its quote API carries no index tokens.",
      },

      {
        id: "funds", scope: "account", label: "Funds / margin", desc: "Available and used margin",
        surface: "funds", table: { name: "market_funds", column: "synced_at" },
        usedBy: [PORTFOLIO, ORDERS],
      },
      {
        id: "holdings", scope: "account", label: "Holdings", desc: "Demat holdings with average cost",
        surface: "holdings", table: { name: "market_holdings", column: "updated_at" },
        usedBy: [HOLDINGS, PORTFOLIO, INVESTMENTS],
      },
      {
        id: "positions", scope: "account", label: "Positions", desc: "Intraday / carry-forward open positions",
        surface: "positions", table: { name: "market_positions", column: "updated_at" },
        usedBy: [POSITIONS, PORTFOLIO],
      },
      {
        id: "orders", scope: "account", label: "Order placement", desc: "Place / modify / cancel, GTT and auto-trade execution",
        usedBy: [ORDERS, GTT, AUTOTRADE],
        note: "Write path — not probed (no test order is ever placed).",
      },
    ],
  },


  yahoo: {
    id: "yahoo",
    name: "Yahoo Finance",
    role: "Fallback market data",
    edit: "info",
    summary:
      "Public, keyless, delayed. Automatic fallback whenever Kotak cannot serve a quote or candle, and the only source for non-Indian instruments (US indices, FX, gold, crude, crypto).",
    feeds: [
      {
        id: "quotes", label: "Quotes (delayed)", desc: "Fallback LTP for Indian symbols + all global instruments",
        surface: "quotes", table: { name: "market_quotes", column: "fetched_at" },
        usedBy: [INTEL, MARKET_OVERVIEW, SCREENER],
      },
      {
        id: "candles_1d", label: "Daily candles", desc: "History backfill when the broker has no depth of history",
        surface: "candles_1d", table: { name: "market_daily_prices", column: "created_at" },
        usedBy: [SCREENER, BACKTEST],
      },
      {
        id: "candles_intraday", label: "Intraday candles", desc: "Chart fallback bars",
        surface: "candles_intraday", table: { name: "market_intraday_prices", column: "fetched_at" },
        usedBy: [MARKET_OVERVIEW],
      },
      {
        id: "fundamentals", label: "Fundamentals", desc: "Market cap, PE, ratios (global sync)",
        table: { name: "market_fundamentals_global", column: "updated_at" },
        usedBy: [SCREENER],
      },
      {
        id: "indices", label: "Indices", desc: "Nifty / Sensex / global index levels",
        table: { name: "market_quotes", column: "fetched_at" },
        usedBy: [MARKET_OVERVIEW, INTEL],
      },
    ],
  },

  fmp: {
    id: "fmp",
    name: "Financial Modeling Prep",
    role: "Fundamentals",
    edit: "key",
    docs: "https://site.financialmodelingprep.com/developer/docs",
    envName: "FINANCIAL_MODELING_PREP_API_KEY",
    summary:
      "Keyed REST API used by the fundamentals sync to fill company financials that Yahoo misses or disagrees on.",
    feeds: [
      {
        id: "profile", label: "Company profile", desc: "Name, sector, industry, market cap",
        table: { name: "market_fundamentals_global", column: "updated_at" },
        usedBy: [SCREENER],
      },
      {
        id: "ratios", label: "Ratios", desc: "PE / PB / ROE / debt-equity",
        table: { name: "market_fundamentals_global", column: "data_as_of" },
        usedBy: [SCREENER],
      },
      {
        id: "statements", label: "Financial statements", desc: "Balance sheet and cash-flow lines",
        table: { name: "market_fundamentals_global", column: "updated_at" },
        usedBy: [SCREENER],
      },
      {
        id: "shares", label: "Shares outstanding", desc: "Float used for market-cap maths",
        table: { name: "market_shares_outstanding", column: "updated_at" },
        usedBy: [SCREENER],
      },
    ],
  },

  alpha_vantage: {
    id: "alpha_vantage",
    name: "Alpha Vantage",
    role: "Technicals",
    edit: "key",
    docs: "https://www.alphavantage.co/support/#api-key",
    envName: "ALPHA_VANTAGE_API_KEY",
    summary:
      "Keyed indicator API used as a cross-check for locally computed technicals. Free tier is heavily rate-limited, so it is a verification source, not the primary one.",
    feeds: [
      {
        id: "ma", label: "Moving averages", desc: "SMA / EMA cross-check",
        table: { name: "market_indicators_cache", column: "computed_at" },
        usedBy: [SCREENER, BREAKOUT],
      },
      {
        id: "rsi", label: "RSI", desc: "Relative strength index",
        table: { name: "market_indicators_cache", column: "computed_at" },
        usedBy: [SCREENER],
      },
      {
        id: "macd", label: "MACD", desc: "Trend / momentum oscillator",
        table: { name: "market_indicators_cache", column: "computed_at" },
        usedBy: [SCREENER],
      },
      {
        id: "adx", label: "ADX / ATR", desc: "Trend strength and volatility",
        table: { name: "market_indicators_cache", column: "computed_at" },
        usedBy: [BREAKOUT, PLANNER],
      },
    ],
  },

  nse: {
    id: "nse",
    name: "NSE",
    role: "Exchange data",
    edit: "info",
    summary:
      "Public exchange endpoints behind a cookie handshake. Source of truth for the tradable universe, EOD bhavcopy, index membership and corporate actions.",
    feeds: [
      {
        id: "master", label: "Instrument master", desc: "Tradable universe + instrument tokens",
        table: { name: "market_nse_master", column: "updated_at" },
        usedBy: [SCREENER, ORDERS],
      },
      {
        id: "bhavcopy", label: "EOD bhavcopy", desc: "Official settlement OHLCV per trading day",
        table: { name: "market_eod_nse", column: "fetched_at" },
        usedBy: [SCREENER, BACKTEST],
      },
      {
        id: "constituents", label: "Index constituents", desc: "Nifty / Bank Nifty membership",
        table: { name: "market_index_members", column: "updated_at" },
        usedBy: [MARKET_OVERVIEW],
      },
      {
        id: "corp", label: "Corporate actions", desc: "Splits, bonuses, dividends",
        table: { name: "corporate_actions", column: "updated_at" },
        usedBy: [HOLDINGS, INVESTMENTS],
      },
      {
        id: "fiidii", label: "FII / DII activity", desc: "Daily institutional flows",
        table: { name: "fii_dii_activity", column: "updated_at" },
        usedBy: [MARKET_OVERVIEW],
      },
      {
        id: "options", label: "Option chain", desc: "Strike-wise OI snapshots",
        table: { name: "market_option_chain_snapshots", column: "captured_at" },
        usedBy: [PLANNER],
      },
    ],
  },

  bse: {
    id: "bse",
    name: "BSE",
    role: "Exchange data",
    edit: "info",
    summary: "Secondary exchange feed — corporate announcements and circulars used to enrich NSE data.",
    feeds: [
      {
        id: "corp", label: "Corporate actions", desc: "BSE-listed splits / bonuses / dividends",
        table: { name: "corporate_actions", column: "updated_at" },
        usedBy: [HOLDINGS, INVESTMENTS],
      },
      {
        id: "news", label: "Announcements", desc: "Company announcements and circulars",
        table: { name: "market_news", column: "created_at" },
        usedBy: [MARKET_OVERVIEW],
      },
    ],
  },
};

export const PROVIDER_ORDER: ProviderId[] = ["kotak_neo", "yahoo", "fmp", "alpha_vantage", "nse", "bse"];

/** Unique {table, column} pairs across the whole catalog — one freshness query. */
export function allFreshnessTargets(): { name: string; column: string }[] {
  const seen = new Map<string, { name: string; column: string }>();
  for (const p of PROVIDER_ORDER) {
    for (const f of PROVIDERS[p].feeds) {
      if (f.table) seen.set(`${f.table.name}.${f.table.column}`, f.table);
    }
  }
  return [...seen.values()];
}

// ---------- Feed routing (manual provider override) ----------
// Mirrors resolver.ts's PRIORITY_CHAINS / FEED_FIELDS. `chain` is the built-in
// order; pinning a provider in the UI only moves it to the front — the rest
// stay as fallbacks so a pinned-but-down vendor degrades instead of going dark.
export type RoutedProvider = "kotak" | "yahoo" | "nse" | "fmp" | "alpha" | "computed";

export const ROUTED_PROVIDER_LABEL: Record<RoutedProvider, string> = {
  kotak: "Kotak Neo",
  yahoo: "Yahoo Finance",
  nse: "NSE",
  fmp: "Fin. Modeling Prep",
  alpha: "Alpha Vantage",
  computed: "Computed locally",
};

export type FeedGroup = "live" | "history" | "account" | "reference";

export const FEED_GROUP_LABEL: Record<FeedGroup, string> = {
  live: "Live market",
  history: "History",
  account: "Account",
  reference: "Reference",
};

export type RoutedFeed = {
  id: string;
  label: string;
  desc: string;
  group: FeedGroup;
  chain: RoutedProvider[];
  /** Surface probe (market-test-connection `mode: "surfaces"`) proving this feed. */
  surface?: SurfaceKey;
  /** Table used for the freshness read behind the status pill. */
  table?: { name: string; column: string };
  /**
   * Live-serving heartbeat id (public.market_feed_heartbeat.feed_id). Live
   * feeds are proven by the serving path itself stamping who answered — the
   * old table-freshness read judged them by caches nothing writes in real
   * time, which is why healthy feeds rendered DOWN.
   */
  heartbeat?: string;
  /** Minutes after which the table read counts as stale (DELAYED). */
  freshMins?: number;
  /**
   * Live-only feed: quiet outside market hours is expected, so a missing
   * heartbeat off-session reports IDLE (not DOWN) as long as the last
   * observation during a session was healthy.
   */
  sessionOnly?: boolean;
  /** Routing is fixed for this feed (single source, or a write path). */
  routable?: boolean;
  /**
   * Account-bound feed: describes ONE broker connection, not a shared data
   * feed. Kept out of the app-wide health tally so a disconnected personal
   * broker never reads as a platform outage.
   */
  perUser?: boolean;
  /** Pulled on demand (no scheduler) — a cold table is expected, not stale. */
  onDemand?: boolean;
  /** Providers that cannot serve this feed even though they're in scope. */
  unsupported?: Partial<Record<RoutedProvider, string>>;
  note?: string;
};


export const ROUTED_FEEDS: RoutedFeed[] = [
  // ---- Live market -------------------------------------------------------
  { id: "ltp", label: "Live price", desc: "LTP, change, volume", group: "live",
    chain: ["kotak", "yahoo"], surface: "quotes",
    heartbeat: "quotes_ltp", freshMins: 15, sessionOnly: true },
  // Both are fields of the live quote payload, not feeds of their own: they
  // follow whatever Live price is routed to, so they carry no selector.
  { id: "previous_close", label: "Previous close", desc: "Prior settlement close (from live quote)", group: "live",
    chain: ["kotak", "yahoo"], surface: "quotes", routable: false,
    note: "Field of the Live price payload — follows its routing." },
  { id: "range_52w", label: "52-week range", desc: "52w high / low (from live quote)", group: "live",
    chain: ["kotak", "yahoo"], surface: "quotes", routable: false,
    note: "Field of the Live price payload — follows its routing." },
  { id: "depth", label: "Market depth", desc: "5-level bid / ask ladder", group: "live",
    chain: ["kotak"], surface: "depth", sessionOnly: true,
    note: "Broker-only, live — never persisted. Empty ladder outside market hours is normal." },
  // Kotak Neo's quote API has no index instruments (NSE:^NSEI always returns
  // empty), so indices are Yahoo-first by design — Kotak stays in the chain
  // only as a theoretical fallback and is marked unsupported.
  { id: "indices", label: "Indices", desc: "Nifty / Bank Nifty / VIX / global index levels", group: "live",
    chain: ["yahoo", "kotak"], surface: "index_quotes",
    unsupported: { kotak: "Kotak Neo publishes no index quote tokens — indices are Yahoo/NSE-served." },
    heartbeat: "indices", freshMins: 15, sessionOnly: true },


  // ---- History -----------------------------------------------------------
  // Kotak Neo publishes no candle API (confirmed by Kotak support; /charts/v2
  // 503s on every interval). History is Yahoo/NSE-served by design — Kotak is
  // simply not in the chain here, so the row can't ever fall back over it.
  { id: "candles_1d", label: "Daily candles", desc: "Adjusted daily OHLCV history", group: "history",
    chain: ["yahoo", "nse"], surface: "candles_1d",
    heartbeat: "candles_daily",
    table: { name: "market_daily_prices", column: "created_at" }, freshMins: 60 * 30 },
  { id: "candles_intraday", label: "Intraday candles", desc: "1m / 5m / 15m chart bars", group: "history",
    chain: ["yahoo"], surface: "candles_intraday",
    heartbeat: "candles_intraday", sessionOnly: true,
    table: { name: "market_intraday_prices", column: "fetched_at" }, freshMins: 45,
    note: "Forming last bar is stitched from the live Kotak quote so chart and price stay in sync." },

  { id: "bhavcopy", label: "NSE EOD bhavcopy", desc: "Official settlement OHLCV per trading day", group: "history",
    chain: ["nse"], routable: false, surface: "bhavcopy",
    table: { name: "market_eod_nse", column: "fetched_at" }, freshMins: 60 * 30 },

  // ---- Account -----------------------------------------------------------
  // Account rows describe the signed-in user's own broker connection, so they
  // are marked perUser and stay out of the app-wide feed tally.
  { id: "funds", label: "Funds / margin", desc: "Available and used margin", group: "account",
    chain: ["kotak"], surface: "funds", routable: false, perUser: true, onDemand: true,
    table: { name: "market_funds", column: "synced_at" }, freshMins: 60 * 24 },
  { id: "holdings", label: "Holdings", desc: "Demat holdings with average cost", group: "account",
    chain: ["kotak"], surface: "holdings", routable: false, perUser: true, onDemand: true,
    table: { name: "market_holdings", column: "updated_at" }, freshMins: 60 * 24 },
  { id: "positions", label: "Positions", desc: "Intraday / carry-forward open positions", group: "account",
    chain: ["kotak"], surface: "positions", routable: false, perUser: true, onDemand: true,
    table: { name: "market_positions", column: "updated_at" }, freshMins: 60 * 24 },
  { id: "orders_read", label: "Orders / GTT (read)", desc: "Order book, trade book, GTT list", group: "account",
    chain: ["kotak"], routable: false, perUser: true, onDemand: true,
    note: "Read live from the broker on demand — not cached." },
  { id: "orders_write", label: "Order placement", desc: "Place / modify / cancel, GTT, auto-trade", group: "account",
    chain: ["kotak"], routable: false, perUser: true,
    note: "Write path — never probed (no test order is placed)." },

  // ---- Reference ---------------------------------------------------------
  // Reference feeds are not served through the live routing chain: on-demand
  // reads go to Yahoo quoteSummary and the vendor sync jobs fill the rest.
  // They are marked unroutable rather than showing a selector that does nothing.
  { id: "fundamentals", label: "Fundamentals", desc: "PE, PB, ROE, growth, margins", group: "reference",
    chain: ["yahoo", "fmp"], surface: "fundamentals", routable: false,
    note: "On-demand reads use Yahoo quoteSummary; FMP fills the nightly universe sync.",
    table: { name: "market_fundamentals_global", column: "updated_at" }, freshMins: 60 * 48 },
  { id: "company_info", label: "Company info", desc: "Name, sector, industry", group: "reference",
    chain: ["yahoo", "fmp"], surface: "company_info", routable: false,
    note: "On-demand reads use Yahoo quoteSummary; FMP fills the nightly universe sync.",
    table: { name: "market_fundamentals_global", column: "updated_at" }, freshMins: 60 * 24 * 14 },
  { id: "shares", label: "Shares outstanding", desc: "Float used for market-cap maths", group: "reference",
    chain: ["fmp", "yahoo"], surface: "shares", routable: false,
    note: "Filled by the nightly shares-outstanding sync (FMP, Yahoo fallback).",
    table: { name: "market_shares_outstanding", column: "updated_at" }, freshMins: 60 * 24 * 30 },
  { id: "indicators", label: "Technical indicators", desc: "RSI, MACD, ADX, moving averages", group: "reference",
    chain: ["computed"], routable: false, surface: "indicators",
    note: "Computed in-database from daily candles — no vendor call on this path.",
    table: { name: "market_indicators_cache", column: "computed_at" }, freshMins: 60 * 24 },
  { id: "ownership", label: "Shareholding", desc: "Promoter / FII / DII holding", group: "reference",
    chain: ["yahoo"], routable: false },
  { id: "constituents", label: "Index constituents", desc: "Nifty / Bank Nifty membership", group: "reference",
    chain: ["nse"], routable: false, surface: "constituents",
    table: { name: "market_index_members", column: "updated_at" }, freshMins: 60 * 24 * 14 },
  { id: "corp_actions", label: "Corporate actions", desc: "Splits, bonuses, dividends", group: "reference",
    chain: ["nse"], routable: false, surface: "corp_actions",
    table: { name: "corporate_actions", column: "updated_at" }, freshMins: 60 * 24 * 14 },
  { id: "news", label: "News", desc: "Headlines per symbol", group: "reference",
    chain: ["yahoo", "nse"], routable: false,
    table: { name: "market_news", column: "created_at" }, freshMins: 60 * 24 },
];

