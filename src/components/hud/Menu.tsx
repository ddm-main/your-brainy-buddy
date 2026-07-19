import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { useLocation } from "react-router-dom";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Small popover primitive used by the TradingView-style chart toolbar.
 * Anchor renders a button; children render inside an absolutely-positioned
 * panel that closes on outside click, Escape, or route change.
 */
export function Menu({
  label,
  icon,
  children,
  align = "start",
  width = 220,
  active = false,
  disabled = false,
  showCaret = true,
  title,
}: {
  label: ReactNode;
  icon?: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
  width?: number;
  active?: boolean;
  disabled?: boolean;
  showCaret?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const location = useLocation();

  useEffect(() => setOpen(false), [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        disabled={disabled}
        title={title}
        onClick={() => !disabled && setOpen((v) => !v)}
        className={cn("mk-menu-trigger", active && "is-active", open && "is-open")}
      >
        {icon && <span className="mk-menu-ico">{icon}</span>}
        <span>{label}</span>
        {showCaret && <ChevronDown size={11} style={{ opacity: 0.7 }} />}
      </button>
      {open && (
        <div
          className="mk-menu-panel hud-panel"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            [align === "end" ? "right" : "left"]: 0,
            width,
            zIndex: 40,
          } as CSSProperties}
          onClick={(e) => e.stopPropagation()}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  selected,
  checkbox,
  disabled,
  hint,
}: {
  children: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  checkbox?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <button
      type="button"
      className="mk-menu-item"
      disabled={disabled}
      onClick={onClick}
      data-selected={selected ? "true" : undefined}
    >
      <span className="mk-menu-item-check">
        {checkbox
          ? <span className={cn("mk-menu-box", selected && "is-on")}>{selected && <Check size={10} />}</span>
          : selected ? <Check size={11} /> : null}
      </span>
      <span style={{ flex: 1, textAlign: "left" }}>{children}</span>
      {hint && <span className="mk-menu-hint">{hint}</span>}
    </button>
  );
}

export function MenuGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mk-menu-group">
      <div className="mk-menu-group-title">{title}</div>
      {children}
    </div>
  );
}

export function MenuDivider() {
  return <div className="mk-menu-divider" />;
}
