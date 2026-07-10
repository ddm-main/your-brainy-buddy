import { cn } from "@/lib/cn";
import { useEffect, useRef, useState, type ReactNode, type HTMLAttributes } from "react";

interface HudPanelProps extends HTMLAttributes<HTMLElement> {
  title?: string;
  index?: string;
  actions?: ReactNode;
  live?: "ok" | "warn" | "err" | "idle";
  /**
   * When this value changes (after first render), the live-dot briefly pulses
   * to signal a data refresh. Any stable identity works (string/number).
   */
  updatedKey?: string | number;
  children: ReactNode;
  bodyClass?: string;
}

export function HudPanel({
  title,
  index,
  actions,
  live,
  updatedKey,
  children,
  className,
  bodyClass,
  ...rest
}: HudPanelProps) {
  const [pinging, setPinging] = useState(false);
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) { firstRef.current = false; return; }
    if (updatedKey === undefined) return;
    setPinging(true);
    const t = window.setTimeout(() => setPinging(false), 500);
    return () => window.clearTimeout(t);
  }, [updatedKey]);

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
            {live && (
              <span
                className={cn("live-dot", live, pinging && "hud-ping")}
              />
            )}
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
