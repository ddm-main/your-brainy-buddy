import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { lazy, Suspense } from "react";

const Dashboard = lazy(() => import("@/routes/market/Dashboard"));
const Holdings = lazy(() => import("@/routes/market/Holdings"));
const Watchlist = lazy(() => import("@/routes/market/Watchlist"));
const Positions = lazy(() => import("@/routes/market/Positions"));
const Screener = lazy(() => import("@/routes/market/Screener"));
const Analysis = lazy(() => import("@/routes/market/Analysis"));
const Alerts = lazy(() => import("@/routes/market/Alerts"));
const Backtesting = lazy(() => import("@/routes/market/Backtesting"));
const MarketSettings = lazy(() => import("@/routes/market/Settings"));

const TABS: { to: string; label: string; exact?: boolean }[] = [
  { to: "/market", label: "Dashboard", exact: true },
  { to: "/market/holdings", label: "Holdings" },
  { to: "/market/positions", label: "Positions" },
  { to: "/market/watchlist", label: "Watchlist" },
  { to: "/market/screener", label: "Screener" },
  { to: "/market/analysis", label: "Analysis" },
  { to: "/market/alerts", label: "Alerts" },
  { to: "/market/backtesting", label: "Backtesting" },
  { to: "/market/settings", label: "Settings" },
];

export default function Market() {
  const loc = useLocation();
  return (
    <div style={{ padding: 12, height: "100%", display: "grid", gridTemplateColumns: "180px 1fr", gap: 12, minHeight: 0 }}>
      <nav style={{ display: "flex", flexDirection: "column", gap: 4, borderRight: "1px solid var(--edge)", paddingRight: 8 }}>
        <div className="hud-label" style={{ padding: "4px 8px", color: "var(--accent)" }}>Market</div>
        {TABS.map((t) => {
          const active = t.exact
            ? loc.pathname === t.to || loc.pathname === t.to + "/"
            : loc.pathname === t.to || loc.pathname.startsWith(t.to + "/");
          return (
            <NavLink key={t.to} to={t.to} style={{
              padding: "8px 10px", textDecoration: "none",
              border: `1px solid ${active ? "var(--edge-strong)" : "transparent"}`,
              background: active ? "rgba(53,214,237,0.08)" : "transparent",
              color: active ? "var(--accent)" : "var(--text-dim)",
              fontFamily: "var(--font-hud)", fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase",
              borderRadius: 2,
            }}>{t.label}</NavLink>
          );
        })}
      </nav>
      <div style={{ minHeight: 0, minWidth: 0, overflow: "auto" }}>
        <Suspense fallback={<div className="hud-label">loading…</div>}>
          <Routes>
            <Route index element={<Dashboard />} />
            <Route path="holdings" element={<Holdings />} />
            <Route path="positions" element={<Positions />} />
            <Route path="watchlist" element={<Watchlist />} />
            <Route path="screener" element={<Screener />} />
            <Route path="analysis" element={<Analysis />} />
            <Route path="analysis/:symbol" element={<Analysis />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="backtesting" element={<Backtesting />} />
            <Route path="settings" element={<MarketSettings />} />
            <Route path="*" element={<Navigate to="/market" replace />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}
