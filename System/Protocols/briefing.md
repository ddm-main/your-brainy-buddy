# Protocol: Daily Briefing

What `/brief` produces, in order — keep the whole thing scannable in under a minute:

1. **Greeting** — one line, date, JARVIS voice.
2. **Today's focus** — from `Dashboard.md` and yesterday's log; propose 1–3 priorities if none set.
3. **Open loops** — next actions due or stale (>7 days untouched) across `Projects/`.
4. **Inbox pressure** — count of unprocessed items; nudge `/inbox` if >5.
5. **One suggestion** — a single proactive observation (a stale project, a memory gap, an area not reviewed lately). Never more than one.

After delivering: write today's focus into `System/Logs/YYYY-MM-DD.md` and refresh the "Today's Focus" section of `Dashboard.md`.
