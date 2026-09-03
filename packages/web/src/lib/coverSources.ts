/**
 * Sources for covering a Budgets-checklist step (Cover / Top up) when "To be budgeted" alone
 * does not have to be the answer: the pool AND every other envelope with money left are offered
 * side by side, each with an editable amount, and money is moved by plain allocation edits —
 * donors' allocations go down, the target's goes up (see `CoverStepSheet`).
 *
 * Pure: the sheet owns the editing state; this module only answers "who may give", "what to
 * propose" and "is what the human typed still a plan we can write".
 */

/** The pseudo-source id for "To be budgeted" in a cover plan — not an envelope id, and it never
 *  gets a write of its own: allocating to the target draws from the pool implicitly. */
export const POOL_SOURCE_ID = "pool";

export interface CoverDonor {
  id: string;
  name: string;
  /** Money left in the donor this month, minor units, > 0 by construction. */
  available: number;
  isSavings: boolean;
}

export type CoverDonorInput = { id: string; name: string; available: number; archived: boolean; isSavings: boolean };

/** amounts per source id (`POOL_SOURCE_ID` or an envelope id), minor units */
export type CoverPlan = Record<string, number>;

/**
 * Envelopes that may give: unarchived, not the target, with a positive `available`. Largest
 * slack first so the greedy proposal (and the human's eye) lands on the envelope that hurts
 * least — savings envelopes go LAST whatever their slack: they are the money the human is
 * deliberately not spending, so they are offered but never suggested first.
 */
export function coverDonors(
  envelopes: CoverDonorInput[],
  targetId: string,
  compareNames: (a: string, b: string) => number = (a, b) => a.localeCompare(b),
): CoverDonor[] {
  return envelopes
    .filter((e) => !e.archived && e.id !== targetId && e.available > 0)
    .map((e) => ({ id: e.id, name: e.name, available: e.available, isSavings: e.isSavings }))
    .sort((a, b) => Number(a.isSavings) - Number(b.isSavings) || b.available - a.available || compareNames(a.name, b.name));
}

/**
 * The default plan: the pool first (a negative pool is empty — it cannot give), then donors in
 * their offered order, each drained only as far as needed. When everything together still falls
 * short, the plan is simply what exists; the sheet shows the gap, it does not invent money.
 */
export function proposeCoverSources(amount: number, readyToAssign: number, donors: readonly CoverDonor[]): CoverPlan {
  const plan: CoverPlan = {};
  let remaining = amount;
  if (remaining <= 0) return plan;
  const fromPool = Math.min(remaining, Math.max(0, readyToAssign));
  if (fromPool > 0) {
    plan[POOL_SOURCE_ID] = fromPool;
    remaining -= fromPool;
  }
  for (const d of donors) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, d.available);
    if (take <= 0) continue;
    plan[d.id] = take;
    remaining -= take;
  }
  return plan;
}

export interface CoverPlanStatus {
  /** Total the plan moves into the target, minor units. */
  sum: number;
  /** Source ids asked for more than they have (or for a negative amount). */
  overdrawn: string[];
  /** `sum > 0` and nothing overdrawn — the only state the sheet's CTA writes. */
  valid: boolean;
}

/** Entries for sources no longer offered are ignored — a donor may have been archived or spent
 *  down while the sheet stayed open, and a stale entry must neither count nor block. */
export function coverPlanStatus(plan: CoverPlan, sources: ReadonlyArray<{ id: string; available: number }>): CoverPlanStatus {
  let sum = 0;
  const overdrawn: string[] = [];
  for (const s of sources) {
    const amount = plan[s.id] ?? 0;
    if (amount === 0) continue;
    if (amount < 0 || amount > s.available) overdrawn.push(s.id);
    sum += amount;
  }
  return { sum, overdrawn, valid: sum > 0 && overdrawn.length === 0 };
}
