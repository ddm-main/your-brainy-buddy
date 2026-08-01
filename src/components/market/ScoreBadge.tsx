// 0–100 score chip with color ramp and component-breakdown tooltip.
import { useState } from "react";
import { BAND_COLOR, bandOf } from "@/lib/market/scoreBands";
import { useScoreBandCuts } from "@/lib/market/scoreHistory";

export function ScoreBadge({
  score,
  components,
  label,
  provisional,
  onClick,
}: {
  score: number | null | undefined;
  components?: Record<string, number> | null;
  label?: string;
  // True while only the neutral-context EOD pass has written this score —
  // sector strength / relative strength / regime are not in it yet.
  provisional?: boolean;
  // Default is hover-tooltip only (unchanged). When provided, the badge also
  // becomes clickable — stopPropagation so a badge nested in a clickable
  // table row navigates to ITS target, not the row's.
  onClick?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Cached query — every badge on a table shares the one distribution row.
  const { data: cuts } = useScoreBandCuts();
  if (score == null) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const band = bandOf(score, cuts);
  const color = BAND_COLOR[band];
  return (
    <span
      style={{ position: "relative", display: "inline-block" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
    >
      <span
        style={{
          display: "inline-block",
          minWidth: 34,
          textAlign: "center",
          padding: "1px 6px",
          borderRadius: 2,
          border: `1px solid ${color}`,
          color,
          fontFamily: "var(--font-hud)",
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
          background: "rgba(0,0,0,0.25)",
          cursor: onClick ? "pointer" : undefined,
        }}
        title={provisional
          ? "Provisional — computed before market context (sector/RS/regime) was applied"
          : onClick ? `Open score breakdown — ${band.toUpperCase()}` : undefined}
      >
        {score}{provisional ? "*" : ""}
      </span>
      {open && (provisional || (components && Object.keys(components).length > 0)) && (
        <span
          style={{
            position: "absolute",
            zIndex: 30,
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 190,
            padding: "8px 10px",
            background: "var(--bg-deep, #071019)",
            border: "1px solid var(--edge-strong)",
            borderRadius: 2,
            boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
            fontSize: 10,
            fontFamily: "var(--font-hud)",
            color: "var(--text-dim)",
            textAlign: "left",
          }}
        >
          {label && (
            <span style={{ display: "block", color: "var(--accent-soft)", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 6 }}>
              {label}
            </span>
          )}
          {provisional && (
            <span style={{ display: "block", color: "var(--warn)", marginBottom: 6 }}>
              Provisional — market context not applied yet
            </span>
          )}
          {Object.entries(components ?? {})
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => (
              <span key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "1px 0" }}>
                <span>{k.replace(/_/g, " ")}</span>
                <span style={{ color: v > 0 ? "var(--accent)" : "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                  {v > 0 ? `+${v}` : v}
                </span>
              </span>
            ))}
        </span>
      )}
    </span>
  );
}
