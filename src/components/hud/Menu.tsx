import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { createPortal } from "react-dom";
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
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const location = useLocation();

  useEffect(() => setOpen(false), [location.pathname]);

  // Position the portalled panel just under the trigger. Recomputed on open
  // and on scroll/resize so it tracks the toolbar even when it scrolls.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      if (!b) return;
      const left = align === "end" ? b.right - width : b.left;
      setPos({
        top: b.bottom + 4,
        left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, align, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
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
        ref={btnRef}
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
      {open && pos && createPortal(
        <div
          ref={panelRef}
          className="mk-menu-panel hud-panel"
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            width,
            zIndex: 10000,
          } as CSSProperties}
          onClick={(e) => e.stopPropagation()}
        >
          {typeof children === "function" ? children(close) : children}
        </div>,
        document.body,
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
