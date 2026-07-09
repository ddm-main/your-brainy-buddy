import { cn } from "@/lib/cn";
import type { ReactNode, HTMLAttributes } from "react";

interface HudPanelProps extends HTMLAttributes<HTMLElement> {
  title?: string;
  index?: string;
  actions?: ReactNode;
  live?: "ok" | "warn" | "err" | "idle";
  children: ReactNode;
  bodyClass?: string;
}

export function HudPanel({
  title,
  index,
  actions,
  live,
  children,
  className,
  bodyClass,
  ...rest
}: HudPanelProps) {
  return (
    <section className={cn("hud-panel flex flex-col", className)} {...rest}>
      <span className="hud-corner tl" />
      <span className="hud-corner tr" />
      <span className="hud-corner bl" />
      <span className="hud-corner br" />
      {title && (
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            borderBottom: "1px solid var(--edge)",
            gap: 10,
          }}
        >
          <div className="h-title">
            {live && <span className={`live-dot ${live}`} />}
            {index && <span className="h-idx">{index}</span>}
            <span>{title}</span>
          </div>
          {actions && <div style={{ display: "flex", gap: 6 }}>{actions}</div>}
        </header>
      )}
      <div className={cn("relative flex-1 min-h-0", bodyClass)} style={{ padding: 12 }}>
        {children}
      </div>
    </section>
  );
}

export default HudPanel;
