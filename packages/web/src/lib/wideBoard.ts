import { createDefaultWideWidgets, type WideWidgetConfig, type WideWidgetId } from "@enveo/shared";

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

/** Widget ids that CLIP instead of scrolling when `scroll` is absent — the design's own
 *  per-widget default (`startWidgets`, v3.dc.html:2235-2236): `netWorth` and `cashflow` both ship
 *  an explicit `scroll:false` (fixed stat/chart blocks that never legitimately scroll), every
 *  other widget omits the field and the design reads that as `true`. */
const SCROLL_CLIPPED_BY_DEFAULT: ReadonlySet<WideWidgetId> = new Set(["reportNetWorth", "reportCashflow"]);

export function resolveWidgetScroll(widget: Pick<WideWidgetConfig, "id" | "scroll">): boolean {
  return widget.scroll ?? !SCROLL_CLIPPED_BY_DEFAULT.has(widget.id);
}
