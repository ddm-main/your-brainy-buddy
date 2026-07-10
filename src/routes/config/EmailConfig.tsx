import { Route, Routes, useLocation, useNavigate, NavLink } from "react-router-dom";
import { lazy, Suspense } from "react";

const EmailHome = lazy(() => import("@/routes/config/email/EmailHome"));
const EmailAccountsList = lazy(() => import("@/routes/config/email/EmailAccountsList"));
const RecentActivity = lazy(() => import("@/routes/config/email/RecentActivity"));

const SUBTABS = [
  { to: "/config/email",          label: "Home",     exact: true },
  { to: "/config/email/list",     label: "Mailboxes" },
  { to: "/config/email/activity", label: "Activity" },
];

function ListRoute() {
  const loc = useLocation();
  const addFlag = new URLSearchParams(loc.search).get("add") === "1";
  return <EmailAccountsList initialAddView={addFlag} />;
}

export default function EmailConfig() {
  const loc = useLocation();
  const nav = useNavigate();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          onClick={() => nav("/config")}
          className="hud-label"
          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: "4px 6px" }}
        >← config</button>
        <div style={{ display: "flex", gap: 4 }}>
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
            <Route index element={<EmailHome />} />
            <Route path="list" element={<ListRoute />} />
            <Route path="activity" element={<RecentActivity />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}
