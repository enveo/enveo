import { PANE_W, RAIL_W, type ViewMode } from "../../lib/viewMode";

/**
 * Right-panel width for wide layouts (mockup inconsistency 9 — the design bundle's geometry
 * only sums at exactly 1440/1104px; real windows vary continuously between and beyond those).
 * Rail and panel are fixed per mode; the PRIMARY column flexes (`flex:1, minWidth:0`), so
 * collapsing the panel reclaims exactly this width via the panel's own `margin-right`
 * transition (WideShell) — no separate width transition on the primary is needed.
 *
 * At the two canonical sizes this reproduces the mock's own numbers exactly: 1440 desktop →
 * 804px primary, 1104 fold → 484px primary (`PANE_W.fold`, 552, is deliberately WIDER than that
 * — on the fold the detail pane is the thing being worked on).
 */

export const PRIMARY_MIN = 390;

export function paneWidthFor(mode: Exclude<ViewMode, "phone">, viewportW: number): number {
  return Math.min(PANE_W[mode], Math.max(320, viewportW - RAIL_W[mode] - PRIMARY_MIN));
}
