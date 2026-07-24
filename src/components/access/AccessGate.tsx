import { Navigate, useLocation } from "react-router-dom";
import { useAccessStore, type AppSection } from "@/store/accessStore";

export default function AccessGate({ section, children }: { section: AppSection; children: React.ReactNode }) {
  const { ready, sections, role } = useAccessStore();
  const loc = useLocation();
  if (!ready) return null;
  if (role === "admin" || sections.has(section)) return <>{children}</>;
  const fallback = sections.has("market") ? "/market" : (Array.from(sections)[0] ? `/${Array.from(sections)[0]}` : "/");
  if (loc.pathname === fallback) return null;
  return <Navigate to={fallback} replace />;
}
