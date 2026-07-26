import { Navigate, useLocation } from "react-router-dom";
import { useAccessStore, type AppSection } from "@/store/accessStore";

export default function AccessGate({ section, children }: { section: AppSection; children: React.ReactNode }) {
  const { ready, sections, role } = useAccessStore();
  const loc = useLocation();
  if (!ready) return null;
  // Admins retain access to /config as a self-lockout safety net; every other
  // section gates strictly on granted `sections`.
  if (sections.has(section) || (role === "admin" && section === "config")) return <>{children}</>;
  const fallback = sections.has("market") ? "/market" : (Array.from(sections)[0] ? `/${Array.from(sections)[0]}` : "/");
  if (loc.pathname === fallback) return null;
  return <Navigate to={fallback} replace />;
}
