// Navbar chip for data-provider / feed health. Reads the stored self-test
// result (written by the scheduled `market-selftest` run) so it costs one
// small query, never a live probe, and clicks through to Market Config.
import { useNavigate } from "react-router-dom";
import { Activity } from "lucide-react";
import { useAccessStore } from "@/store/accessStore";
import { useSurfaceProbes, summarize } from "@/lib/market/selftest";

export default function FeedStatusChip() {
  const nav = useNavigate();
  const canSee = useAccessStore((s) => s.role === "admin" || s.sections?.has("market") === true);

  const { data: rows } = useSurfaceProbes();

  if (!canSee) return null;

  const s = rows ? summarize(rows) : null;
  const loading = !s || s.total === 0;
  const indexPrimaryDown = rows?.some((r: any) => r.surface === "index_quotes" && r.is_primary_path && r.ok === false) === true;

  const color = loading
    ? "var(--text-muted)"
    : indexPrimaryDown ? "var(--danger)"
    : s.down > 0 ? "var(--danger)"
    : s.degraded > 0 ? "var(--warn, #f5a524)"
    : "var(--ok, #38d39f)";

  const title = loading
    ? "Feed routing & providers — no self-test result yet"
    : `Feed routing & providers — ${s.ok}/${s.total} feeds healthy` +
      (s.degraded ? `, ${s.degraded} degraded` : "") +
      (s.down ? `, ${s.down} down` : "") +
      (indexPrimaryDown ? " · NSE index live feed down" : "") +
      (s.checkedAt ? ` · checked ${new Date(s.checkedAt).toLocaleTimeString()}` : "");

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
      <Activity size={11} />
      <span>{loading ? "—" : indexPrimaryDown ? "IDX DOWN" : `${s.ok}/${s.total}`}</span>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: `0 0 4px ${color}` }} />
    </button>
  );
}
