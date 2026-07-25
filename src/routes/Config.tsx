import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { lazy, Suspense } from "react";

const EmailConfig = lazy(() => import("@/routes/config/EmailConfig"));
const ConfigHome = lazy(() => import("@/routes/config/ConfigHome"));
const FinanceConfig = lazy(() => import("@/routes/config/FinanceConfig"));
const ProjectsConfig = lazy(() => import("@/routes/config/ProjectsConfig"));
const MarketConfig = lazy(() => import("@/routes/config/MarketConfig"));

const TABS = [
  { to: "/config", label: "Home", exact: true },
  { to: "/config/email", label: "Email" },
  { to: "/config/finance", label: "Finance" },
  { to: "/config/projects", label: "Projects" },
  { to: "/config/market", label: "Market" },
] as { to: string; label: string; exact?: boolean }[];

const tabBase: React.CSSProperties = {
  padding: "6px 12px", fontFamily: "var(--font-hud)", fontSize: 10,
  letterSpacing: "0.18em", textTransform: "uppercase", textDecoration: "none",
  borderRadius: 2, cursor: "pointer", transition: "background 120ms, color 120ms",
};

export default function Config() {
  const loc = useLocation();
  return (
    <div style={{ padding: 12, height: "100%", display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
      <div role="tablist" aria-label="Config sections" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {TABS.map((t) => {
          const active = t.exact
            ? loc.pathname === t.to || loc.pathname === t.to + "/"
            : loc.pathname === t.to || loc.pathname.startsWith(t.to + "/");
          return (
            <NavLink key={t.to} to={t.to} end={t.exact} role="tab" aria-selected={active}
              style={{
                ...tabBase,
                border: `1px solid ${active ? "var(--edge-strong)" : "var(--edge)"}`,
                background: active ? "rgba(53,214,237,0.08)" : "transparent",
                color: active ? "var(--accent)" : "var(--text-dim)",
              }}>{t.label}</NavLink>
          );
        })}
      </div>
      <div style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        <Suspense fallback={<div className="hud-label">loading…</div>}>
          <Routes>
            <Route index element={<ConfigHome />} />
            <Route path="email/*" element={<EmailConfig />} />
            <Route path="finance/*" element={<FinanceConfig />} />
            <Route path="projects" element={<ProjectsConfig />} />
            <Route path="market" element={<MarketConfig />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}
