import type { CSSProperties, ReactNode } from "react";

/** Shared HUD form/UI atoms — restyled via .hud-* classes in styles.css. */

export const inputStyle: CSSProperties = {
  padding: "10px 12px",
  border: "1px solid var(--edge)",
  background: "rgba(255,255,255,0.02)",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "var(--font-hud)",
  outline: "none",
  borderRadius: 4,
  boxSizing: "border-box",
  minWidth: 0,
  transition: "border-color 180ms, box-shadow 180ms, color 180ms",
};
export const labelStyle: CSSProperties = {
  fontFamily: "var(--font-hud)",
  textTransform: "uppercase",
  letterSpacing: "0.2em",
  fontSize: 9,
  color: "var(--accent-soft)",
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
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  variant?: "primary" | "ghost" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  type?: "button" | "submit";
  style?: CSSProperties;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel ?? title}
      className="hud-btn focus-outline"
      data-variant={variant}
      data-size={size}
      style={style}
    >
      <span className="glint" aria-hidden />
      {children}
    </button>
  );
}

export function EmptyState({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: 8, padding: 24, textAlign: "center",
      color: "var(--text-muted)", fontSize: 12,
      border: "1px dashed var(--edge)", borderRadius: 2,
      fontFamily: "var(--font-hud)", letterSpacing: "0.16em", textTransform: "uppercase",
    }}>
      <div>· {children} ·</div>
      {hint && <div className="hud-label">{hint}</div>}
    </div>
  );
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "warn" | "err" | "ok" }) {
  return (
    <span className="hud-chip" data-tone={tone}>{children}</span>
  );
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="hud-h">{title}</div>
        {actions}
      </div>
      {children}
    </div>
  );
}
