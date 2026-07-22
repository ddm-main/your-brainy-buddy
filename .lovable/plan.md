## Audit against `.lovable/plan.md` (Screener overhaul)

Verified against current `src/routes/market/Screener.tsx` (1406 lines).

### ✅ Already implemented

1. **Duplicate saved-screener name** — Results title is now `Results · N of M`; the name only appears in the header chip. (line 695)
2. **Persist `activeSavedId`** — `STATE_STORE_KEY = "screener.state.v2"` now stores `{ universe, active, savedId }`; re-attached on mount and `activeSavedSig` recomputed once `saved` resolves. `SavedPicker` receives `activeId`. (lines 82, 180, 328, 418–435, 627)
3. **`sigOf` normalization** — normalizes `""`/`undefined` bounds, numeric coercion, boolean, sorted enum values. (lines 332–344) ✔️
4. **Share button + `shareLink` handler removed**; `?f=` hydration still works. ✔️
5. **Save-as HudModal** — inline `saveName` input replaced by a modal with Enter-to-submit, Esc-to-cancel; single Save button that updates in place when attached. (lines 632–679)
6. **Slim toolbar** — top `HudPanel` wrapper gone; toolbar row is `padding: 6px 8px`. (lines 595–651)
7. **Two-pane grid** — `display: grid; grid-template-columns: 340px 1fr; flex: 1; min-height: 0` with both panes stretching. (line 687)
8. **Data-health strip out of Results header** — moved behind a `Health` button that opens a `HudModal` with the full `DataHealthStrip`. (lines 649, 682–684)
9. **Data-stale banner** kept as a compact one-liner. (lines 653–663)

### 🟡 Partially done — needs finishing

- **Data-health UI (plan item #5)**: modal exists, but the plan asked for a **compact status pill** `● 9/2732 · EOD 22 Jul` next to the Results title with a **`⋯` icon in the top-right of the Results panel** to open the popover. Today it's a generic `Health` button in the top toolbar with no green/amber/red dot derived from the worst coverage %.
- **Save modal**: no duplicate-name warning, no rename-existing flow, no `Ctrl+S` shortcut.
- **Left-rail width**: 340 px (plan target 300–320 to give the table more room).
- **FilterRail scrollbox**: still uses `maxHeight: calc(100vh - 340px); overflowY: auto` hack (line 782) instead of `flex: 1; min-height: 0; overflow: auto`.

### ❌ Remaining bugs (from the plan's "Bugs — fix now" list)

- **Applied-chip row + redundant `EOD` chip** still rendered below the table (lines 723–729) — plan said drop entirely; sidebar already shows the same filters.
- **`Reset` still clears filters AND detaches** in one click (line 641). Split into `Clear values` (keeps attachment) and rely on the chip's `×` to detach.
- **Column picker hidden when `active.length > 0`** (lines 699–700) — plan said keep it visible and only auto-add the filtered column.
- **`didHydrateFromUrlRef` set even when no `?f`** (line 267) — only set when hydration actually happened.
- **URL `?f=` never cleared** when a saved screen is attached — clear it whenever `activeSavedId` is set (id is enough).
- **`EnumMultiSelect` has no search input** (line 983) — >100-option sector/industry list is unusable.
- **Number range editor allows `min > max`** silently — need inline warning + swap-on-blur.
- **`useAnchoredPos` doesn't re-run on trigger resize** — add `ResizeObserver` on the trigger ref.
- **Sidebar range keystrokes recompute `filtered` every keystroke** — debounce sidebar edits by 120 ms.
- **CSV export filename** doesn't include universe or active-filter count.

### ❌ Remaining QoL improvements

- Keyboard: `/` focuses "Add Filter" search, `Esc` closes popovers, `Ctrl+S` opens Save-as, `⌘K`-friendly.
- Sort + pagination position persisted per saved screen.
- Sticky `<thead>` on results table; results panel is the only scroll surface.
- Empty-state (0 rows) CTA: `No matches — [Clear values] [Loosen top filter]`.
- Move resync `⋯` submenu to Config only; Screener keeps read-only status dot + "Go to Config" link.

### New improvements found this audit

- **`Reset` button** is coloured `variant="danger"` (line 641) — misleading for a benign clear. Downgrade to ghost.
- **`SavedPicker` trigger** should show `★ <name>` when attached even before the popover opens (verify current behaviour once implementing the pill rework).
- **A11y**: Save/Health/Reset buttons need `title` + `aria-label`; the coloured dot in the header chip should have `role="status"` with a text label for screen readers.
- **Health modal** currently mounts `DataHealthStrip` verbatim — reflow it as vertical sections (coverage % bars, gaps table, resync actions) so it reads well in a 520 px dialog instead of a horizontal chip strip.
- **`STATE_STORE_KEY` migration**: rows persisted under old `v1` key will be silently discarded on first load; add a one-shot migration read of `screener.state.v1` → `v2` so returning users don't lose their setup.

## Execution order (one pass, `src/routes/market/Screener.tsx` only)

1. **Layout polish**: narrow rail to 320 px; replace FilterRail `maxHeight` hack with flex; drop Applied-chip row.
2. **Header/results rework**: add compact status pill (worst-of-3 coverage dot + `N/M · EOD <date>`) next to Results title; move `Health` behind a `⋯` in the Results panel top-right; drop the toolbar `Health` button.
3. **Save flow**: duplicate-name warning, rename-existing input inside the modal, `Ctrl+S` shortcut.
4. **Reset split**: `Clear values` (keeps attachment) + rely on chip `×` for detach; recolour to ghost.
5. **Column picker**: keep visible always; auto-add the filtered column instead of replacing.
6. **Bug sweep**: `didHydrateFromUrlRef` gating, `?f=` clear when attached, `EnumMultiSelect` search, min>max swap-on-blur + warning, `ResizeObserver` in `useAnchoredPos`, 120 ms debounce on sidebar range keystrokes, CSV filename `screener_<universe>_<Nfilters>_<date>.csv`.
7. **QoL**: keyboard shortcuts, sticky thead, 0-row empty state CTA, per-saved-screen sort/page persistence, `v1→v2` state migration, a11y labels.
8. **Config handoff**: strip resync submenu from `DataHealthStrip` used in Screener; leave read-only status + "Go to Config" link.

### Out of scope (unchanged)

- No changes to `screenerCatalog.ts`, `screenerRun.ts`, `hooks.ts`, DB, or saved-screener persistence contracts.
- No mobile redesign.

Confirm and I'll implement in the order above.