// Reusable centered modal. Portals to <body> above the fullscreen chart shell
// (z-index 9999), closes on Esc or backdrop click, and locks body scroll while open.
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export function HudModal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 420,
  /** Fill the viewport height instead of hugging the content. */
  fullHeight = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  fullHeight?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey, true); document.body.style.overflow = prev; };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 10001,
        background: "rgba(2,8,14,0.66)", backdropFilter: "blur(2px)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div
        className="hud-panel mounted"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width, maxWidth: "100%", maxHeight: "92vh",
          ...(fullHeight ? { height: "92vh" } : null),
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}
      >

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid var(--edge)", flex: "0 0 auto" }}>
          <span className="hud-label" style={{ color: "var(--accent)", letterSpacing: "0.18em" }}>{title}</span>
          <button type="button" onClick={onClose} aria-label="Close" className="mk-menu-trigger" style={{ padding: 4 }}>
            <X size={14} />
          </button>
        </div>
        <div style={{ padding: 14, overflowY: "auto", flex: 1, minHeight: 0 }}>{children}</div>
        {footer && (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", padding: "12px 14px", borderTop: "1px solid var(--edge)", flex: "0 0 auto" }}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
