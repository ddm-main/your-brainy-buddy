## Layout audit — findings from live screenshots

Signed in and captured every top-level route. Three distinct problems are causing the "inconsistent layout" the user is seeing.

### 1. `HudPanel` bodies collapse to 0 px everywhere except Home
`src/components/hud/HudPanel.tsx` sets the outer `<section>` to `flex: 0 0 auto` and the body to `flex: 1 1 0; overflow: hidden` (when `flow=false`, the default).

- On Home this works because `.home-grid` uses fixed grid rows and `.home-cell > *` forces `flex: 1`, so the section grows and the body fills.
- Everywhere else (Finance `CommandCenter`, `Cards`, `Accounts`, `Statements`, `Config`, `Tasks`, `Projects`) the panel is dropped into a plain content-flow column. The section stays at content-height, the flex-1 body has no space to consume, and everything under the header is clipped.

Screenshots confirm: Finance/Command shows nothing but panel headers with their bottom borders directly beneath (see `fin-command.png`); Config/Home shows three empty rectangles.

### 2. `Config` still uses a left sidebar
`src/routes/Config.tsx` renders a 180 px vertical nav — inconsistent with Finance/Market which the user standardised on a horizontal sub-nav. The user has already flagged this pattern once.

### 3. Tasks header wraps and clips
`Tasks.tsx` header form packs input + priority + date + "Focus" checkbox + Add button into a single row; on the standard viewport the "Focus" label collides with the "+ Add" button. Same panel-collapse issue also compresses the queue below.

### Additional consistency gaps
- `Projects` route has no sub-nav (Areas / Projects / Archive), inconsistent with the Finance/Market pattern.
- Some routes wrap the whole page in an outer `HudPanel` (Accounts, Cards) while others render bare grids — visually inconsistent framing.
- `.home-grid` has `overflow: auto` but children use `height: 100%` which subtly clips the Pulse panel on shorter viewports.

## Plan

### Step 1 — Fix the root cause in `HudPanel`
Flip the default so panels grow with content, and make the fixed-height-cell case opt-in:
- Rename the prop semantics: default `flow=true` (grow with content, body `overflow: visible`).
- Add `fill?: boolean` prop for the Home-style fixed-cell use, which restores the old behaviour (`flex: 1 1 0; overflow: hidden` on the body, `flex: 1 1 auto` on the section).
- Keep the old `flow` prop as an alias for backwards compatibility (no-op since it's the new default).

### Step 2 — Opt Home cells into `fill`
`src/routes/Home.tsx` — pass `fill` to the four grid-cell `HudPanel`s (Mission Control, Daily Brief, Signal, Pulse). Keep the `.home-cell > *` flex CSS.

### Step 3 — Convert `Config` to a top sub-nav
Rewrite `src/routes/Config.tsx` to use the same horizontal `role="tablist"` pattern as `Finance.tsx` (Home / Email / Finance / Projects). Drop the 180 px sidebar column, keep the same routes.

### Step 4 — Tasks header layout
`src/routes/Tasks.tsx`: split the add-task row into two lines on narrow widths (grid: `1fr auto auto` with priority/date/focus/add on a second row when width < ~900 px). Make "Focus" a clearly labelled toggle chip beside the Add button so it stops clipping.

### Step 5 — Projects sub-nav parity
Add a `SubTabStrip` at the top of `Projects.tsx` (Active / Areas / Archive) that mirrors the Finance sub-nav pattern, even if two of the tabs are stubs — this preserves visual consistency with Finance/Market/Config.

### Step 6 — Consistent page frame
Standardise every top-level route to the same wrapper: `padding: 12; height: 100%; display: flex; flex-direction: column; gap: 12; min-height: 0`. Apply to `Tasks.tsx`, `Projects.tsx`, `Inbox.tsx`, `Config.tsx` so they match Finance/Market.

### Step 7 — Verify
Run the Playwright screenshot script again and confirm:
- Every Finance sub-tab renders panels with visible bodies.
- Config renders as a top sub-nav with populated cards.
- Tasks add-row doesn't clip.
- Home still renders correctly (fixed-cell path preserved via `fill`).
- No new console errors.

### Files touched
- `src/components/hud/HudPanel.tsx` (default flip + `fill` prop)
- `src/routes/Home.tsx` (add `fill` to 4 panels)
- `src/routes/Config.tsx` (sidebar → top sub-nav)
- `src/routes/Tasks.tsx` (header row wrap + page frame)
- `src/routes/Projects.tsx` (sub-nav + page frame)
- `src/routes/Inbox.tsx` (page frame)

### Out of scope
Not touching Finance/Market business logic, edge functions, DB, or the Statements table columns — the user asked for layout consistency only. Home's JarvisCore, VoiceBar, and animations stay untouched.