// The lazy-chunk latch every deliberate-tap sheet in the app already uses — imported rather than
// re-implemented so there is exactly ONE "has this ever been open" rule (see `useBudgetSheets`).
import { useOpenedOnce } from "../components/lazy";

export type BudgetSheet = "suggest" | "fillGoals";

export type BudgetSheetState = BudgetSheet | null;

/**
 * What can move the open sheet:
 * - `open` — ANY entry point asking for a sheet (a rail/fold-strip pill, a Start widget, the
 *   Goals report's "Fill ›", or the Budget screen's own two buttons). Always wins, so pressing
 *   the other one swaps sheets instead of stacking them, and pressing the same one again is a
 *   no-op that leaves it open rather than a dead click.
 * - `close` — the sheet's own ✕ / backdrop / cancel, and the successful apply that dismisses it.
 * - `leave` — App's `nav()`, i.e. any normal navigation. Kept explicit rather than folded into
 *   `close`: it is what preserves the pre-lift behaviour that leaving Budget (which used to
 *   UNMOUNT the sheet's local state) never brings a sheet back when the user returns.
 */
export type BudgetSheetEvent = { kind: "open"; sheet: BudgetSheet } | { kind: "close" } | { kind: "leave" };

/**
 * The single transition function — App drives every change to `budgetSheet` through this, as a
 * reducer (`setBudgetSheet((s) => budgetSheetAfter(s, event))`) so a `leave` and an `open` queued
 * in the SAME batch (that is `openBudgetFillGoals`: `nav("budget")` then the open) settle in order
 * with the open last, instead of racing two plain values off one stale render.
 *
 * `_prev` is deliberately ignored by every arm: the sheet that ends up open never depends on what
 * was open before. That independence IS the fix — it is what makes the entry points work in any
 * order, any number of times, with nothing left armed in between (pinned in budgetSheet.test.ts).
 */
export function budgetSheetAfter(_prev: BudgetSheetState, event: BudgetSheetEvent): BudgetSheetState {
  switch (event.kind) {
    case "open":
      return event.sheet;
    case "close":
    case "leave":
      return null;
  }
}

export type BudgetSheetView = {
  suggest: boolean;

  fillGoals: boolean;

  suggestOpened: boolean;

  fillGoalsOpened: boolean;
};
/**
 * The Budget screen's sheet WIRING, in one place: the App-owned `sheet` value → what the screen
 * renders, on EVERY render.
 *
 * This is a hook and not two inline expressions because the defect it fixes was invisible in
 * inline form. The screen used to hold `useState(!!initialSuggest)` — a value seeded from a prop
 * at MOUNT and never again — so an entry point pressed while the screen was already mounted moved
 * a prop that nothing read. Read vs. latched are one character apart at the call site and behave
 * identically on first render, which is exactly why no test caught the regression: distinguishing
 * them needs a SECOND render of the SAME component instance with a different prop, and the only
 * place that can be arranged headlessly (no DOM in this toolchain) is around a hook —
 * budgetSheet.test.ts drives this one through prop sequences and asserts the reads track them.
 *
 * `useOpenedOnce` is part of the wiring, not decoration: `suggestOpened`/`fillGoalsOpened` latch
 * true on first show and stay true, which is what keeps a sheet's lazy chunk (and the state
 * inside it) alive across close→reopen. It also makes the mount-vs-update distinction visible in
 * the return value — after a swap the previous sheet is `false` but still `…Opened`.
 */
export function useBudgetSheets(sheet: BudgetSheetState): BudgetSheetView {
  const suggest = sheet === "suggest";
  const fillGoals = sheet === "fillGoals";
  return { suggest, fillGoals, suggestOpened: useOpenedOnce(suggest), fillGoalsOpened: useOpenedOnce(fillGoals) };
}
