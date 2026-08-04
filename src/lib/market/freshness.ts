// One classifier for "how old is this number?", shared by every Market panel
// so Analysis, Screener and Dashboard cannot disagree about whether a value is
// live, settled, catching up, or genuinely stale.
//
// Rule of the house: a date is shown ONLY when the data is not current. If the
// row belongs to the newest settled session (or is a live tick), the UI states
// what it is — "live", "last close" — and stays quiet about the date.

export type FreshnessState =
  | "live"      // ticking right now, market open
  | "settled"   // newest completed session — current, no date needed
  | "updating"  // today's close exists but this row hasn't been rescored yet
  | "stale";    // genuinely behind by one or more settled sessions

export interface Freshness {
  state: FreshnessState;
  /** Short chip text. Null when nothing needs saying. */
  label: string | null;
  tone: "ok" | "neutral" | "warn";
  /** Full explanation for a title attribute. */
  title: string;
  /** Sessions behind the newest settled one, when known. */
  sessionsBehind: number | null;
}

export const shortDate = (d: string | number | Date | null | undefined): string => {
  if (!d) return "";
  const dt = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)
    // Date-only strings are exchange dates, not UTC instants. Parsing them as
    // UTC shifted every EOD date back by 5h30m in IST and printed 05:30 times.
    ? new Date(`${d}T12:00:00`)
    : new Date(d);
  return Number.isNaN(dt.getTime()) ? "" : dt.toLocaleDateString([], { day: "2-digit", month: "short" });
};

export const shortTime = (d: string | number | Date): string =>
  new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** True for a plain "YYYY-MM-DD" with no clock component. */
export const isDateOnly = (v: string | null | undefined): boolean =>
  !!v && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());

/** IST wall-clock minutes since midnight. */
function istMinutes(now = new Date()): number {
  const ist = new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60_000);
  return ist.getHours() * 60 + ist.getMinutes();
}

/** Post-close window in which a lagging session is "updating", not "stale". */
export function inPostCloseWindow(now = new Date()): boolean {
  const m = istMinutes(now);
  return m >= 15 * 60 + 30 && m <= 21 * 60;
}

export interface ClassifyInput {
  /** Trade date of the row being shown ("YYYY-MM-DD"). */
  dataDate: string | null | undefined;
  /** Newest session whose bhavcopy covered the whole market. */
  latestComplete: string | null | undefined;
  /** Recent complete sessions, newest first — used to count sessions behind. */
  sessions?: string[];
  /** The value is a live tick and the market is open. */
  live?: boolean;
}

export function classifyFreshness({ dataDate, latestComplete, sessions = [], live }: ClassifyInput): Freshness {
  if (live) {
    return { state: "live", label: "live", tone: "ok", title: "Live tick — market is open.", sessionsBehind: null };
  }
  const d = dataDate ? String(dataDate).slice(0, 10) : null;
  if (!d) {
    return { state: "stale", label: "no data", tone: "warn", title: "No session data for this symbol yet.", sessionsBehind: null };
  }
  if (!latestComplete || d >= latestComplete) {
    return { state: "settled", label: null, tone: "neutral", title: `Latest settled session (${d}).`, sessionsBehind: 0 };
  }
  const idx = sessions.indexOf(d);
  const behind = idx > 0 ? idx : null;
  if ((behind === 1 || behind === null) && inPostCloseWindow()) {
    return {
      state: "updating",
      label: "updating after close",
      tone: "warn",
      title: `Today's close (${latestComplete}) has landed; this symbol's scoring pass hasn't caught up yet.`,
      sessionsBehind: behind,
    };
  }
  return {
    state: "stale",
    label: behind != null
      ? `${shortDate(d)} · ${behind} session${behind === 1 ? "" : "s"} behind`
      : `${shortDate(d)} · behind`,
    tone: "warn",
    title: `Pipeline is behind: latest settled session is ${latestComplete}, this row is from ${d}.`,
    sessionsBehind: behind,
  };
}