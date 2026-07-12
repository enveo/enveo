export type GoalProgress = { pct: number; funded: boolean; missing: number };












export function goalProgress(e: {
  monthlyTarget: number | null;
  allocated: number;
}): GoalProgress | null {
  const target = e.monthlyTarget;
  if (target == null || target <= 0) return null;
  const allocated = Math.max(0, e.allocated);
  return {
    pct: Math.min(100, (allocated / target) * 100),
    funded: e.allocated >= target,
    missing: Math.max(0, target - allocated),
  };
}
