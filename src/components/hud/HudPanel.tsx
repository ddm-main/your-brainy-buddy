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
   * Legacy prop — accepted for backwards compatibility. The panel body
   * now sizes with `flex:1 1 auto; min-height:0`, so it grows with its
   * content in a content-flow column AND fills a fixed-height cell when
   * an ancestor gives the section explicit height (e.g. `.home-cell > *`
   * → `flex:1`). No caller needs to pass this any more.
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
  flow: _flow,
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
        flex: "0 0 auto",
        // Keep decorative ::before/::after shimmer clipped; content that
        // needs to escape uses the body, which stays visible.
        overflow: "hidden",
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
          // `1 1 auto` makes the body grow with its content in a normal
          // content-flow column AND fill a fixed-height parent section
          // (e.g. Home's `.home-cell > *` flex:1 override) — so we no
          // longer need per-callsite `flow`/fill toggles.
          flex: "1 1 auto",
          minHeight: 0,
          padding: 12,
          display: "flex",
          flexDirection: "column",
          overflow: "visible",
        }}
      >
        {children}
      </div>

    </section>
  );
}

export default HudPanel;
