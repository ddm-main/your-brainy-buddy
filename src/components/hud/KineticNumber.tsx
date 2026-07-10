import { useEffect, useRef, useState } from "react";

export default function KineticNumber({ value, digits = 0 }: { value: number; digits?: number }) {
  const [display, setDisplay] = useState(value);
  const [flick, setFlick] = useState(0);
  const first = useRef(true);

  useEffect(() => {
    const start = display;
    const delta = value - start;
    if (delta === 0) return;
    if (!first.current) setFlick((n) => n + 1);
    first.current = false;
    const t0 = performance.now();
    const dur = 500;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(start + delta * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <span key={flick} className="hud-num hud-num-wrap is-changing">
      {display.toFixed(digits)}
    </span>
  );
}
