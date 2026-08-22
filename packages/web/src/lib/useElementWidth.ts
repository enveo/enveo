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
import { useEffect, useState } from "react";

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
 * Returns a callback ref (not a `RefObject`) that attaches the observer when the element
 * mounts, and the current width or fallback. The fallback is used on the first render
 * (before the observer fires), when the element is absent, or when it has collapsed to
 * zero or reported a non-finite width.
 *
 * ResizeObserver is used rather than a window `resize` listener because a chart's box
 * can change when a panel opens or a column reflows — not only when the window resizes.
 *
 * **Invariant:** the ref attaches to a block-level element whose content box width
 * equals the chart's rendered `width: 100%` dimension — no horizontal padding or border
 * between the element and the SVG.
 */
export function useElementWidth<T extends HTMLElement>(fallback: number): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setMeasured(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  useEffect(() => {
    if (!el) setMeasured(null);
  }, [el]);
  return [setEl, chartWidth(measured, fallback)];
}
