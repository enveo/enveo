/**
 * Which of the Budget screen's two allocation sheets is open — ONE App-owned value, not two
 * one-shot flags (owner round 8 item 32).
 *
 * Both sheets write real allocations ("Suggest a distribution" applies a whole distribution,
 * "Fill by goals" assigns the goal shortfalls), so "which one is open" is a single choice, never
 * an independent boolean per sheet: the union below makes "both open at once" — and with it the
 * double-write hazard of two live Assign buttons over the same `readyToAssign` — unrepresentable.
 *
 * WHY THIS IS NOT THE `addPreset` DEEP-LINK-FLAG IDIOM. The consumption-cleared flag pattern
 * (`addPreset`, and what these two sheets used before this module) delivers an intent to a screen
 * that is about to MOUNT: App sets the flag, the screen reads it as its initial state on mount and
 * acks the consumption, and the flag is one-shot precisely because a remount must not replay it.
 * That fits a preset for a FRESH Add. It does not fit these two, because their entry points live
 * OUTSIDE the Budget screen and stay clickable while the Budget screen is already mounted: the
 * wide rail's "✨ Suggest" / "Fill by goals" pills, the fold TBB strip's copies of them, the Start
 * board's quick actions and the Goals report's "Fill ›". Raising an intent from any of those while
 * Budget was already on screen changed the prop but not the mounted component — the sheet simply
 * never opened (the owner's "sometimes they do nothing, especially one after the other"), and the
 * unconsumed flag then stayed armed until the NEXT real mount, which opened a sheet nobody asked
 * for and, with the other flag also armed, both at once. Measured live before this fix: the rail
 * pills are hit-testable even while a sheet is open, so the intent can be raised at any moment.
 *
 * The fix is the one App already applies to every other sheet the wide chrome has to drive from
 * outside its screen (`editWidgetsOpen`, `manageOpen`, `wideBoardEdit` — "same sheets, same
 * buttons, only the state's home moves"): lift the state. With the open sheet held in App there is
 * no delivery step left to miss and no flag left to go stale — the state IS the answer, so every
 * entry point works from any screen, in any order, any number of times.
 */

/** The Budget screen's two allocation sheets. */
export type BudgetSheet = "suggest" | "fillGoals";

/** `null` = neither sheet is open. */
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
