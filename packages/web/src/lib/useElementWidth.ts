/**
 * Container measurement for report charts (spec §4a).
 *
 * Every chart in this app used to bake its phone-width geometry into its viewBox. That works
 * on exactly one viewport: an SVG with `width="100%"` and a viewBox narrower than its box gets
 * letterboxed by the default `preserveAspectRatio="xMidYMid meet"`, which scales by the SMALLER
 * axis ratio. `CashflowBandChart` already hit that once and "fixed" it by hardcoding the phone
 * band's width, which reintroduces it at any other width. Measuring the container instead is
 * the only rule that holds at every size, and `preserveAspectRatio="none"` is NOT the
 * alternative — it stretches round caps into ellipses.
 */
import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * The width a chart should draw at. Pure, and total: a container that has not been measured
 * yet, has collapsed to zero, or reports something non-finite all fall back rather than
 * producing a viewBox that divides by zero or renders nothing. The rounding happens BEFORE
 * the usability check: the decision "is this usable" must apply to the actual returned value,
 * not the raw measurement.
 */
export function chartWidth(measured: number | null, fallback: number): number {
  if (measured === null || !Number.isFinite(measured)) return fallback;
  const rounded = Math.round(measured);
  return rounded > 0 ? rounded : fallback;
}

/**
 * Measure an element's content-box width, live.
 *
 * Returns the fallback on the first render (before the observer fires) so a chart never paints
 * at zero width, and again whenever the element is absent or collapsed. ResizeObserver rather
 * than a window `resize` listener: a chart's box changes when a panel opens or a column
 * reflows, not only when the window does.
 */
export function useElementWidth<T extends HTMLElement>(fallback: number): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setMeasured(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, chartWidth(measured, fallback)];
}
