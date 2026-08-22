/**
 * Pure summaries for the Reports overview cards (spec 2026-07-11-raporty-b; A3 triage rule
 * 2026-07-28; zero-budget boundary fix 2026-07-29).
 *
 * - `budgetUsage` — the single threshold and percentage rule shared by every report consumer.
 *   A percentage exists only for a positive raw budget; zero/negative budgets remain `null`
 *   instead of acquiring a fabricated one-minor-unit denominator. Overspending is defined by
 *   `left < 0`, independently of percentage. Near means a real percentage >= 80 with money
 *   still left; exact exhaustion stays calm.
 * - `budgetsSummary` — envelope counters via `budgetUsage`; an envelope counts when it has
 *   an allocation (allocated+carryIn>0) or spending in the month.
 * - `budgetsOverAmount` — the € total the hub's Budgets mini-card shows under the pills;
 *   Σ(-left) over rows `budgetUsage` puts in "over".
 */

export interface BudgetsSummary {
  over: number; // overspent (left < 0)
  near: number; // near the limit (pct >= 80% AND left > 0)
  ok: number; // the rest, including "used up" (pct === 100, left === 0)
}

export type BudgetStatus = "over" | "near" | "ok";

export type BudgetEnvelope = {
  archived: boolean;
  allocated: number;
  carryIn: number;
  spent: number;
};

export interface BudgetUsage {
  rawBudget: number;
  spent: number;
  left: number;
  pct: number | null;
  status: BudgetStatus;
}

export interface BudgetRowPresentation {
  percentage: number | null;
  visualBarPct: number;
  noBudget: boolean;
  overspend: number;
}

export interface BudgetUsageRow extends BudgetUsage {
  name: string;
}

/** Canonical report usage. A non-positive budget has no meaningful percentage. */
export function budgetUsage(envelope: BudgetEnvelope): BudgetUsage {
  const rawBudget = envelope.allocated + envelope.carryIn;
  const spent = envelope.spent;
  const left = rawBudget - spent;
  const pct = rawBudget > 0 ? (Math.max(0, spent) / rawBudget) * 100 : null;
  const status = left < 0 ? "over" : pct !== null && pct >= 80 && left > 0 ? "near" : "ok";
  return { rawBudget, spent, left, pct, status };
}

/** Presentation-only values. `visualBarPct` must never feed report calculations. */
export function budgetRowPresentation(usage: BudgetUsage): BudgetRowPresentation {
  return {
    percentage: usage.pct,
    visualBarPct: usage.pct ?? (usage.left < 0 ? 100 : 0),
    noBudget: usage.rawBudget <= 0,
    overspend: usage.left < 0 ? -usage.left : 0,
  };
}

/** Sort within a status section; rows without a denominator are the first warning group. */
export function compareBudgetUsageRows(left: BudgetUsageRow, right: BudgetUsageRow, compareNames: (left: string, right: string) => number): number {
  if (left.pct === null && right.pct !== null) return -1;
  if (left.pct !== null && right.pct === null) return 1;
  if (left.pct !== null && right.pct !== null) {
    return right.pct - left.pct || compareNames(left.name, right.name);
  }
  return -right.left - -left.left || compareNames(left.name, right.name);
}

/** Counters for the "Envelope budgets" cards — threshold/filter parity with BudgetsReport. */
export function budgetsSummary(envelopes: BudgetEnvelope[]): BudgetsSummary {
  const out: BudgetsSummary = { over: 0, near: 0, ok: 0 };
  for (const e of envelopes) {
    if (e.archived) continue;
    if (!(e.allocated + e.carryIn > 0 || e.spent > 0)) continue;
    out[budgetUsage(e).status]++;
  }
  return out;
}

/** Σ(-left) over "over" envelopes — the € amount shown under the hub's Budgets mini-card pills.
 *  Same filter + usage model as budgetsSummary, so the amount and pill count stay consistent. */
export function budgetsOverAmount(envelopes: BudgetEnvelope[]): number {
  let total = 0;
  for (const e of envelopes) {
    if (e.archived) continue;
    if (!(e.allocated + e.carryIn > 0 || e.spent > 0)) continue;
    const usage = budgetUsage(e);
    if (usage.status === "over") total += -usage.left;
  }
  return total;
}

/* ── Pace projection (spec 2026-08-21) ─────────────────────────────────────────────────
 * The Budgets report stops being a passive triage and becomes a checklist of fixes. That
 * needs one thing today's model cannot answer: "this envelope is fine RIGHT NOW, but will it
 * still be fine on the last day of the month?" — a straight-line projection of the current
 * spend rate to month end.
 *
 * `risk` is layered ON TOP of `budgetUsage`, never in place of it. `over` remains `left < 0`
 * and nothing else: an envelope with a zero budget and any spending has a floored denominator
 * (`pct` is null by construction) and must never be reported as "used up" or "on pace".
 */

/** Number of days in `month` (YYYY-MM), leap-year aware.
 *  Shared by `monthProgress` below and `uiState.monthRuler` (the Start screen's hero ruler) —
 *  the arithmetic is the only thing those two have in common. `monthProgress` clamps a VIEWED
 *  month against today (1 when past, 0 when future) and `monthRuler` only ever describes the
 *  CURRENT month for the hero ruler; keep those two jobs separate and never fold them into one
 *  function in the name of finishing this merge. */
export function daysInMonth(month: string): number {
  return new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
}

/** How much of `month` has elapsed as of `today` (YYYY-MM-DD), in (0..1].
 *  A past month is 1, a future month is 0, the current month is day-inclusive so that the
 *  first day of the month already counts as elapsed time and never divides by zero. */
