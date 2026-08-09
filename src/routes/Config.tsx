import { NavLink, Route, Routes, useLocation, Navigate } from "react-router-dom";
import { lazy, Suspense } from "react";
import { useAccessStore } from "@/store/accessStore";

const SystemDataConfig = lazy(() => import("@/routes/config/SystemDataConfig"));
const AdminConfig = lazy(() => import("@/routes/config/AdminConfig"));

const TABS = [
  { to: "/config/feeds", label: "Feeds & Providers" },
  { to: "/config/pipeline", label: "Data Pipeline" },
  { to: "/config/storage", label: "Storage & Quota" },
  { to: "/config/users", label: "Users" },
];

const tabBase: React.CSSProperties = {
  padding: "6px 12px", fontFamily: "var(--font-hud)", fontSize: 10,
  letterSpacing: "0.18em", textTransform: "uppercase", textDecoration: "none",
  borderRadius: 2, cursor: "pointer", transition: "background 120ms, color 120ms",
};

export default function Config() {
  const loc = useLocation();
  const isAdmin = useAccessStore((s) => s.role === "admin");
  if (!isAdmin) return <Navigate to="/market" replace />;
  return (
    <div style={{ padding: 12, height: "100%", display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
      <div role="tablist" aria-label="Admin config sections" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {TABS.map((t) => {
          const active = loc.pathname === t.to || loc.pathname.startsWith(t.to + "/");
          return (
            <NavLink key={t.to} to={t.to} role="tab" aria-selected={active}
              style={{
                ...tabBase,
                border: `1px solid ${active ? "var(--edge-strong)" : "var(--edge)"}`,
                background: active ? "rgba(53,214,237,0.08)" : "transparent",
                color: active ? "var(--accent)" : "var(--text-dim)",
              }}>{t.label}</NavLink>
          );
        })}
      </div>
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "auto" }}>
        <Suspense fallback={<div className="hud-label">loading…</div>}>
          <Routes>
            <Route index element={<Navigate to="/config/feeds" replace />} />
            <Route path="feeds" element={<SystemDataConfig view="feeds" />} />
            <Route path="pipeline" element={<SystemDataConfig view="pipeline" />} />
            <Route path="storage" element={<SystemDataConfig view="storage" />} />
            <Route path="users" element={<AdminConfig />} />
            {/* Legacy links keep working. */}
            <Route path="system-data" element={<Navigate to="/config/feeds" replace />} />
            <Route path="market" element={<Navigate to="/config/feeds" replace />} />
            <Route path="admin" element={<Navigate to="/config/users" replace />} />
            <Route path="*" element={<Navigate to="/config/feeds" replace />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}
