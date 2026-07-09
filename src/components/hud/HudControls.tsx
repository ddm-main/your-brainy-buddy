import type { CSSProperties, ReactNode } from "react";

/** Small shared HUD form/UI atoms — cyan theme, dense, keyboard-friendly. */

export const inputStyle: CSSProperties = {
  padding: "8px 10px",
  border: "1px solid var(--edge)",
  background: "rgba(3, 8, 18, 0.5)",
  color: "var(--text)",
  fontSize: 12,
  fontFamily: "var(--font-body)",
  outline: "none",
  borderRadius: 2,
  transition: "border-color 150ms",
};

export const labelStyle: CSSProperties = {
  fontFamily: "var(--font-hud)",
  textTransform: "uppercase",
  letterSpacing: "0.16em",
  fontSize: 9,
  color: "var(--text-dim)",
  marginBottom: 4,
  display: "block",
};

export function Btn({
  children,
  onClick,
  variant = "ghost",
  size = "md",
  disabled,
  type = "button",
  style,
  title,
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  variant?: "primary" | "ghost" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  type?: "button" | "submit";
  style?: CSSProperties;
  title?: string;
}) {
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: size === "sm" ? "4px 8px" : "6px 12px",
    fontSize: size === "sm" ? 10 : 11,
    fontFamily: "var(--font-hud)",
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    border: "1px solid var(--edge)",
    borderRadius: 2,
    color: "var(--text-dim)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    transition: "all 180ms",
    background: "transparent",
  };
  if (variant === "primary") {
    base.color = "var(--accent)";
    base.borderColor = "var(--edge-strong)";
    base.background = "rgba(53, 214, 237, 0.08)";
  } else if (variant === "danger") {
    base.color = "var(--danger)";
    base.borderColor = "rgba(255,95,109,0.35)";
  }
  return (
    <button type={type} disabled={disabled} onClick={onClick} title={title} className="focus-outline" style={{ ...base, ...style }}>
      {children}
    </button>
  );
}

export function EmptyState({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: 6, padding: 20, textAlign: "center",
      color: "var(--text-muted)", fontSize: 12,
    }}>
      <div>{children}</div>
      {hint && <div className="hud-label">{hint}</div>}
    </div>
  );
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "warn" | "err" | "ok" }) {
  const map = {
    neutral: { c: "var(--text-dim)", b: "var(--edge)" },
    accent: { c: "var(--accent)", b: "var(--edge-strong)" },
    warn: { c: "var(--warn)", b: "rgba(255,184,77,0.35)" },
    err: { c: "var(--danger)", b: "rgba(255,95,109,0.35)" },
    ok: { c: "var(--ok)", b: "rgba(107,255,176,0.35)" },
  }[tone];
  return (
    <span style={{
      padding: "2px 6px", border: `1px solid ${map.b}`, color: map.c,
      fontSize: 9, fontFamily: "var(--font-hud)", letterSpacing: "0.14em",
      textTransform: "uppercase", borderRadius: 2, whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="h-title" style={{ fontSize: 10 }}><span className="live-dot" style={{ background: "var(--accent)", color: "var(--accent)" }} />{title}</div>
        {actions}
      </div>
      {children}
    </div>
  );
}
