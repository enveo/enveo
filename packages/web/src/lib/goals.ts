import { goalProgress, type StateResponse } from "@enveo/shared";

export { type GoalProgress, goalProgress } from "@enveo/shared";

export function canFillGoals(state: StateResponse): boolean {
  return state.readyToAssign > 0 && state.envelopes.some((e) => !e.archived && (goalProgress(e)?.missing ?? 0) > 0);
}
