import { Route, Routes, useLocation, useNavigate, NavLink } from "react-router-dom";
import { lazy, Suspense } from "react";

const FinanceHome = lazy(() => import("@/routes/config/finance/FinanceHome"));
const BanksConfig = lazy(() => import("@/routes/config/BanksConfig"));
const AccountsConfig = lazy(() => import("@/routes/config/AccountsConfig"));
const CardsConfig = lazy(() => import("@/routes/config/CardsConfig"));
const LoansConfig = lazy(() => import("@/routes/config/LoansConfig"));
const GoalsConfig = lazy(() => import("@/routes/config/GoalsConfig"));
const SubscriptionsConfig = lazy(() => import("@/routes/config/SubscriptionsConfig"));

const SUBTABS = [
  { to: "/config/finance", label: "Home", exact: true },
  { to: "/config/finance/banks", label: "Banks" },
  { to: "/config/finance/accounts", label: "Accounts" },
  { to: "/config/finance/cards", label: "Cards" },
  { to: "/config/finance/loans", label: "Loans" },
  { to: "/config/finance/goals", label: "Goals" },
  { to: "/config/finance/subscriptions", label: "Subscriptions" },
];

export default function FinanceConfig() {
  const loc = useLocation();
  const nav = useNavigate();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <button
          onClick={() => nav("/config")}
          className="hud-label"
          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: "4px 6px" }}
        >← config</button>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {SUBTABS.map((t) => {
            const active = t.exact ? loc.pathname === t.to || loc.pathname === t.to + "/" : loc.pathname.startsWith(t.to);
            return (
              <NavLink key={t.to} to={t.to} end={t.exact} style={{
                padding: "4px 10px", textDecoration: "none",
                border: `1px solid ${active ? "var(--edge-strong)" : "var(--edge)"}`,
                background: active ? "rgba(53,214,237,0.08)" : "transparent",
                color: active ? "var(--accent)" : "var(--text-dim)",
                fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase",
              }}>{t.label}</NavLink>
            );
          })}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Suspense fallback={<div className="hud-label">loading…</div>}>
          <Routes>
            <Route index element={<FinanceHome />} />
            <Route path="banks" element={<BanksConfig />} />
            <Route path="accounts" element={<AccountsConfig />} />
            <Route path="cards" element={<CardsConfig />} />
            <Route path="loans" element={<LoansConfig />} />
            <Route path="goals" element={<GoalsConfig />} />
            <Route path="subscriptions" element={<SubscriptionsConfig />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}
