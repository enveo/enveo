export type GoalProgress = { pct: number; funded: boolean; missing: number };

/**
 * Amount still missing to reach `target` given a raw `allocated` (minor units).
 * A negative allocation counts as zero, so the full target is missing. Shared
 * by `goalProgress` (per-envelope display) and `fillByGoals` (fill proposal) —
 * one clamp rule, both consumers.
 */
function missingOf(target: number, allocated: number): number {
  return Math.max(0, target - Math.max(0, allocated));
}

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
export function goalProgress(e: { monthlyTarget: number | null; allocated: number }): GoalProgress | null {
  const target = e.monthlyTarget;
  if (target == null || target <= 0) return null;
  const allocated = Math.max(0, e.allocated);
  return {
    pct: Math.min(100, (allocated / target) * 100),
    funded: e.allocated >= target,
    missing: missingOf(target, e.allocated),
  };
}

export interface FillProposal {
  envelopeId: string;
  add: number;
}

/**
 * Proposes how to spend `available` (minor units, "to be budgeted") across
 * envelopes with a monthly target, to be applied as `allocated += add` ops.
 *
 * Strategy — full-or-skip in GROUP-MAJOR order (spec 2026-07-31, order fixed
 * 2026-08-02): walk envelopes ordered by `(groupSort, sort)` ascending — the
 * SAME order the Budget screen renders in (group-major: `group.sort`, then
 * `env.sort` within the group; see `Budget.tsx`) — and, for each with a
 * missing amount (see `missingOf`, same clamp rule as `goalProgress.missing`)
 * that fits within what's left of the pool, propose funding it in full;
 * envelopes that don't fit are skipped (not partially filled) so a later,
 * cheaper goal can still be reached — never spend the pool part-way into a
 * goal that then still shows unfunded. Full-or-skip makes order the feature,
 * so the fill order must match what the user sees on screen, not the flat
 * envelope `sort` alone (which can disagree with the visual order once
 * envelopes are grouped).
 *
 * Fallback — single partial: if nothing fits in full (the pool is smaller
 * than every remaining missing amount), propose a single partial allocation
 * of the whole pool to the FIRST unfunded envelope in group-major order. This
 * guarantees the action never proposes nothing while there is money
 * available and at least one unfunded goal — a "no-op" result would be a
 * worse user experience than a visible partial progress toward the
 * top-priority goal.
 *
 * Archived envelopes and envelopes without a positive target are ignored.
 * Returns `[]` when `available <= 0` or there is nothing left to fund.
 */
export function fillByGoals(
  envelopes: Array<{
    id: string;
    archived: boolean;
    sort: number;
    groupSort: number;
    allocated: number;
    monthlyTarget: number | null;
  }>,
  available: number,
): FillProposal[] {
  if (available <= 0) return [];
  const candidates = envelopes.filter((e) => !e.archived && (e.monthlyTarget ?? 0) > 0).sort((a, b) => a.groupSort - b.groupSort || a.sort - b.sort);

  const out: FillProposal[] = [];
  let remaining = available;
  for (const e of candidates) {
    const m = missingOf(e.monthlyTarget!, e.allocated);
    if (m > 0 && m <= remaining) {
      out.push({ envelopeId: e.id, add: m });
      remaining -= m;
    }
  }

  if (out.length === 0) {
    const first = candidates.find((e) => missingOf(e.monthlyTarget!, e.allocated) > 0);
    if (first) out.push({ envelopeId: first.id, add: remaining });
  }

  return out;
}
