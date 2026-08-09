// Navbar chip for data-provider / feed health. Reads the SAME shared status
// engine Feed Routing uses (`useFeedStatus`), so the header number and the
// panel can never disagree again — both are "x of N platform feeds healthy".
import { useNavigate } from "react-router-dom";
import { Activity } from "lucide-react";
import { useAccessStore } from "@/store/accessStore";
import { useFeedStatus } from "@/lib/market/feedStatus";

export default function FeedStatusChip() {
  const nav = useNavigate();
  const canSee = useAccessStore((s) => s.role === "admin" || s.sections?.has("market") === true);

  const { tally, accountTally, checkedAt, loading, sessionOpen, holiday } = useFeedStatus();

  if (!canSee) return null;

  const empty = loading || tally.total === 0;

  // Red only when a PLATFORM feed has no working provider. Problems limited to
  // your own broker account are amber, not a platform outage — and the number
  // shown next to it makes clear which tally is unhealthy.
  const accountIssues = accountTally.down + accountTally.delayed + accountTally.notSet;
  const allHealthy = tally.ok === tally.total && accountIssues === 0;
  const color = empty
    ? "var(--text-muted)"
    : allHealthy ? "var(--ok, #38d39f)"
    : tally.down > 0 ? "var(--danger)"
    : "var(--warn, #f5a524)";


  const title = empty
    ? "Feed routing & providers — no self-test result yet"
    : `Platform feeds — ${tally.ok}/${tally.total} healthy (${tally.live} active` +
      (tally.fallback ? `, ${tally.fallback} on fallback` : "") +
      (tally.idle ? `, ${tally.idle} idle` : "") + ")" +
      (tally.delayed ? `, ${tally.delayed} delayed` : "") +
      (tally.down ? `, ${tally.down} down` : "") +
      (tally.notSet ? `, ${tally.notSet} not configured` : "") +
      (tally.affected.length ? ` · ${tally.affected.join(", ")}` : "") +
      ` · Your broker account: ${accountTally.ok}/${accountTally.total} healthy` +
      (accountTally.down ? `, ${accountTally.down} down` : "") +
      (accountTally.delayed ? `, ${accountTally.delayed} delayed` : "") +
      (accountTally.notSet ? `, ${accountTally.notSet} not configured` : "") +
      (accountTally.affected.length ? ` (${accountTally.affected.join(", ")})` : "") +
      ` · ${holiday ? "NSE holiday" : sessionOpen ? "session open" : "session closed"}` +
      (checkedAt ? ` · checked ${new Date(checkedAt).toLocaleTimeString()}` : "");

  return (
    <button
      className="focus-outline"
      title={title}
      onClick={() => nav("/config/feeds")}
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
      <span>{empty ? "—" : `${tally.ok}/${tally.total}`}</span>
      {!empty && accountIssues > 0 && (
        <span style={{ opacity: 0.85 }}>· acct {accountTally.ok}/{accountTally.total}</span>
      )}

      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: `0 0 4px ${color}` }} />
    </button>
  );
}
