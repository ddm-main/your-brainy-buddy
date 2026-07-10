import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

/** value/onChange use ISO YYYY-MM-DD to match the previous <input type="date"> API. */
export function HudDatePicker({
  value,
  onChange,
  disabled,
  style,
  ariaLabel,
  placeholder = "dd-mm-yyyy",
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  style?: CSSProperties;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const parsed = useMemo(() => parseIso(value), [value]);
  const today = useMemo(() => new Date(), []);
  const [viewYear, setViewYear] = useState(() => (parsed ?? today).getFullYear());
  const [viewMonth, setViewMonth] = useState(() => (parsed ?? today).getMonth());

  useEffect(() => {
    if (parsed) { setViewYear(parsed.getFullYear()); setViewMonth(parsed.getMonth()); }
  }, [parsed]);

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
    const onDown = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btnRef.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = parsed ? formatDdMmYyyy(parsed) : "";

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
    opacity: disabled ? 0.5 : 1,
    ...style,
  };

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const startDow = firstOfMonth.getDay(); // 0=Sun
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const prevDays = new Date(viewYear, viewMonth, 0).getDate();

  const cells: { d: number; inMonth: boolean; date: Date }[] = [];
  for (let i = 0; i < startDow; i++) {
    const d = prevDays - startDow + 1 + i;
    cells.push({ d, inMonth: false, date: new Date(viewYear, viewMonth - 1, d) });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ d, inMonth: true, date: new Date(viewYear, viewMonth, d) });
  }
  while (cells.length % 7 !== 0 || cells.length < 42) {
    const d = cells.length - (startDow + daysInMonth) + 1;
    cells.push({ d, inMonth: false, date: new Date(viewYear, viewMonth + 1, d) });
    if (cells.length >= 42) break;
  }

  const isSameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const monthName = firstOfMonth.toLocaleString(undefined, { month: "long" });

  const go = (delta: number) => {
    let m = viewMonth + delta;
    let y = viewYear;
    while (m < 0) { m += 12; y -= 1; }
    while (m > 11) { m -= 12; y += 1; }
    setViewMonth(m); setViewYear(y);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((o) => !o)}
        className="focus-outline"
        style={triggerStyle}
      >
        <span style={{ color: label ? "var(--text)" : "var(--text-muted)", letterSpacing: "0.06em" }}>{label || placeholder}</span>
        <span aria-hidden style={{ position: "absolute", right: 2, top: "50%", transform: "translateY(-50%)", color: "var(--accent)", fontSize: 11 }}>▦</span>
      </button>
      {open && rect && createPortal(
        <div
          ref={popRef}
          role="dialog"
          className="hud-panel"
          style={{
            position: "fixed",
            top: rect.bottom + 4,
            left: rect.left,
            width: 260,
            zIndex: 9999,
            padding: 12,
            background: "var(--panel-tint-heavy)",
            fontFamily: "var(--font-hud)",
          }}
        >
          <span className="hud-corner tl" />
          <span className="hud-corner tr" />
          <span className="hud-corner bl" />
          <span className="hud-corner br" />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ color: "var(--accent)", fontSize: 12, letterSpacing: "0.16em", textTransform: "uppercase" }}>{monthName}, {viewYear}</div>
            <div style={{ display: "flex", gap: 4 }}>
              <button type="button" onClick={() => go(-1)} className="focus-outline" style={arrowBtn}>‹</button>
              <button type="button" onClick={() => go(1)} className="focus-outline" style={arrowBtn}>›</button>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
            {["Su","Mo","Tu","We","Th","Fr","Sa"].map((d) => (
              <div key={d} style={{ textAlign: "center", fontSize: 9, color: "var(--text-dim)", letterSpacing: "0.16em", padding: "4px 0" }}>{d}</div>
            ))}
            {cells.map((c, i) => {
              const isToday = isSameDay(c.date, today);
              const isSel = parsed && isSameDay(c.date, parsed);
              return (
                <button
                  type="button"
                  key={i}
                  onClick={() => { onChange(toIso(c.date)); setOpen(false); btnRef.current?.focus(); }}
                  style={{
                    padding: "6px 0",
                    fontSize: 12,
                    fontFamily: "var(--font-hud)",
                    color: isSel ? "var(--bg-void)" : c.inMonth ? "var(--text)" : "var(--text-muted)",
                    background: isSel ? "var(--accent)" : "transparent",
                    border: isToday && !isSel ? "1px solid var(--accent)" : "1px solid transparent",
                    borderRadius: 2,
                    cursor: "pointer",
                    transition: "background 120ms, color 120ms",
                  }}
                  onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = "var(--accent-tint-strong)"; }}
                  onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = "transparent"; }}
                >
                  {c.d}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--edge)" }}>
            <button type="button" onClick={() => { onChange(""); setOpen(false); btnRef.current?.focus(); }} style={footBtn}>Clear</button>
            <button type="button" onClick={() => { onChange(toIso(new Date())); setOpen(false); btnRef.current?.focus(); }} style={footBtn}>Today</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

const arrowBtn: CSSProperties = {
  width: 24, height: 24,
  border: "1px solid var(--edge)",
  background: "transparent",
  color: "var(--accent)",
  fontSize: 14, lineHeight: 1,
  cursor: "pointer",
  borderRadius: 2,
};
const footBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--accent)",
  fontFamily: "var(--font-hud)",
  fontSize: 11,
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  cursor: "pointer",
  padding: "4px 6px",
};

function parseIso(v: string): Date | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}
function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function formatDdMmYyyy(d: Date): string {
  const day = String(d.getDate()).padStart(2, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${day}-${m}-${d.getFullYear()}`;
}

export default HudDatePicker;