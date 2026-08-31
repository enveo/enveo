import { describe, expect, test } from "bun:test";
import type { EnvelopeView, StateResponse } from "@enveo/shared";
import { canFillGoals, goalProgress } from "./goals";

describe("goalProgress", () => {
  test("brak celu → null (null, 0, ujemny)", () => {
    expect(goalProgress({ monthlyTarget: null, allocated: 100000 })).toBeNull();
    expect(goalProgress({ monthlyTarget: 0, allocated: 100000 })).toBeNull();
    expect(goalProgress({ monthlyTarget: -5, allocated: 100000 })).toBeNull();
  });

  test("partial funding → proportional pct, funded false, missing = the remainder", () => {
    const gp = goalProgress({ monthlyTarget: 350000, allocated: 250000 });
    expect(gp).not.toBeNull();
    expect(gp!.pct).toBeCloseTo(71.43, 1);
    expect(gp!.funded).toBe(false);
    expect(gp!.missing).toBe(100000);
  });

  test("allocation equal to the goal → pct 100, funded true, missing 0", () => {
    const gp = goalProgress({ monthlyTarget: 200000, allocated: 200000 });
    expect(gp).toEqual({ pct: 100, funded: true, missing: 0 });
  });

  test("overfunding → pct 100 (clamp), funded true, missing 0", () => {
    const gp = goalProgress({ monthlyTarget: 200000, allocated: 300000 });
    expect(gp).toEqual({ pct: 100, funded: true, missing: 0 });
  });

  test("alokacja ujemna → pct 0, funded false, missing = target", () => {
    const gp = goalProgress({ monthlyTarget: 200000, allocated: -50000 });
    expect(gp).toEqual({ pct: 0, funded: false, missing: 200000 });
  });
});

/**
 * Owner round 8b item B — the ONE entry-visibility rule behind every "Fill by goals" button.
 *
 * The wide rail's pill and the fold strip's copy of it shipped with NO gate, so from either one
 * the sheet could open with nothing to assign and a disabled "Assign" — the same "it does
 * nothing" the owner reported for the Suggest/Fill pair. The rule had been written out by hand at
 * every older call site; these cases pin it now that they all call one function.
 */
const envelope = (over: Partial<EnvelopeView>): EnvelopeView => ({
  id: "e1",
  groupId: "g1",
  name: "Vacation",
  color: "#aed6ea",
  icon: "tag",
  note: null,
  monthlyTarget: null,
  isSavings: false,
  sort: 0,
  archived: false,
  carryIn: 0,
  allocated: 0,
  spent: 0,
  available: 0,
  ...over,
});

const budget = (readyToAssign: number, envelopes: EnvelopeView[]): StateResponse => ({
  month: "2026-08",
  toBeBudgeted: readyToAssign,
  readyToAssign,
  monthIncome: 0,
  monthExpense: 0,
  accounts: [],
  groups: [],
  envelopes,
  transactions: [],
  categories: [],
  places: [],
});

describe("canFillGoals", () => {
  const short = envelope({ monthlyTarget: 120000, allocated: 25000 });
  const funded = envelope({ id: "e2", monthlyTarget: 50000, allocated: 50000 });

  test("money to place AND a goal still short → the entry is live", () => {
    expect(canFillGoals(budget(80000, [short, funded]))).toBe(true);
  });

  test("no money to place → gated, however short the goals are", () => {
    expect(canFillGoals(budget(0, [short]))).toBe(false);
    expect(canFillGoals(budget(-4200, [short]))).toBe(false);
  });

  test("every goal already funded → gated, however large the pool", () => {
    expect(canFillGoals(budget(900000, [funded]))).toBe(false);
  });

  test("envelopes without a goal are not fillable — a pool alone is not enough", () => {
    expect(canFillGoals(budget(900000, [envelope({ monthlyTarget: null, allocated: 0 })]))).toBe(false);
  });

  test("an ARCHIVED envelope's shortfall does not count — the sheet cannot assign to it", () => {
    expect(canFillGoals(budget(900000, [envelope({ monthlyTarget: 120000, allocated: 0, archived: true })]))).toBe(false);
    // …and it does not mask a live one either.
    expect(canFillGoals(budget(900000, [envelope({ monthlyTarget: 120000, allocated: 0, archived: true }), short]))).toBe(true);
  });

  test("a budget with no envelopes at all → gated", () => {
    expect(canFillGoals(budget(900000, []))).toBe(false);
  });
});
