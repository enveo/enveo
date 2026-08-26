import { TEAL } from "../lib/theme";
import { useElementWidth } from "../lib/useElementWidth";

/**
 * `Sparkline` lives OUTSIDE `reportKit.tsx` on purpose (design parity wave D task 1, bundle
 * investigation): it is the ONLY export of that ~900-line module a truly EAGER path needs
 * (`components/widgets.tsx`'s Start-screen Net-worth widget, statically imported off
 * `App.tsx` → `screens/Start.tsx`) — everything else there (`ReportShell`, `NetWorthChart`,
 * `CalendarHeatmap`, `gridTicks`, `UndoBar`, `TrendSpark`, …) is reached only through the LAZY
 * `Reports` chunk. Rollup does not partially tree-shake a single-file module across that
 * boundary: importing one named export from `reportKit.tsx` pulled the WHOLE compiled module
 * into the eager entry chunk as a duplicate of the lazy chunk's own copy, so any edit to
 * `ReportShell` (etc.) silently grew the eager §3f budget too — confirmed by grepping the built
 * `index-*.js` for a string unique to an unrelated `ReportShell` branch. Moving the one genuinely
 * eager component (plus the tiny polyline math it needs) into its own module keeps that module's
 * eager footprint to exactly what `widgets.tsx` actually calls, and `reportKit.tsx` importing
 * `polylineCoords` back from here (for `TrendSpark`) costs nothing extra there — this file is
 * already loaded on both paths either way, just no longer standing in for the rest of the kit.
 */

/** Shared normalized-polyline math for `TrendSpark`/`Sparkline`: x evenly spaced across `w`
 *  (`pad` inset each side), y linearly scaled between the series' own min/max onto `h` (a
 *  perfectly flat series draws a level line at `h/2` rather than dividing by a zero range).
 *  Returns RAW (unrounded) coords — callers needing a `points` string apply `.toFixed(1)`
 *  themselves at render time (Sparkline's last-point dot deliberately uses the raw value, not
 *  the rounded one, matching its pre-extraction behavior). Assumes `series.length >= 2`. */
export function polylineCoords(series: number[], w: number, h: number, pad: number): (readonly [number, number])[] {
  const n = series.length;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  const flat = max === min;
  // A sub-pixel container (a panel mid-animation, a flex item mid-reflow) can transiently
  // measure ~1px wide; with pad=2/3 that made `w - 2*pad` negative, so x ran backwards from
  // `pad` down to `pad - |negative|` — a reversed, partly negative-x polyline for that one frame.
  // Clamping the inner width to at least 1 keeps that frame from rendering nonsense; it's
  // transient and self-corrects on the next ResizeObserver callback, so this is not a fix for the
  // underlying measurement, only for what gets drawn in between.
  const innerW = Math.max(1, w - 2 * pad);
  return series.map((v, i) => [pad + (i / (n - 1)) * innerW, flat ? h / 2 : pad + (1 - (v - min) / range) * (h - 2 * pad)] as const);
}

/** Net-worth mini-sparkline on the card (polyline without fill; stroke via style — var(--accent) does not work in SVG attributes).
 *  Exported for the Start-screen Net worth widget (components/widgets.tsx) — same visual, no duplication.
 *  `stroke` defaults to TEAL (today's behavior, unchanged for existing callers); pass an on-band color
 *  (e.g. `hc(C.headerInk, "var(--accent)")`) when painted on a Duet navy band, where TEAL would be
 *  invisible (navy on navy). `dotColor` is opt-in — omitted (the default) draws no last-point dot at all. */
export function Sparkline({ points, stroke = TEAL, dotColor }: { points: { month: string; total: number }[]; stroke?: string; dotColor?: string }) {
  const [boxRef, W] = useElementWidth<HTMLDivElement>(320);
  const n = points.length;
  if (n < 2) return null;
  const H = 44,
    pad = 3;
  const coords = polylineCoords(
    points.map((p) => p.total),
    W,
    H,
    pad,
  );
  const pts = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1]!;
  return (
    <div ref={boxRef} style={{ marginTop: 8 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={44} aria-hidden style={{ display: "block" }}>
        <polyline points={pts} fill="none" style={{ stroke }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {dotColor && <circle cx={last[0]} cy={last[1]} r={3.5} style={{ fill: dotColor }} />}
      </svg>
    </div>
  );
}
