import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import Overview from "@/routes/finance/Overview";
import Accounts from "@/routes/finance/Accounts";
import Cards from "@/routes/finance/Cards";
import Loans from "@/routes/finance/Loans";
import Goals from "@/routes/finance/Goals";
import Subs from "@/routes/finance/Subs";
import Txns from "@/routes/finance/Txns";
import Statements from "@/routes/finance/Statements";
import CardDetail from "@/routes/finance/CardDetail";
import LoanDetail from "@/routes/finance/LoanDetail";

const TABS = [
  { to: "/finance", label: "Overview", key: "overview" },
  { to: "/finance/accounts", label: "Accounts", key: "accounts" },
  { to: "/finance/cards", label: "Cards", key: "cards" },
  { to: "/finance/loans", label: "Loans", key: "loans" },
  { to: "/finance/goals", label: "Goals", key: "goals" },
  { to: "/finance/subs", label: "Subs", key: "subs" },
  { to: "/finance/txns", label: "Transactions", key: "txns" },
  { to: "/finance/statements", label: "Statements", key: "statements" },
];

export default function Finance() {
  const loc = useLocation();
  return (
    <div style={{ padding: 12, height: "100%", display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {TABS.map((t) => {
          const active = t.to === "/finance" ? loc.pathname === "/finance" : loc.pathname.startsWith(t.to);
          return (
            <NavLink key={t.key} to={t.to} end={t.to === "/finance"}
              style={{
                padding: "6px 12px", border: `1px solid ${active ? "var(--edge-strong)" : "var(--edge)"}`,
                background: active ? "rgba(53,214,237,0.08)" : "transparent",
                color: active ? "var(--accent)" : "var(--text-dim)",
                fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em",
                textTransform: "uppercase", textDecoration: "none", borderRadius: 2,
              }}>{t.label}</NavLink>
          );
        })}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Routes>
          <Route index element={<Overview />} />
          <Route path="accounts" element={<Accounts />} />
          <Route path="cards" element={<Cards />} />
          <Route path="cards/:id" element={<CardDetail />} />
          <Route path="loans" element={<Loans />} />
          <Route path="loans/:id" element={<LoanDetail />} />
          <Route path="goals" element={<Goals />} />
          <Route path="subs" element={<Subs />} />
          <Route path="txns" element={<Txns />} />
          <Route path="statements" element={<Statements />} />
        </Routes>
      </div>
    </div>
  );
}
