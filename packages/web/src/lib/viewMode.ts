/**
 * Viewport-derived layout modes — the single source of every layout decision that depends
 * on how much room the app has (spec 2026-08-21-wide-layouts-and-reports-redesign).
 *
 * Three modes, because the design bundle draws two distinct wide layouts, not one: an
 * unfolded foldable at 1104x992 (icon rail, detail pane WIDER than the primary pane) and a
 * desktop at 1440x860 (labelled rail, narrower detail pane).
 *
 * The HEIGHT clause is not decoration. A phone in landscape is 844x390 and clears the 900px
 * width test on a wider handset; giving it a rail plus two panes inside 390px of height would
 * be unusable. Width alone cannot tell a landscape phone from an unfolded foldable — the
 * foldable has ~992px of height and the phone has ~390px, so height can.
 *
 * `viewModeFor` is pure and total: it is the thing under test, and non-finite or negative
 * input degrades to the SAFE direction ("phone", the layout that fits everywhere) rather
 * than throwing during a resize.
 */
import { useEffect, useState } from "react";

export type ViewMode = "phone" | "fold" | "desktop";

/** The phone content column. Was five separate `maxWidth: 420` literals before this constant. */
export const PHONE_COL = 420;

/** Width at which the fold layout (icon rail + primary + wide detail pane) becomes possible. */
export const FOLD_MIN = 900;

/** Width at which the desktop layout (labelled rail + primary + detail pane) takes over. */
export const DESKTOP_MIN = 1280;

/** Below this viewport height no wide layout is offered, however wide the viewport is. */
export const MIN_WIDE_HEIGHT = 500;

/** Navigation rail width per wide mode (the design bundle's measurements). */
export const RAIL_W = { fold: 68, desktop: 236 } as const;

/** Right detail-pane width per wide mode. On the fold it is deliberately WIDER than the
 *  primary pane (484px) — on that device the detail is the thing being worked on. */
export const PANE_W = { fold: 552, desktop: 400 } as const;

/**
 * Pure mode rule. `phone` when the viewport is too narrow OR too short; then `fold`; then
 * `desktop`. Non-finite input resolves to `phone`.
 */
export function viewModeFor(width: number, height: number): ViewMode {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return "phone";
  if (height < MIN_WIDE_HEIGHT) return "phone";
  if (width < FOLD_MIN) return "phone";
  if (width < DESKTOP_MIN) return "fold";
  return "desktop";
}

/**
 * Subscribed viewport mode. ONE listener for the whole app, mirroring the dark-mode listener
 * pattern in `lib/contexts.tsx` — never call this per-component in a loop.
 *
 * `resize` rather than a pair of `matchMedia` queries: the rule depends on width AND height,
 * so a single event carrying both is simpler and cannot go half-applied. The state setter is
 * given the mode (not the raw pixels), so a resize that does not cross a threshold re-renders
 * nothing — React bails out on an identical value.
 */
export function useViewMode(): ViewMode {
  const [mode, setMode] = useState<ViewMode>(() => (typeof window === "undefined" ? "phone" : viewModeFor(window.innerWidth, window.innerHeight)));
  useEffect(() => {
    const read = () => setMode(viewModeFor(window.innerWidth, window.innerHeight));
    read(); // a resize between first render and effect must not be missed
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);
  return mode;
}
