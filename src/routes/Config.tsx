import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { lazy, Suspense } from "react";

const EmailConfig = lazy(() => import("@/routes/config/EmailConfig"));
const BanksConfig = lazy(() => import("@/routes/config/BanksConfig"));
const AccountsConfig = lazy(() => import("@/routes/config/AccountsConfig"));
const CardsConfig = lazy(() => import("@/routes/config/CardsConfig"));
const LoansConfig = lazy(() => import("@/routes/config/LoansConfig"));
const GoalsConfig = lazy(() => import("@/routes/config/GoalsConfig"));
const SubscriptionsConfig = lazy(() => import("@/routes/config/SubscriptionsConfig"));
const ProjectsConfig = lazy(() => import("@/routes/config/ProjectsConfig"));

const TABS = [
  { to: "/config/email", label: "Email" },
  { to: "/config/banks", label: "Banks" },
  { to: "/config/accounts", label: "Accounts" },
  { to: "/config/cards", label: "Cards" },
  { to: "/config/loans", label: "Loans" },
  { to: "/config/goals", label: "Goals" },
  { to: "/config/subscriptions", label: "Subscriptions" },
  { to: "/config/projects", label: "Projects" },
];

export default function Config() {
  const loc = useLocation();
  return (
    <div style={{ padding: 12, height: "100%", display: "grid", gridTemplateColumns: "180px 1fr", gap: 12, minHeight: 0 }}>
      <nav style={{ display: "flex", flexDirection: "column", gap: 4, borderRight: "1px solid var(--edge)", paddingRight: 8 }}>
        <div className="hud-label" style={{ padding: "4px 8px", color: "var(--accent)" }}>Config</div>
        {TABS.map((t) => {
          const active = loc.pathname === t.to || loc.pathname.startsWith(t.to + "/");
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
            <Route index element={<Navigate to="/config/email" replace />} />
            <Route path="email" element={<EmailConfig />} />
            <Route path="banks" element={<BanksConfig />} />
            <Route path="accounts" element={<AccountsConfig />} />
            <Route path="cards" element={<CardsConfig />} />
            <Route path="loans" element={<LoansConfig />} />
            <Route path="goals" element={<GoalsConfig />} />
            <Route path="subscriptions" element={<SubscriptionsConfig />} />
            <Route path="projects" element={<ProjectsConfig />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}