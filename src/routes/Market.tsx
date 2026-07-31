// Market — group tabs live in the global TopBar; only the second-level
// SubTabStrip renders here.
import { useEffect, useRef } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { lazy, Suspense } from "react";
import ErrorBoundary from "@/components/hud/ErrorBoundary";
import { useMarketAutoSync } from "@/lib/market/useAutoSync";
import { useRealtimeTicks } from "@/lib/market/useRealtimeTicks";
import { KotakReconnectModal } from "@/components/market/KotakReconnectModal";
import { useAccessStore } from "@/store/accessStore";
import { MARKET_GROUPS, MARKET_SUBS, type MarketSub } from "@/routes/market/nav";


const Dashboard = lazy(() => import("@/routes/market/Dashboard"));
const Holdings = lazy(() => import("@/routes/market/Holdings"));
const Positions = lazy(() => import("@/routes/market/Positions"));
const Screener = lazy(() => import("@/routes/market/Screener"));
const Breakout = lazy(() => import("@/routes/market/Breakout"));
const Analysis = lazy(() => import("@/routes/market/Analysis"));
const Backtesting = lazy(() => import("@/routes/market/Backtesting"));
const MarketSettings = lazy(() => import("@/routes/market/Settings"));
const Planner = lazy(() => import("@/routes/market/Planner"));
const IndexDetail = lazy(() => import("@/routes/market/IndexDetail"));
const AutoTrade = lazy(() => import("@/routes/market/AutoTrade"));
const PortfolioOverview = lazy(() => import("@/routes/market/PortfolioOverview"));
const Orders = lazy(() => import("@/routes/market/Orders"));
const GTT = lazy(() => import("@/routes/market/GTT"));
const ScoreDetail = lazy(() => import("@/routes/market/ScoreDetail"));
const ScoreExplain = lazy(() => import("@/routes/market/ScoreExplain"));
const Calibration = lazy(() => import("@/routes/market/Calibration"));


type Sub = MarketSub;

// The standalone AI Analysis page is gone — a score is now explained by the
// breakout scoring page, so old /market/ai/:symbol links land there.
function AiRedirect() {
  const { symbol } = useParams();
  return <Navigate to={`/market/score/${encodeURIComponent(symbol ?? "")}/explain?exchange=NSE`} replace />;
}




const tabBase: React.CSSProperties = {
  padding: "6px 12px", fontFamily: "var(--font-hud)", fontSize: 10,
  letterSpacing: "0.18em", textTransform: "uppercase", textDecoration: "none",
  borderRadius: 2, cursor: "pointer", transition: "background 120ms, color 120ms",
};

function SubTabStrip({ subs, currentPath }: { subs: Sub[]; currentPath: string }) {
  const nav = useNavigate();
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);
  // Prefer exact match; otherwise longest startsWith so nested paths select
  // the deeper sub-tab even when it shares a prefix with a sibling.
  const exact = subs.findIndex((s) => currentPath === s.to);
  const activeIdx = exact >= 0
    ? exact
    : Math.max(0, subs
        .map((s, i) => (currentPath.startsWith(s.to + "/") ? { i, len: s.to.length } : null))
        .filter((x): x is { i: number; len: number } => x != null)
        .sort((a, b) => b.len - a.len)[0]?.i ?? 0);

  const onKey = (e: React.KeyboardEvent, idx: number) => {
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % subs.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + subs.length) % subs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = subs.length - 1;
    else return;
    e.preventDefault();
    refs.current[next]?.focus();
    nav(subs[next].to);
  };

  return (
    <div role="tablist" aria-label="Market sub-navigation"
      style={{ display: "flex", gap: 2, flexWrap: "wrap", paddingLeft: 2, borderBottom: "1px solid var(--edge)" }}>
      {subs.map((s, i) => {
        const active = i === activeIdx;
        return (
          <NavLink key={s.to} to={s.to} role="tab" aria-selected={active}
            tabIndex={active ? 0 : -1}
            ref={(el) => { refs.current[i] = el; }}
            onKeyDown={(e) => onKey(e, i)}
            style={{
              ...tabBase, padding: "5px 10px",
              borderBottom: `2px solid ${active ? "var(--accent)" : "transparent"}`,
              color: active ? "var(--accent)" : "var(--text-dim)",
              marginBottom: -1,
            }}>{s.label}</NavLink>
        );
      })}
    </div>
  );
}

export default function Market() {
  const loc = useLocation();
  const isAdmin = useAccessStore((s) => s.role === "admin");
  const activeGroup = MARKET_GROUPS.find((g) => g.match(loc.pathname)) ?? MARKET_GROUPS[0];
  const activeSubs = MARKET_SUBS[activeGroup.key] ?? [];
  useEffect(() => { document.title = `Market · ${activeGroup.label}`; }, [activeGroup.key, activeGroup.label]);
  useMarketAutoSync();
  useRealtimeTicks();
  void isAdmin;


  return (
    <div style={{ padding: 12, height: "100%", display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
      <KotakReconnectModal />
      {activeSubs.length > 0 && (
        <SubTabStrip subs={activeSubs} currentPath={loc.pathname} />
      )}

      <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "auto" }}>
        <ErrorBoundary key={loc.pathname}>
          <Suspense fallback={<div className="hud-label">loading…</div>}>
            <Routes>
              <Route index element={<Dashboard />} />
              <Route path="portfolio" element={<PortfolioOverview />} />
              <Route path="holdings" element={<Holdings />} />
              <Route path="positions" element={<Positions />} />
              <Route path="orders" element={<Orders />} />
              <Route path="gtt" element={<GTT />} />
              <Route path="screener" element={<Screener />} />
              <Route path="breakout" element={<Breakout />} />
              <Route path="screener/breakout" element={<Navigate to="/market/breakout" replace />} />
              <Route path="analysis" element={<Navigate to="/market/screener" replace />} />
              <Route path="analysis/:symbol" element={<Analysis />} />
              <Route path="score/:symbol/explain" element={<ScoreExplain />} />
              <Route path="score/:symbol" element={<ScoreDetail />} />
              <Route path="calibration" element={<Calibration />} />
              <Route path="backtesting" element={<Backtesting />} />
              <Route path="planner" element={<Planner />} />
              <Route path="ai" element={<Navigate to="/market/screener" replace />} />
              <Route path="ai/:symbol" element={<AiRedirect />} />
              <Route path="index/:symbol" element={<IndexDetail />} />
              <Route path="autotrade" element={<AutoTrade />} />
              <Route path="settings" element={<MarketSettings />} />
              <Route path="*" element={<Navigate to="/market" replace />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}
