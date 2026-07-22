
## Scope
Edit only the Screener UI shell and its sub-components in `src/routes/market/Screener.tsx`. No changes to filter catalog, data pipeline, or saved-screener persistence contracts.

## User-reported issues → fixes

1. **Duplicate saved-screener name**
 Cause: the loaded screen name is rendered twice — once as the header chip (`activeSaved.name • modified`) and again appended to the Results panel title (`Results · N · Screen 2 (modified)`).
 Fix: keep it in **one** place — the header chip only. Strip the name from the Results title (`Results · 9 of 2732`).

2. **Selected filter name still not visible ("Screen 2")**
 Cause: `activeSavedId` lives in local state only. On reload we restore filters from `screener.state.v1`, but the `DEFAULT_SAVED_KEY` auto-load is skipped whenever persisted filters exist (line 417) so the "★ Screen 2" chip disappears even though the same filters are loaded.
 Fix:
 - Persist `activeSavedId` inside `STATE_STORE_KEY` (`{ universe, active, savedId }`).
 - On mount, re-attach `activeSavedId` from persisted state and recompute `activeSavedSig` once `saved` resolves; only mark "modified" when signatures actually differ.
 - Make the `SavedPicker` trigger always display the current name (`★ Screen 2`) whenever attached, even before the popover opens.

3. **Header input + Save → single Save button with name prompt**
 Remove the `saveName` inline `<input>`. Replace with:
 - `Save` (updates in place when a saved screen is loaded; opens a **HudModal** "Save screen as…" when nothing is attached, or when user Alt-clicks / uses a new "Save as…" menu item).
 - Modal validates: non-empty, unique-ish name (warn on duplicate), Enter-to-submit, Esc-to-cancel.
 - Rename existing saved screen from the same modal (edit `activeSaved.name`).

4. **Remove Share button**
 Delete the Share button and the `shareLink` handler. Keep the `?f=` URL hydration (still useful for external links); just no UI trigger.

5. **Data-health chip strip (FUND / SECTOR / TECH / MCAP / lag ok / gaps / fail) looks bad**
 Move that entire strip out of the Results header. Replace with:
 - A single compact status pill next to the Results title: `● 9 / 2732 · EOD 22 Jul` (green/amber/red dot from the worst of the three coverage %s).
 - Full detail (all the chips + gaps modal + resync menu) lives behind a small `Data health` popover triggered from a `⋯` icon in the top-right of the Results panel — hidden by default, always available.

6. **Full-screen usage — no wasted vertical space**
 - Delete the empty top HudPanel wrapper (`<></>` body). Move the title + actions into a slim inline toolbar (`padding: 4px 0`, no panel chrome).
 - Change the two-pane grid to a real full-height layout:
 `display: grid; grid-template-columns: 320px 1fr; gap: 12px; flex: 1; min-height: 0; align-items: stretch;` (parent already has `flex-direction: column`).
 - Both `FilterRail` and Results panel: `height: 100%; display: flex; flex-direction: column; min-height: 0;` with the inner scroll region taking `flex: 1`.
 - Remove `maxHeight: calc(100vh - 340px)` hack from FilterRail scrollbox; use `flex: 1; min-height: 0; overflow: auto;` instead.
 - Narrow left rail from 370 → 300–320 px so the results table gets more room.
 - Results table container itself gets `flex: 1; overflow: auto;` so the empty area below the last row disappears.

## Additional bugs & improvements found in the audit (list only, will implement in this same pass unless flagged)

Bugs (fix now):
- **Modified-flag false positives**: `sigOf` doesn't normalize `""` vs `undefined` bounds or numeric coercion — a re-typed identical value marks the screen "modified". Normalize before hashing.
- **URL `?f=` never clears** on page unload when filters are cleared while a saved screen is attached (the effect deletes it only when both `active` is empty and `universe==="all"`). Add `savedId` to the URL contract or clear `?f=` whenever a saved screen is attached (its id is enough).
- **Applied chip row duplicates the sidebar filters** below the table with a redundant `EOD` chip. Drop the row entirely (sidebar already shows every active filter with values).
- **`didHydrateFromUrlRef` is set to true even when there was no `?f`** — harmless today, but means any future writer effect gated on it may fire before we intended. Only set it when we actually hydrated.
- **Column picker disappears the moment a filter is added** (Tickertape parity), so users lose their custom column set on every filter. Fix: keep the picker visible; only auto-add the filtered column, don't replace the whole set.
- **`Reset` currently clears filters *and* detaches saved screen in one click** — no way to just clear values. Split into `Clear values` (keeps saved attachment) and `Detach` (already exists on the chip).
- **`EnumMultiSelect` sector/industry picker has no search** inside a >100-option list. Add a filter input.
- **Number range editor allows `min > max`** and silently returns 0 rows. Show inline warning + swap-on-blur.
- **`useAnchoredPos` doesn't re-run when trigger size changes** (e.g., saved-name grows on load). Add a `ResizeObserver` on the trigger.
- **`ScreenerInner` re-runs the whole `filtered` chain on every keystroke** in a range input because `active` is a new array. Debounce sidebar edits by 120 ms.
- **CSV export uses `filtered` (all rows)** — file name doesn't include universe or active-filter count; add for traceability.

Improvements (quality-of-life, will implement):
- Slim single-line toolbar: `Screener` title · attached chip · Save · Clear · `⋯`.
- Keyboard: `/` focuses the "Add Filter" search, `Esc` closes popovers, `Ctrl+S` opens save-as modal, `⌘K` friendly.
- Sort + pagination position persisted per saved screen.
- Results panel becomes the only scroll surface on the right — sticky `thead`, no page scroll.
- Empty state above table when 0 rows: "No matches — [Clear values] [Loosen top filter]".
- Move the resync `⋯` menu to Config (as it already exists there) — Screener keeps only a read-only status dot and a "Go to Config" link.

## Out of scope
- No changes to `screenerCatalog.ts`, `screenerRun.ts`, or DB.
- No new saved-screener fields (rename/duplicate reuse existing `save.mutate` with `{id,name,filters}`).
- No mobile-specific redesign (desktop-first fix; still degrades acceptably at narrow widths).

## Files touched
- `src/routes/market/Screener.tsx` — layout rewrite of `ScreenerInner`, header toolbar, `FilterRail` shell, Results panel shell, `DataHealthStrip` → collapsed pill + popover, remove Share, add Save-as modal, persist `activeSavedId`, sig-normalization, enum search, min>max guard.

Confirm and I'll implement.
