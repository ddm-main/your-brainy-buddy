import { NavLink } from "react-router-dom";

export function ConfigureCTA({ to, label }: { to: string; label: string }) {
  return (
    <NavLink to={to} style={{
      fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em",
      textTransform: "uppercase", color: "var(--accent)", textDecoration: "none",
      padding: "4px 8px", border: "1px solid var(--edge)",
    }}>{label} →</NavLink>
  );
}

export function utilTone(pct: number | null): "neutral" | "ok" | "warn" | "err" {
  if (pct == null) return "neutral";
  if (pct < 30) return "ok";
  if (pct < 70) return "warn";
  return "err";
}

export function sourceTone(source: string | null | undefined): "neutral" | "ok" | "accent" | "warn" {
  if (!source) return "neutral";
  if (source === "manual") return "neutral";
  if (source === "statement") return "ok";
  if (source === "reconciled") return "accent";
  return "warn";
}
