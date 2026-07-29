// Compact free-plan quota indicator for the top navbar.
// Reuses the same `quota_report` RPC as the DatabaseStoragePanel via a
// shared react-query key so both dedupe on the same request.
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Database } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAccessStore } from "@/store/accessStore";

type QuotaReport = {
  db_bytes?: number | string;
  db_limit_bytes?: number | string;
  storage_bytes?: number | string;
  storage_limit_bytes?: number | string;
};

function pct(used: number, limit: number) {
  if (!limit) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

export default function QuotaStatusChip() {
  const nav = useNavigate();
  const role = useAccessStore((s) => s.role);
  const isAdmin = role === "admin";

  const { data } = useQuery({
    queryKey: ["system", "quota-report"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("quota_report");
      if (error) throw error;
      return data as QuotaReport;
    },
    refetchInterval: 120_000,
    staleTime: 60_000,
    enabled: isAdmin,
  });

  if (!isAdmin) return null;

  const loading = !data;
  const db = pct(Number(data?.db_bytes ?? 0), Number(data?.db_limit_bytes ?? 500 * 1024 * 1024));
  const store = pct(Number(data?.storage_bytes ?? 0), Number(data?.storage_limit_bytes ?? 1024 ** 3));
  const worst = Math.max(db, store);

  const color = loading
    ? "var(--text-muted)"
    : worst >= 80 ? "var(--danger)" : worst >= 65 ? "var(--warn, #f5a524)" : "var(--ok, #38d39f)";
  const title = loading
    ? "Free-plan quota — loading"
    : `Free-plan quota — DB ${db}% · Storage ${store}%`;

  return (
    <button
      className="focus-outline"
      title={title}
      onClick={() => nav("/config/system-data")}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "4px 8px", border: "1px solid var(--edge)", borderRadius: 2,
        background: "transparent", cursor: "pointer",
        fontSize: 9, fontFamily: "var(--font-hud)", letterSpacing: "0.18em",
        textTransform: "uppercase", color,
      }}
      aria-label={title}
    >
      <Database size={11} />
      <span>{loading ? "—" : `${worst}%`}</span>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: `0 0 4px ${color}` }} />
    </button>
  );
}
