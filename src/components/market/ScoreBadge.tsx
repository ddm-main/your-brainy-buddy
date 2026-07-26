// 0–100 score chip with color ramp and component-breakdown tooltip.
import { useState } from "react";

function rampColor(score: number): string {
  if (score >= 70) return "var(--ok)";
  if (score >= 50) return "var(--accent)";
  if (score >= 30) return "var(--warn)";
  return "var(--danger)";
}

export function ScoreBadge({
  score,
  components,
  label,
  onClick,
}: {
  score: number | null | undefined;
  components?: Record<string, number> | null;
  label?: string;
  // Default is hover-tooltip only (unchanged). When provided, the badge also
  // becomes clickable — stopPropagation so a badge nested in a clickable
  // table row navigates to ITS target, not the row's.
  onClick?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (score == null) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const color = rampColor(score);
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
        title={onClick ? "Open AI score analysis" : undefined}
      >
        {score}
      </span>
      {open && components && Object.keys(components).length > 0 && (
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
          {Object.entries(components)
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