export function monthProgress(month: string, today: string): number {
  const currentMonth = today.slice(0, 7);
  if (month < currentMonth) return 1;
  if (month > currentMonth) return 0;
  const day = +today.slice(8, 10);
  return Math.min(1, day / daysInMonth(month));
}

export type BudgetPaceBucket = "over" | "risk" | "near" | "usedUp" | "ok";

export interface BudgetPace {
  /** Spending projected to the end of the month at the current rate, minor units. */
  projected: number;
  bucket: BudgetPaceBucket;
}

/** Classify an envelope for the Budgets checklist. `progress` comes from `monthProgress`. */
export function budgetPace(envelope: BudgetEnvelope, progress: number): BudgetPace {
  const usage = budgetUsage(envelope);
  const spent = Math.max(0, usage.spent);
  // progress <= 0 (a future month) means there is no elapsed time to extrapolate from, so the
  // honest projection is what has actually been spent — which can never trigger `risk`.
  const projected = progress > 0 ? Math.round(spent / Math.min(1, progress)) : spent;

  if (usage.status === "over") return { projected, bucket: "over" };
  if (usage.status === "near") return { projected, bucket: "near" };
  // status === "ok" from here: either genuinely calm, or spent to exactly 100%.
  if (usage.pct !== null && usage.pct >= 100) return { projected, bucket: "usedUp" };
  if (usage.rawBudget > 0 && spent > 0 && projected > usage.rawBudget) return { projected, bucket: "risk" };
  return { projected, bucket: "ok" };
}

export type BudgetStepKind = "over" | "risk" | "near";

export type BudgetStepInput = BudgetEnvelope & { id: string; name: string };

export interface BudgetStep {
  envelopeId: string;
  name: string;
  kind: BudgetStepKind;
  /** Money to move into the envelope to clear this step, minor units, always > 0. */
  amount: number;
  /** True when the human dismissed this step. Still returned — the report shows it, flagged. */
  ignored: boolean;
  /** `amount` capped at the pool, minor units. Equals `amount` when the pool covers it. */
  fundable: number;
}

/** The cushion a near-limit envelope is topped back up to, as a share of its budget. */
const NEAR_CUSHION = 0.2;

const STEP_ORDER: Record<BudgetStepKind, number> = { over: 0, risk: 1, near: 2 };

/**
 * The near-limit top-up, solved for the cushion condition AFTER the top-up is applied.
 *
 * The button's amount `A` gets added to `allocated`, so `rawBudget` (`B`) grows by `A` too —
 * the target the button is supposed to hit moves every time you hit it. Naively aiming at
 * today's target (`round(B * NEAR_CUSHION) - left`) only closes 80% of the gap, so pressing
 * the button repeatedly chases a shrinking residual instead of clearing the step. Solving for
 * `left + A >= NEAR_CUSHION * (B + A)` gives `A >= (NEAR_CUSHION * B - left) / (1 - NEAR_CUSHION)`,
 * which lands exactly on the cushion once applied. `Math.ceil` (never `round` or a floor) is
 * required here: rounding down would leave a one-cent shortfall post-press and reproduce the
 * same bug in miniature.
 */
function nearTopUp(rawBudget: number, left: number): number {
  const shortfall = NEAR_CUSHION * rawBudget - left;
  return Math.max(0, Math.ceil(shortfall / (1 - NEAR_CUSHION)));
}

/**
 * The Budgets report's checklist: what to fix, in the order worth fixing it.
 *
 * Overspends lead — that money is already gone. Pace risks follow, because they are cheapest
 * to fix before the month ends. Near-limit top-ups come last. Within a kind the largest amount
 * leads, so the list opens with the step that moves the most.
 *
 * A step is only emitted when it has something to do: `amount > 0`. An envelope already at its
 * cushion produces no step rather than a no-op button. `options.ignored` never removes a step
 * from the result — it flags one the human already dismissed so the report can still show it
 * (marked, with a restore action) instead of making it vanish; filtering it here would cost every
 * caller a second pass over the same data to recover what was hidden. Ordering ignores the flag
 * too — the report groups ignored steps visually, this function does not.
 *
 * `options.readyToAssign` is the pool of unbudgeted money: `fundable` caps `amount` at that pool
 * so a caller never puts a button on screen offering to move more money than exists (the report
 * shows the amount on the button itself, with no confirmation dialog). Omitting the pool leaves
 * `fundable` equal to `amount` — today's unlimited behaviour, so existing callers stay valid.
 */
export function budgetSteps(envelopes: BudgetStepInput[], progress: number, options?: { ignored?: ReadonlySet<string>; readyToAssign?: number }): BudgetStep[] {
  const steps: BudgetStep[] = [];
  for (const e of envelopes) {
    if (e.archived) continue;
    if (!(e.allocated + e.carryIn > 0 || e.spent > 0)) continue;

    const usage = budgetUsage(e);
    const { bucket, projected } = budgetPace(e, progress);
    if (bucket !== "over" && bucket !== "risk" && bucket !== "near") continue;

    const amount = bucket === "over" ? -usage.left : bucket === "risk" ? projected - usage.rawBudget : nearTopUp(usage.rawBudget, usage.left);
    if (amount <= 0) continue;

    const fundable = Math.max(0, Math.min(amount, options?.readyToAssign ?? amount));
    steps.push({ envelopeId: e.id, name: e.name, kind: bucket, amount, ignored: options?.ignored?.has(e.id) ?? false, fundable });
  }
  return steps.sort((a, b) => STEP_ORDER[a.kind] - STEP_ORDER[b.kind] || b.amount - a.amount);
}
