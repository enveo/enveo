/** goalProgress lives in shared (parity with the agent tools) — web only re-exports. */
import { goalProgress, type StateResponse } from "@enveo/shared";

export { type GoalProgress, goalProgress } from "@enveo/shared";

/**
 * Can "Fill by goals" actually do anything right now? — the ONE entry-visibility predicate for
 * every button that opens `FillGoalsSheet`.
 *
 * Both halves are load-bearing: without a pool there is nothing to assign, and with every goal
 * already funded there is nothing to assign it TO. The sheet's own CTA is disabled in either
 * case, so an entry point that ignores this opens a sheet whose only action is dead — the
 * "it does nothing" shape of owner round 8 item 32, arrived at from the other side.
 *
 * This used to be written out at four call sites (Budget's own button, the Goals report, the
 * Goals widget) "kept in sync by inspection", and the two entry points that were added LAST —
 * the wide rail's pill and the fold strip's copy of it — simply never got the condition. Hence
 * one exported function: a new entry point cannot forget a rule it has to call.
 *
 * The report/widget spellings folded in a `missSum` those screens compute for their own display;
 * `missSum > 0` is exactly "some non-archived envelope with a goal is still short", so this is
 * the same predicate with the incidental sum removed.
 */
export function canFillGoals(state: StateResponse): boolean {
  return state.readyToAssign > 0 && state.envelopes.some((e) => !e.archived && (goalProgress(e)?.missing ?? 0) > 0);
}
