import { createDefaultWideWidgets, type WideWidgetConfig, type WideWidgetId } from "@enveo/shared";

/**
 * Pure helpers behind the wide Home board's edit mode (`screens/WideHome.tsx`) — kept separate
 * from that component so the "pure bits" (pr5-task-6-brief.md Step 1: span clamp, draft-commit,
 * add/remove) are unit-testable without mounting anything or simulating pointer events. Pointer
 * gestures themselves (resize/reorder) are exercised in the Step 5 browser pass instead.
 */

/** Render-time column clamp for a stored (desktop-truth) span — NEVER mutates storage: a tile
 *  authored at `w:3` on desktop still stores 3 while rendering at `min(cols, 3)` on the fold's
 *  2-column grid, so switching back to desktop later restores the wider span ("Clamp at render,
 *  persist desktop-truth" — pr5-task-6-brief.md). Also the cap applied to a live resize gesture
 *  (mock :3628-3641): dragging a tile on the fold can only ever WRITE up to `cols`, exactly like
 *  the approved mock's own `Math.min(homeColsN, …)`. */
export function clampSpan(w: number, cols: number): number {
  return Math.max(1, Math.min(cols, w));
}

/** Row span clamp — rows are never mode-dependent (only columns are), so this is a fixed 1..8
 *  bound regardless of fold vs. desktop. */
export function clampRow(h: number): number {
  return Math.max(1, Math.min(8, h));
}

/** One committed resize — the ONLY entry the gesture rewrites; every other tile's config is an
 *  identity no-op, so a resize can never perturb an unrelated tile's order, span or options. `h`
 *  is defensively re-clamped here (cheap, and the schema would reject an out-of-range value
 *  anyway); `w` is NOT — the caller already clamped it against the CURRENT mode's column count
 *  via `clampSpan`, which this module has no opinion on (it doesn't know the viewport). */
export function applyResize(widgets: WideWidgetConfig[], id: WideWidgetId, w: number, h: number): WideWidgetConfig[] {
  return widgets.map((widget) => (widget.id === id ? { ...widget, w, h: clampRow(h) } : widget));
}

/** Enable/disable toggle — spans (`w`/`h`) and `opts` survive a disable (mock semantics: hiding a
 *  widget never forgets how it was sized or configured, ready to reappear the same way when
 *  re-added from the "Add widget" ghost tile). */
export function toggleEnabled(widgets: WideWidgetConfig[], id: WideWidgetId, enabled: boolean): WideWidgetConfig[] {
  return widgets.map((widget) => (widget.id === id ? { ...widget, enabled } : widget));
}

/**
 * Edit mode's "Reset layout" escape hatch. A stored `wideWidgets` board outlives every change to
 * the shipped defaults — `reconcileWideWidgets` deliberately keeps whatever the user has (only
 * APPENDING ids it has never seen), so without this no existing budget could ever adopt a
 * redesigned default row map (waveB-t1-brief.md's "fresh budget (or after layout reset)" premise).
 * Commits the CANONICAL default board as exactly ONE `update({ wideWidgets })` op — the same
 * commit grammar as every other edit-mode gesture; `update` is `useBudgetPreferences().update`.
 */
export function commitResetLayout(update: (patch: { wideWidgets: WideWidgetConfig[] }) => void): void {
  update({ wideWidgets: createDefaultWideWidgets() });
}

/**
 * Reorders the ENABLED subset — `from`/`to` are indices within it, matching exactly what the grid
 * renders (`rows.filter((w) => w.enabled)`) — and appends the disabled ones after, in their
 * existing relative order. Disabled entries never render, so their position among each other is
 * cosmetic only (the "Add widget" ghost tile lists them by catalogue title, never by array
 * position). Out-of-range indices or a no-op move return the input unchanged.
 */
export function reorderEnabled(widgets: WideWidgetConfig[], from: number, to: number): WideWidgetConfig[] {
  const enabled = widgets.filter((w) => w.enabled);
  const disabled = widgets.filter((w) => !w.enabled);
  if (from < 0 || from >= enabled.length || to < 0 || to >= enabled.length || from === to) return widgets;
  const order = [...enabled];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved!);
  return [...order, ...disabled];
}
