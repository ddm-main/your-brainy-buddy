import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { lazy, Suspense } from "react";

const EmailConfig = lazy(() => import("@/routes/config/EmailConfig"));
const ConfigHome = lazy(() => import("@/routes/config/ConfigHome"));
const FinanceConfig = lazy(() => import("@/routes/config/FinanceConfig"));
const ProjectsConfig = lazy(() => import("@/routes/config/ProjectsConfig"));

const TABS = [
  { to: "/config", label: "Home", exact: true },
  { to: "/config/email", label: "Email" },
  { to: "/config/finance", label: "Finance" },
  { to: "/config/projects", label: "Projects" },
] as { to: string; label: string; exact?: boolean }[];

export default function Config() {
  const loc = useLocation();
  return (
    <div style={{ padding: 12, height: "100%", display: "grid", gridTemplateColumns: "180px 1fr", gap: 12, minHeight: 0 }}>
      <nav style={{ display: "flex", flexDirection: "column", gap: 4, borderRight: "1px solid var(--edge)", paddingRight: 8 }}>
        <div className="hud-label" style={{ padding: "4px 8px", color: "var(--accent)" }}>Config</div>
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
      <div style={{ minHeight: 0, minWidth: 0 }}>
        <Suspense fallback={<div className="hud-label">loading…</div>}>
          <Routes>
            <Route index element={<ConfigHome />} />
            <Route path="email/*" element={<EmailConfig />} />
            <Route path="finance/*" element={<FinanceConfig />} />
            <Route path="projects" element={<ProjectsConfig />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}