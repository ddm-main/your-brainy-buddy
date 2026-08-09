// Latency / outcome history for one provider's probes. The surface table only
// keeps the LAST result per surface (it is upserted), so trend has to come
// from the append-only market_provider_health log.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ago } from "./providerUtils";

type Point = { ok: boolean; latency_ms: number | null; created_at: string };

export default function HealthSparkline({ provider }: { provider: string }) {
  const { data } = useQuery({
    queryKey: ["market", "provider-health-history", provider],
    queryFn: async () => {
      // EGRESS: 40 points is plenty for a 240 px sparkline, and `endpoint` was
      // never rendered — it was pure payload.
      const { data, error } = await supabase
        .from("market_provider_health")
        .select("ok, latency_ms, created_at")
        .eq("provider", provider)
        .order("created_at", { ascending: false })
        .limit(40);
      if (error) throw error;
      return ((data ?? []) as Point[]).slice().reverse();
    },
    staleTime: 60_000,
    refetchInterval: 300_000,
  });

  const points = data ?? [];
  if (points.length < 2) return null;

  const lats = points.map((p) => p.latency_ms ?? 0);
  const max = Math.max(...lats, 1);
  const okRate = Math.round((points.filter((p) => p.ok).length / points.length) * 100);
  const avg = Math.round(lats.reduce((a, b) => a + b, 0) / lats.length);

  const W = 240, H = 34;
  const step = W / (points.length - 1);
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(H - ((p.latency_ms ?? 0) / max) * (H - 4) - 2).toFixed(1)}`)
    .join(" ");

  return (
    <div>
      <div className="hud-label" style={{ color: "var(--text-muted)", marginBottom: 4 }}>
        Latency trend — last {points.length} probes
      </div>
      <svg width={W} height={H} style={{ display: "block", overflow: "visible" }} role="img" aria-label="probe latency trend">
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={1.2} />
        {points.map((p, i) => (
          !p.ok ? (
            <rect key={p.created_at + i} x={i * step - 1} y={0} width={2} height={H} fill="var(--danger)" opacity={0.55}>
              <title>{`${new Date(p.created_at).toLocaleString()} — failed`}</title>
            </rect>
          ) : null
        ))}
      </svg>
      <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3 }}>
        {okRate}% success · avg {avg} ms · peak {max} ms · newest {ago(points[points.length - 1].created_at)}
      </div>
    </div>
  );
}
