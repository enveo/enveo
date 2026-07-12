export type GoalProgress = { pct: number; funded: boolean; missing: number };

/**
 * Envelope monthly-target progress (allocation vs `monthlyTarget`, amounts in minor units).
 *
 * Returns `null` when the envelope has no target (`monthlyTarget` null/0/negative) —
 * then the UI shows no progress elements.
 *
 * - `pct` = min(100, max(0, allocated/target*100)) — a negative allocation yields 0.
 * - `funded` = allocated ≥ target.
 * - `missing` = max(0, target − max(0, allocated)) — a negative allocation counts
 *   as zero, so the full target is missing (consistent with pct = 0).
 */
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
