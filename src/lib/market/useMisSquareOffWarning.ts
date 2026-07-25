// P0 safety: warn on any open MIS position as the intraday square-off
// window approaches. Broker auto-squares MIS legs around 15:15 IST; the
// app's mirrored `market_positions` / `market_autotrade_orders` don't
// reflect that until the next reconcile tick, so surface a countdown so
// the user can exit or convert before the broker acts.
import { useEffect, useState } from "react";
import type { Position } from "./types";

const SQUARE_OFF_HOUR = 15; // 15:15 IST
const SQUARE_OFF_MIN = 15;
const WARN_WINDOW_MIN = 15; // start warning at 15:00 IST

function istNow(): { day: string; secs: number; hh: number; mm: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hh = Number(g("hour")); const mm = Number(g("minute")); const ss = Number(g("second"));
  return { day: g("weekday"), secs: hh * 3600 + mm * 60 + ss, hh, mm };
}

function isWeekday(day: string): boolean {
  return day !== "Sat" && day !== "Sun";
}

/**
 * Returns MIS square-off warning state for a set of positions.
 * - `active`: true when we're within WARN_WINDOW_MIN of the cutoff on a weekday.
 * - `misOpen`: how many still-open MIS positions the caller has.
 * - `minutesToCutoff`: minutes until 15:15 IST (0 once past).
 */
export function useMisSquareOffWarning(positions: Position[]) {
  const misOpen = positions.filter((p) => {
    if (p.closed_at) return false;
    // `product` isn't on the Position type in every schema — treat any
    // explicit MIS marker as MIS. Cash-equity manual positions default to
    // journal-only and don't need a warning.
    const prod = (p as unknown as { product?: string }).product;
    return prod === "MIS";
  }).length;

  const compute = () => {
    const { day, secs } = istNow();
    if (!isWeekday(day)) return { active: false, misOpen, minutesToCutoff: 0 };
    const cutoffSecs = SQUARE_OFF_HOUR * 3600 + SQUARE_OFF_MIN * 60;
    const warnStart = cutoffSecs - WARN_WINDOW_MIN * 60;
    if (secs < warnStart || secs > cutoffSecs + 5 * 60) {
      return { active: false, misOpen, minutesToCutoff: Math.max(0, Math.ceil((cutoffSecs - secs) / 60)) };
    }
    return {
      active: misOpen > 0,
      misOpen,
      minutesToCutoff: Math.max(0, Math.ceil((cutoffSecs - secs) / 60)),
    };
  };

  const [state, setState] = useState(compute);
  useEffect(() => {
    setState(compute());
    const id = setInterval(() => setState(compute()), 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [misOpen]);
  return state;
}