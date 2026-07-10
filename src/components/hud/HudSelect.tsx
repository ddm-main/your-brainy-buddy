import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

export type HudSelectOption = { value: string; label: string };

export function HudSelect({
  value,
  onChange,
  options,
  placeholder = "select…",
  disabled,
  style,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  options: HudSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  style?: CSSProperties;
  ariaLabel?: string;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [highlight, setHighlight] = useState<number>(-1);

  const selected = useMemo(() => options.find((o) => o.value === value), [options, value]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = btnRef.current;
    if (!el) return;
    const update = () => setRect(el.getBoundingClientRect());
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setHighlight(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDown = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); btnRef.current?.focus(); }
      if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(options.length - 1, h + 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)); }
      if (e.key === "Enter") {
        e.preventDefault();
        const o = options[highlight];
        if (o) { onChange(o.value); setOpen(false); btnRef.current?.focus(); }
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, options, highlight, value, onChange]);

  const triggerStyle: CSSProperties = {
    padding: "8px 22px 8px 2px",
    border: "none",
    borderBottom: `1px solid ${open ? "var(--accent)" : "var(--edge)"}`,
    background: "transparent",
    color: "var(--text)",
    fontSize: 13,
    fontFamily: "var(--font-hud)",
    outline: "none",
    borderRadius: 0,
    textAlign: "left",
    position: "relative",
    cursor: disabled ? "not-allowed" : "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    minWidth: 0,
    opacity: disabled ? 0.5 : 1,
    ...style,
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowDown" || e.key === " " || e.key === "Enter") { e.preventDefault(); setOpen(true); }
        }}
        className="focus-outline"
        style={triggerStyle}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: selected ? "var(--text)" : "var(--text-muted)" }}>
          {selected ? selected.label : placeholder}
        </span>
        <span aria-hidden style={{ position: "absolute", right: 2, top: "50%", transform: `translateY(-50%) rotate(${open ? 180 : 0}deg)`, color: "var(--accent)", fontSize: 10, transition: "transform 160ms ease" }}>▾</span>
      </button>
      {open && rect && createPortal(
        <div
          ref={popRef}
          role="listbox"
          className="hud-panel"
          style={{
            position: "fixed",
            top: rect.bottom + 4,
            left: rect.left,
            width: Math.max(rect.width, 160),
            zIndex: 9999,
            padding: 4,
            maxHeight: 280,
            overflowY: "auto",
            background: "var(--panel-tint-heavy)",
          }}
        >
          <span className="hud-corner tl" />
          <span className="hud-corner tr" />
          <span className="hud-corner bl" />
          <span className="hud-corner br" />
          {options.length === 0 && (
            <div style={{ padding: "8px 10px", fontFamily: "var(--font-hud)", fontSize: 11, color: "var(--text-muted)", letterSpacing: "0.16em", textTransform: "uppercase" }}>· no options ·</div>
          )}
          {options.map((o, i) => {
            const isSel = o.value === value;
            const isHi = i === highlight;
            return (
              <div
                key={o.value}
                role="option"
                aria-selected={isSel}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => { e.preventDefault(); onChange(o.value); setOpen(false); btnRef.current?.focus(); }}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "7px 10px",
                  fontFamily: "var(--font-hud)",
                  fontSize: 12.5,
                  letterSpacing: "0.04em",
                  color: isSel ? "var(--accent)" : "var(--text)",
                  background: isHi ? "var(--accent-tint-strong)" : "transparent",
                  borderLeft: `2px solid ${isSel ? "var(--accent)" : "transparent"}`,
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <span aria-hidden style={{ width: 8, color: "var(--accent)" }}>{isSel ? "▸" : ""}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.label}</span>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

export default HudSelect;