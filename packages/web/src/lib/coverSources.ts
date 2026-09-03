import { type ClientLedger, computeStateResponse, nextMonth } from "@enveo/shared";

/**
 * Sources for covering a Budgets-checklist step (Cover / Top up) when "To be budgeted" alone
 * does not have to be the answer: the pool AND every other envelope with money left are offered
 * side by side, each with an editable amount, and money is moved by plain allocation edits —
 * donors' allocations go down, the target's goes up (see `CoverStepSheet`).
 *
 * Pure: the sheet owns the editing state; this module only answers "who may give", "how much
 * may each give", "what to propose" and "is what the human typed still a plan we can write".
 */

/** The pseudo-source id for "To be budgeted" in a cover plan — not an envelope id, and it never
 *  gets a write of its own: allocating to the target draws from the pool implicitly. Envelope ids
 *  are UUIDs at every entry point, so this cannot collide with one. */
export const POOL_SOURCE_ID = "pool";

export type CoverDonorLike = {
  id: string;
  name: string;
  /** Money the donor may give this month, minor units (see `donorSlack` for a past month). */
  available: number;
  archived: boolean;
  /** Optional on purpose: a replica row written before the flag existed carries NO key (CLAUDE.md
   *  pitfall), and a missing flag means "not savings" — never NaN in a comparator. */
  isSavings?: boolean;
};

/** amounts per source id (`POOL_SOURCE_ID` or an envelope id), minor units */
export type CoverPlan = Record<string, number>;

/**
 * Envelopes that may give: unarchived, not the target, with a positive `available`. Largest
 * slack first so the greedy proposal (and the human's eye) lands on the envelope that hurts
 * least — savings envelopes go LAST whatever their slack: they are the money the human is
 * deliberately not spending, so they are offered but never suggested first. Returns the input
 * objects themselves (filtered and ordered), so a caller keeps whatever else it needs on them.
 */
export function coverDonors<E extends CoverDonorLike>(
  envelopes: readonly E[],
  targetId: string,
  compareNames: (a: string, b: string) => number = (a, b) => a.localeCompare(b),
): E[] {
  return envelopes
    .filter((e) => !e.archived && e.id !== targetId && e.available > 0)
    .sort((a, b) => Number(!!a.isSavings) - Number(!!b.isSavings) || b.available - a.available || compareNames(a.name, b.name));
}

/** How far `donorSlack` looks ahead at most — a past month older than this is capped, not ignored:
 *  every month up to the cap is still checked, and older views simply do not exist in practice. */
const SLACK_HORIZON_MONTHS = 36;

/**
 * What each envelope can REALLY give when the viewed month is in the past.
 *
 * `available` is cumulative — a cut to July's allocation lowers July's available and, through
 * carry-over (no floor at 0), every later month's too. July's "50 left" is not free money if
 * Groceries spent it down to 5 by today: taking 30 in July would leave September at −25, a brand
 * new overspend on a screen that never showed September. So the slack offered for a past month
 * is the MINIMUM available over every month from the viewed one up to `currentMonth`. For the
 * current or a future month that is just the viewed month's own figure — a cut there touches
 * nothing the ledger has already consumed.
 */
export function donorSlack(ledger: ClientLedger, month: string, currentMonth: string): Map<string, number> {
  const slack = new Map<string, number>();
  let m = month;
  for (let i = 0; i < SLACK_HORIZON_MONTHS; i++) {
    for (const e of computeStateResponse(ledger, m).envelopes) {
      const prev = slack.get(e.id);
      slack.set(e.id, prev === undefined ? e.available : Math.min(prev, e.available));
    }
    if (m >= currentMonth) break;
    m = nextMonth(m);
  }
  return slack;
}

/**
 * The default plan: the pool first (a negative pool is empty — it cannot give), then donors in
 * their offered order, each drained only as far as needed. When everything together still falls
 * short, the plan is simply what exists; the sheet shows the gap, it does not invent money.
 */
export function proposeCoverSources(amount: number, readyToAssign: number, donors: ReadonlyArray<{ id: string; available: number }>): CoverPlan {
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
  overdrawn: Set<string>;
  /** `sum > 0` and nothing overdrawn — the only state the sheet's CTA writes. */
  valid: boolean;
}

/** Entries for sources no longer offered are ignored — a donor may have been archived or spent
 *  down while the sheet stayed open, and a stale entry must neither count nor block. */
export function coverPlanStatus(plan: CoverPlan, sources: ReadonlyArray<{ id: string; available: number }>): CoverPlanStatus {
  let sum = 0;
  const overdrawn = new Set<string>();
  for (const s of sources) {
    const amount = plan[s.id] ?? 0;
    if (amount === 0) continue;
    if (amount < 0 || amount > s.available) overdrawn.add(s.id);
    sum += amount;
  }
  return { sum, overdrawn, valid: sum > 0 && overdrawn.size === 0 };
}

/**
 * The plan as it will actually be WRITTEN, clamped to what exists right now: the pool part to
 * the live pool, each donor's part to its live slack, and donors that are gone (archived, or no
 * longer offered) dropped. Confirm runs this against a fresh replica read — the plan was built
 * against a render that may be several sync pulls old, and a stale "take 50" against an envelope
 * that has 5 left would manufacture the very overspend the sheet exists to fix.
 */
export function clampCoverPlan(
  plan: CoverPlan,
  readyToAssign: number,
  donors: ReadonlyArray<{ id: string; available: number }>,
): { pool: number; takes: Array<{ id: string; take: number }>; moved: number } {
  const pool = Math.min(Math.max(0, plan[POOL_SOURCE_ID] ?? 0), Math.max(0, readyToAssign));
  const takes: Array<{ id: string; take: number }> = [];
  let moved = pool;
  for (const d of donors) {
    const take = Math.min(Math.max(0, plan[d.id] ?? 0), Math.max(0, d.available));
    if (take <= 0) continue;
    takes.push({ id: d.id, take });
    moved += take;
  }
  return { pool, takes, moved };
}
