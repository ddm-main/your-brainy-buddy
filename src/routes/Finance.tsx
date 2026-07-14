import { useEffect, useRef } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import CommandCenter from "@/routes/finance/CommandCenter";
import Accounts from "@/routes/finance/Accounts";
import Cards from "@/routes/finance/Cards";
import Loans from "@/routes/finance/Loans";
import Goals from "@/routes/finance/Goals";
import Subs from "@/routes/finance/Subs";
import Txns from "@/routes/finance/Txns";
import Statements from "@/routes/finance/Statements";
import CardDetail from "@/routes/finance/CardDetail";
import LoanDetail from "@/routes/finance/LoanDetail";
import AccountDetail from "@/routes/finance/AccountDetail";
import GoalDetail from "@/routes/finance/GoalDetail";
import Investments from "@/routes/finance/Investments";
import InvestmentDetail from "@/routes/finance/InvestmentDetail";
import Budget from "@/routes/finance/Budget";
import TaxCenter from "@/routes/finance/TaxCenter";
import Insurance from "@/routes/finance/Insurance";
import Reports from "@/routes/finance/Reports";
import Intelligence from "@/routes/finance/Intelligence";

// F1: collapse to 7 industry-standard sections. Command Center is the
// default landing; every legacy path still resolves (either directly or
// via redirect) so bookmarks and Overview tiles keep working.
type Sub = { to: string; label: string };
type Group = {
  key: string; label: string; to: string;
  match: (p: string) => boolean;
  subs: Sub[];
};

const GROUPS: Group[] = [
  { key: "command", label: "Command", to: "/finance",
    match: (p) => p === "/finance", subs: [] },
  { key: "banking", label: "Banking", to: "/finance/accounts",
    match: (p) => /^\/finance\/(accounts|cards|loans|statements)/.test(p),
    subs: [
      { to: "/finance/accounts", label: "Accounts" },
      { to: "/finance/cards", label: "Cards" },
      { to: "/finance/loans", label: "Loans" },
      { to: "/finance/statements", label: "Statements" },
    ] },
  { key: "investments", label: "Investments", to: "/finance/investments",
    match: (p) => /^\/finance\/investments/.test(p), subs: [] },
  { key: "spending", label: "Spending", to: "/finance/txns",
    match: (p) => /^\/finance\/(txns|subs)/.test(p),
    subs: [
      { to: "/finance/txns", label: "Transactions" },
      { to: "/finance/subs", label: "Subscriptions" },
    ] },
  { key: "planning", label: "Planning", to: "/finance/budget",
    match: (p) => /^\/finance\/(budget|goals|insurance)/.test(p),
    subs: [
      { to: "/finance/budget", label: "Budget" },
      { to: "/finance/goals", label: "Goals" },
      { to: "/finance/insurance", label: "Insurance" },
    ] },
  { key: "intelligence", label: "Intelligence", to: "/finance/intelligence",
    match: (p) => /^\/finance\/intelligence/.test(p), subs: [] },
  { key: "reports", label: "Reports", to: "/finance/reports",
    match: (p) => /^\/finance\/(reports|tax)/.test(p),
    subs: [
      { to: "/finance/reports", label: "Reports" },
      { to: "/finance/tax", label: "Tax Center" },
    ] },
];

const tabBase: React.CSSProperties = {
  padding: "6px 12px", fontFamily: "var(--font-hud)", fontSize: 10,
  letterSpacing: "0.18em", textTransform: "uppercase", textDecoration: "none",
  borderRadius: 2, cursor: "pointer", transition: "background 120ms, color 120ms",
};

// Arrow-key navigation for the sub-tab strip (F-AX-1). Left/Right move
// focus and activate; Home/End jump to ends. Matches WAI-ARIA tablist.
function SubTabStrip({ subs, currentPath }: { subs: Sub[]; currentPath: string }) {
  const nav = useNavigate();
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);
  const activeIdx = Math.max(0, subs.findIndex((s) => currentPath === s.to || currentPath.startsWith(s.to + "/")));

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
    <div role="tablist" aria-label="Finance sub-navigation"
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

export default function Finance() {
  const loc = useLocation();
  const activeGroup = GROUPS.find((g) => g.match(loc.pathname)) ?? GROUPS[0];
  // Keep the document title in sync so browser history entries are readable.
  useEffect(() => { document.title = `Finance · ${activeGroup.label}`; }, [activeGroup.key]);

  return (
    <div style={{ padding: 12, height: "100%", display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
      <div role="tablist" aria-label="Finance sections" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {GROUPS.map((g) => {
          const active = g.key === activeGroup.key;
          return (
            <NavLink key={g.key} to={g.to} end={g.to === "/finance"} role="tab" aria-selected={active}
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
      <div style={{ flex: 1, minHeight: 0 }}>
        <Routes>
          <Route index element={<CommandCenter />} />
          {/* F1 legacy redirects — old bookmarks keep working. */}
          <Route path="overview" element={<Navigate to="/finance" replace />} />
          <Route path="command" element={<Navigate to="/finance" replace />} />

          <Route path="accounts" element={<Accounts />} />
          <Route path="accounts/:id" element={<AccountDetail />} />
          <Route path="cards" element={<Cards />} />
          <Route path="cards/:id" element={<CardDetail />} />
          <Route path="loans" element={<Loans />} />
          <Route path="loans/:id" element={<LoanDetail />} />
          <Route path="statements" element={<Statements />} />

          <Route path="investments" element={<Investments />} />
          <Route path="investments/:id" element={<InvestmentDetail />} />

          <Route path="txns" element={<Txns />} />
          <Route path="subs" element={<Subs />} />

          <Route path="budget" element={<Budget />} />
          <Route path="goals" element={<Goals />} />
          <Route path="goals/:id" element={<GoalDetail />} />
          <Route path="insurance" element={<Insurance />} />

          <Route path="intelligence" element={<Intelligence />} />

          <Route path="reports" element={<Reports />} />
          <Route path="tax" element={<TaxCenter />} />
        </Routes>
      </div>
    </div>
  );
}
