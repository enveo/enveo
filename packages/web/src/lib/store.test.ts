/**
 * Rollout regression of a newly replicated entity (budgets, 1.1.8):
 * an old replica blob in IDB has no `budgets` field — the store must normalize it
 * (otherwise the UI sees undefined → e.g. a dead currency select), and applyPulled must
 * not fall over spreading undefined when a `budgets` change arrives via pull.
 */
import { describe, expect, it } from "bun:test";
import type { ClientLedger } from "@enveo/shared";
import { type PullChange, store } from "./store";

/** A pre-1.1.8 replica — without the budgets field (what an old blob looks like after hydrate). */
const oldLedger = (): ClientLedger =>
  ({
    accounts: [],
    groups: [],
    envelopes: [],
    categories: [],
    places: [],
    transactions: [],
    allocations: [],
  }) as unknown as ClientLedger;

describe("an old replica without budgets (pre-1.1.8)", () => {
  it("replace normalizes missing budgets to []", () => {
    store.replace(oldLedger(), 0, "b1");
    expect(store.getLedger()!.budgets).toEqual([]);
  });

  it("applyPulled upserts a budgets row without falling over", () => {
    store.replace(oldLedger(), 0, "b1");
    const ch: PullChange[] = [{ seq: 1, table: "budgets", op: "upsert", row: { id: "b1", name: "Budżet", currency: "EUR" } }];
    expect(() => store.applyPulled(ch, 1)).not.toThrow();
    expect(store.getLedger()!.budgets[0]!.currency).toBe("EUR");
  });
});
