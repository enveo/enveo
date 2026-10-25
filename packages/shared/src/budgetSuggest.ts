import type { AllocationPreset } from "./preferences";
import type { Money } from "./types";

/** The envelope figures of the viewed month the suggestions read — the state the Budget screen already has. */
export interface SuggestEnvelope {
  id: string;
  archived: boolean;
  allocated: Money;
  available: Money;
}

export interface SuggestItem {
  envelopeId: string;
  currentAllocated: Money;
  currentAvailable: Money;
  proposedDelta: Money;
}

export interface BudgetSuggestion {
  amountToDistribute: Money;
  items: SuggestItem[];
  /** Σ proposedDelta. */
  distributed: Money;
  /** What the proposal needs beyond `amountToDistribute` (only a preset can exceed it). */
  over: Money;
  /** What stays in "To be budgeted" after the proposal. */
  undistributed: Money;
  /** Preset entries whose envelope is missing or archived. */
  skipped: number;
}

function result(amountToDistribute: Money, items: SuggestItem[], skipped: number): BudgetSuggestion {
  const distributed = items.reduce((s, it) => s + it.proposedDelta, 0);
  return {
    amountToDistribute,
    items,
    distributed,
    over: Math.max(0, distributed - amountToDistribute),
    undistributed: Math.max(0, amountToDistribute - distributed),
    skipped,
  };
}

const item = (e: SuggestEnvelope, proposedDelta: Money): SuggestItem => ({
  envelopeId: e.id,
  currentAllocated: e.allocated,
  currentAvailable: e.available,
  proposedDelta,
});

/** Splits `amount` by weight; the leftover minor units go to the largest fractions (ties by id). */
function largestRemainderScale(entries: Array<[string, number]>, amount: number): Map<string, number> {
  const total = entries.reduce((x, [, w]) => x + w, 0);
  const out = new Map<string, number>();
  const fracs: Array<{ id: string; frac: number }> = [];
  let left = amount;
  for (const [id, w] of entries) {
    const raw = (amount * w) / total;
    const base = Math.floor(raw);
    out.set(id, base);
    left -= base;
    fracs.push({ id, frac: raw - base });
  }
  fracs.sort((a, b) => b.frac - a.frac || (a.id < b.id ? -1 : 1));
  for (const f of fracs) {
    if (left <= 0) break;
    out.set(f.id, out.get(f.id)! + 1);
    left -= 1;
  }
  return out;
}

/** Funds active envelopes in the red up to zero — proportionally to their deficits when `amount` is short. */
export function suggestTopUpNegatives(envelopes: SuggestEnvelope[], amount: Money): BudgetSuggestion {
  const pool = Math.max(0, amount);
  const negative = envelopes.filter((e) => !e.archived && e.available < 0);
  const deficit = negative.reduce((s, e) => s - e.available, 0);
  const scaled =
    deficit > pool
      ? largestRemainderScale(
          negative.map((e) => [e.id, -e.available]),
          pool,
        )
      : null;
  const items = negative.map((e) => item(e, scaled ? scaled.get(e.id)! : -e.available)).filter((it) => it.proposedDelta > 0);
  return result(pool, items, 0);
}

/**
 * The preset's amounts as deltas: "add" puts each on top of this month's allocation, "topUp" only
 * what is missing to reach it. NEVER scaled to the pool — the review shows the shortfall instead.
 */
export function suggestFromPreset(envelopes: SuggestEnvelope[], preset: AllocationPreset, amount: Money): BudgetSuggestion {
  const byId = new Map(envelopes.map((e) => [e.id, e]));
  const items: SuggestItem[] = [];
  let skipped = 0;
  for (const entry of preset.amounts) {
    const e = byId.get(entry.envelopeId);
    if (!e || e.archived) {
      skipped += 1;
      continue;
    }
    const delta = preset.mode === "add" ? entry.amount : Math.max(0, entry.amount - e.allocated);
    if (delta > 0) items.push(item(e, delta));
  }
  return result(Math.max(0, amount), items, skipped);
}
