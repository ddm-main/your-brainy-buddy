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
  /**
   * Content-height mode. The default panel body is `flex:1 1 0` with
   * `overflow:hidden` so it fills a fixed-height grid cell and scrolls
   * internally. In a plain content-flow page (no definite height) that
   * starves the body to zero and clips everything. Set `flow` for those
   * pages so the panel grows to its content instead of collapsing.
   */
  flow?: boolean;
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
  flow = false,
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

  const { style, ...restNoStyle } = rest as { style?: React.CSSProperties } & Record<string, unknown>;

  return (
    <section
      className={cn("hud-panel mounted", className)}
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        ...(flow ? { overflow: "visible" } : null),
        ...(style || {}),
      }}
      {...restNoStyle}
    >
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
            flex: "0 0 auto",
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
      <div
        className={cn("relative", bodyClass)}
        style={{
          flex: flow ? "0 0 auto" : "1 1 0",
          minHeight: 0,
          padding: 12,
          display: "flex",
          flexDirection: "column",
          overflow: flow ? "visible" : "hidden",
        }}
      >
        {children}
      </div>
    </section>
  );
}

export default HudPanel;
