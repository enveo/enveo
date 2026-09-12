// lib/shellContext.ts — the ONLY shared module between eager screens and the lazy shell.
// Keep it dependency-free: anything imported here lands in the phone bundle.
import { createContext, useContext } from "react";
import type { ViewMode } from "./viewMode";

/** One pane's horizontal geometry, viewport-relative (`getBoundingClientRect()`'s `left`/
 *  `width`) — measured by `WideShell`'s `ResizeObserver` and consumed by `DockedNumpad`'s wide
 *  anchor (Task 3): the docked pad anchors to whichever pane's rect is relevant, not to the
 *  viewport, so it never spans the rail or an open panel. */
export type PaneRect = { left: number; width: number };

/** Pane-surface host (PR6b): lets an opted-in `Sheet` render as a panel overlay instead of a
 *  phone-style bottom sheet. Provided only by `WideShell`, absent on phone and in any tree
 *  outside the wide shell (both `InWideShell.Provider` values below set this — a surface can be
 *  opened from a component hosted in EITHER pane). */
export type PaneSurfaceHost = {
  /** Portal target inside the panel column (null for the first frame, until WideShell's ref fires). */
  node: HTMLElement | null;
  /** Register an OPEN surface. Registering reopens a collapsed panel; the return value unregisters. */
  register: (s: { close: () => void }) => () => void;
};

/**
 * PR4 shipped this context as a plain `boolean` ("am I inside the wide shell"), read by five
 * call sites. PR6 Task 2 upgrades its VALUE to a small object — which pane the CURRENT subtree
 * renders in, the shell's mode, and both panes' measured rects — because `DockedNumpad`'s wide
 * anchor (Task 3) needs more than a boolean. Every existing boolean read becomes `useWideHost()
 * !== null` (mechanical; see the five call sites in Start/Budget/Transactions/Accounts/
 * reportKit's `ReportShell`). `null` on phone, same as `false` was.
 */
export type WideHostInfo = {
  /** Which pane the CURRENT subtree renders in — primary (screens) or panel (PR4's right pane). */
  host: "primary" | "panel";
  mode: Exclude<ViewMode, "phone">;
  /** Measured via ResizeObserver in WideShell; panel is null whenever PR4's panelClosed is true. */
  rects: { primary: PaneRect; panel: PaneRect | null };
  /** PR6b — optional so every existing `PaneRect`-only consumer never changes. Present on both
   *  the primary and panel providers (a pane-hosted owner like a future account pane can open a
   *  surface too), absent only until `WideShell` itself provides it. */
  surfaces?: PaneSurfaceHost;
};

export const InWideShell = createContext<WideHostInfo | null>(null);

/** `null` on phone. Every consumer that only needs the old boolean question checks
 *  `useWideHost() !== null`. */
export function useWideHost(): WideHostInfo | null {
  return useContext(InWideShell);
}

export const OpenImportActivity = createContext<(() => void) | null>(null);
