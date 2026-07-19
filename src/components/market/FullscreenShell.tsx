// Wraps chart content so it can expand to a full-screen overlay. Esc exits.
// In normal mode it renders children inline; in fullscreen it portals to a
// fixed full-viewport flex column with a header + Exit control.
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Minimize2 } from "lucide-react";

export function FullscreenShell({
  fullscreen,
  onExit,
  title,
  children,
}: {
  fullscreen: boolean;
  onExit: () => void;
  title?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onExit(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [fullscreen, onExit]);

  if (!fullscreen) return <>{children}</>;

  return createPortal(
    <div style={{
      position: "fixed", inset: 0, zIndex: 300, background: "var(--bg)",
      display: "flex", flexDirection: "column", padding: 12, gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flex: "0 0 auto" }}>
        <span className="hud-label" style={{ color: "var(--accent)", letterSpacing: "0.2em" }}>{title ?? "Chart"}</span>
        <button onClick={onExit} className="hud-btn focus-outline" data-variant="ghost" data-size="sm"
          title="Exit fullscreen (Esc)" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Minimize2 size={13} /> Exit · Esc
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
