// Market — top-tab layout mirroring Finance (no left sidebar).
import { useEffect, useRef } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { lazy, Suspense } from "react";
import ErrorBoundary from "@/components/hud/ErrorBoundary";
import { useMarketAutoSync } from "@/lib/market/useAutoSync";
import { useRealtimeTicks } from "@/lib/market/useRealtimeTicks";

const Dashboard = lazy(() => import("@/routes/market/Dashboard"));
const Holdings = lazy(() => import("@/routes/market/Holdings"));
const Positions = lazy(() => import("@/routes/market/Positions"));
const Screener = lazy(() => import("@/routes/market/Screener"));
const Analysis = lazy(() => import("@/routes/market/Analysis"));
const Backtesting = lazy(() => import("@/routes/market/Backtesting"));
const MarketSettings = lazy(() => import("@/routes/market/Settings"));
const Planner = lazy(() => import("@/routes/market/Planner"));
const AIEngine = lazy(() => import("@/routes/market/AIEngine"));
const IndexDetail = lazy(() => import("@/routes/market/IndexDetail"));
const AutoTrade = lazy(() => import("@/routes/market/AutoTrade"));


type Sub = { to: string; label: string };
type Group = {
  key: string; label: string; to: string;
  match: (p: string) => boolean;
  subs: Sub[];
};

const GROUPS: Group[] = [
  { key: "overview", label: "Overview", to: "/market",
    match: (p) => p === "/market" || p === "/market/" || /^\/market\/index\//.test(p), subs: [] },
  { key: "screener", label: "Screener", to: "/market/screener",
    match: (p) => /^\/market\/screener/.test(p), subs: [] },
  { key: "portfolio", label: "Portfolio", to: "/market/holdings",
    match: (p) => /^\/market\/(holdings|positions)/.test(p),
    subs: [
      { to: "/market/holdings", label: "Holdings" },
      { to: "/market/positions", label: "Positions" },
    ] },
  { key: "autotrade", label: "AutoTrade", to: "/market/autotrade",
    match: (p) => /^\/market\/autotrade/.test(p), subs: [] },
  { key: "settings", label: "Config", to: "/market/settings",
    match: (p) => /^\/market\/settings/.test(p), subs: [] },
];

const tabBase: React.CSSProperties = {
  padding: "6px 12px", fontFamily: "var(--font-hud)", fontSize: 10,
  letterSpacing: "0.18em", textTransform: "uppercase", textDecoration: "none",
  borderRadius: 2, cursor: "pointer", transition: "background 120ms, color 120ms",
};

function SubTabStrip({ subs, currentPath }: { subs: Sub[]; currentPath: string }) {
  const nav = useNavigate();
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);
  const activeIdx = Math.max(
    0,
    subs.findIndex((s) => currentPath === s.to || currentPath.startsWith(s.to + "/")),
  );

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
            ref={(el) => (refs.current[i] = el)}
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
  const activeGroup = GROUPS.find((g) => g.match(loc.pathname)) ?? GROUPS[0];
  useEffect(() => { document.title = `Market · ${activeGroup.label}`; }, [activeGroup.key]);
  useMarketAutoSync();
  useRealtimeTicks();


  return (
    <div style={{ padding: 12, height: "100%", display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
      <div role="tablist" aria-label="Market sections" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {GROUPS.map((g) => {
          const active = g.key === activeGroup.key;
          return (
            <NavLink key={g.key} to={g.to} end={g.to === "/market"} role="tab" aria-selected={active}
              style={{
                ...tabBase,
                border: `1px solid ${active ? "var(--edge-strong)" : "var(--edge)"}`,
                background: active ? "rgba(53,214,237,0.08)" : "transparent",
                color: active ? "var(--accent)" : "var(--text-dim)",
              }}>{g.label}</NavLink>
          );
        })}
      </div>
      {activeGroup.subs.length > 0 && (
        <SubTabStrip subs={activeGroup.subs} currentPath={loc.pathname} />
      )}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "auto" }}>
        <ErrorBoundary key={loc.pathname}>
          <Suspense fallback={<div className="hud-label">loading…</div>}>
            <Routes>
              <Route index element={<Dashboard />} />
              <Route path="holdings" element={<Holdings />} />
              <Route path="positions" element={<Positions />} />
              <Route path="screener" element={<Screener />} />
              <Route path="analysis" element={<Navigate to="/market/screener" replace />} />
              <Route path="analysis/:symbol" element={<Analysis />} />
              <Route path="backtesting" element={<Backtesting />} />
              <Route path="planner" element={<Planner />} />
              <Route path="ai" element={<AIEngine />} />
              <Route path="ai/:symbol" element={<AIEngine />} />
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
