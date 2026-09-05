/**
 * Balance reconciliation for the screenshot-import review — PURE arithmetic, no I/O.
 *
 * The user types the balance the bank shows. The difference to "balance after import" is money
 * the selection does not explain. This module searches the UNCERTAIN rows (rows the review already
 * flags, plus rows currently left out) for the smallest set of selection changes whose effects
 * sum exactly to that difference. Certain, selected rows are never touched: a wrong balance must
 * not silently rewrite the parts of the import the model read confidently.
 *
 * The search is exact and bounded (combinations of at most BALANCE_MATCH_MAX_CHANGES over at
 * most BALANCE_MATCH_MAX_CANDIDATES rows), so it is deterministic and instant in the browser.
 * When several minimal solutions exist, the caller may ask the model to choose between them
 * (`buildImportBalanceArbiterPrompt`) — the model only ever picks among sets this module found.
 */

export const BALANCE_MATCH_MAX_CANDIDATES = 40;
export const BALANCE_MATCH_MAX_CHANGES = 5;
export const BALANCE_MATCH_MAX_SOLUTIONS = 8;

export interface BalanceMatchCandidate {
  id: string;
  /** Signed effect on the account when the row IS included (minor units): spend negative, money in positive. */
  effect: number;
  included: boolean;
  /** The visible direction is uncertain, so the opposite sign is equally plausible. */
  flippable: boolean;
}

export type BalanceMatchAction = "include" | "exclude" | "flip";

export interface BalanceMatchChange {
  id: string;
  action: BalanceMatchAction;
  /** How the account balance after import moves when this change is applied. */
  delta: number;
}

/** Every way one candidate can move the balance, at most one of which a solution may pick. */
export function balanceMatchOptions(candidate: BalanceMatchCandidate): BalanceMatchChange[] {
  if (!Number.isInteger(candidate.effect) || candidate.effect === 0) return [];
  if (candidate.included) {
    const options: BalanceMatchChange[] = [{ id: candidate.id, action: "exclude", delta: -candidate.effect }];
    if (candidate.flippable) options.push({ id: candidate.id, action: "flip", delta: -2 * candidate.effect });
    return options;
  }
  const options: BalanceMatchChange[] = [{ id: candidate.id, action: "include", delta: candidate.effect }];
  if (candidate.flippable) options.push({ id: candidate.id, action: "flip", delta: -candidate.effect });
  return options;
}

/**
 * All minimal-size change sets whose deltas sum to `difference` (bank balance minus balance
 * after the current selection). Empty when the difference is zero, when no candidate can help,
 * or when nothing within the change bound explains it. Solutions are listed in candidate order.
 */
export function findBalanceMatches(
  candidates: ReadonlyArray<BalanceMatchCandidate>,
  difference: number,
  limits: { maxChanges?: number; maxSolutions?: number; maxCandidates?: number } = {},
): BalanceMatchChange[][] {
  const maxChanges = limits.maxChanges ?? BALANCE_MATCH_MAX_CHANGES;
  const maxSolutions = limits.maxSolutions ?? BALANCE_MATCH_MAX_SOLUTIONS;
  const maxCandidates = limits.maxCandidates ?? BALANCE_MATCH_MAX_CANDIDATES;
  if (!Number.isInteger(difference) || difference === 0) return [];
  const pool = candidates
    .slice(0, maxCandidates)
    .map(balanceMatchOptions)
    .filter((options) => options.length > 0);
  if (pool.length === 0) return [];

  for (let size = 1; size <= Math.min(maxChanges, pool.length); size += 1) {
    const solutions: BalanceMatchChange[][] = [];
    const chosen: BalanceMatchChange[] = [];
    const search = (from: number, remaining: number, sum: number): void => {
      if (solutions.length >= maxSolutions) return;
      if (remaining === 0) {
        if (sum === difference) solutions.push([...chosen]);
        return;
      }
      for (let index = from; index <= pool.length - remaining; index += 1) {
        for (const option of pool[index]!) {
          chosen.push(option);
          search(index + 1, remaining - 1, sum + option.delta);
          chosen.pop();
          if (solutions.length >= maxSolutions) return;
        }
      }
    };
    search(0, size, 0);
    if (solutions.length > 0) return solutions;
  }
  return [];
}

export interface BalanceMatchNearest {
  changes: BalanceMatchChange[];
  /** What the difference becomes after these changes (bank minus balance after); never zero here. */
  residual: number;
}

/**
 * When nothing explains the difference exactly, the change set that comes CLOSEST — smallest
 * remaining difference, then fewest changes — is still useful: applied, it leaves a residual small
 * enough to name (a single missing row, a fee) and to settle with a balance adjustment. Bounded
 * like the exact search but one change shallower, since every combination must be visited.
 */
export function findNearestBalanceMatch(
  candidates: ReadonlyArray<BalanceMatchCandidate>,
  difference: number,
  limits: { maxChanges?: number; maxCandidates?: number } = {},
): BalanceMatchNearest | null {
  const maxChanges = limits.maxChanges ?? BALANCE_MATCH_MAX_CHANGES - 1;
  const maxCandidates = limits.maxCandidates ?? BALANCE_MATCH_MAX_CANDIDATES;
  if (!Number.isInteger(difference) || difference === 0) return null;
  const pool = candidates
    .slice(0, maxCandidates)
    .map(balanceMatchOptions)
    .filter((options) => options.length > 0);
  if (pool.length === 0) return null;

  let best: BalanceMatchNearest | null = null;
  const chosen: BalanceMatchChange[] = [];
  const consider = (sum: number) => {
    const residual = difference - sum;
    if (
      best === null ||
      Math.abs(residual) < Math.abs(best.residual) ||
      (Math.abs(residual) === Math.abs(best.residual) && chosen.length < best.changes.length)
    ) {
      best = { changes: [...chosen], residual };
    }
  };
  const search = (from: number, sum: number): void => {
    if (chosen.length > 0) consider(sum);
    if (chosen.length >= maxChanges) return;
    for (let index = from; index < pool.length; index += 1) {
      for (const option of pool[index]!) {
        chosen.push(option);
        search(index + 1, sum + option.delta);
        chosen.pop();
      }
    }
  };
  search(0, 0);
  // An improvement over doing nothing is the only nearest fit worth showing.
  return best !== null && Math.abs((best as BalanceMatchNearest).residual) < Math.abs(difference) ? best : null;
}
