import { describe, expect, test } from "bun:test";
import { fillByGoals, goalProgress } from "./goals";

describe("goalProgress", () => {
  test("no target → null (null, 0, negative)", () => {
    expect(goalProgress({ monthlyTarget: null, allocated: 100000 })).toBeNull();
    expect(goalProgress({ monthlyTarget: 0, allocated: 100000 })).toBeNull();
    expect(goalProgress({ monthlyTarget: -5, allocated: 100000 })).toBeNull();
  });

  test("partial funding → proportional pct, funded false, missing = remainder", () => {
    const gp = goalProgress({ monthlyTarget: 350000, allocated: 250000 });
    expect(gp).not.toBeNull();
    expect(gp!.pct).toBeCloseTo(71.43, 1);
    expect(gp!.funded).toBe(false);
    expect(gp!.missing).toBe(100000);
  });

  test("allocation equal to the target → pct 100, funded true, missing 0", () => {
    const gp = goalProgress({ monthlyTarget: 200000, allocated: 200000 });
    expect(gp).toEqual({ pct: 100, funded: true, missing: 0 });
  });

  test("overpayment → pct 100 (clamp), funded true, missing 0", () => {
    const gp = goalProgress({ monthlyTarget: 200000, allocated: 300000 });
    expect(gp).toEqual({ pct: 100, funded: true, missing: 0 });
  });

  test("negative allocation → pct 0, funded false, missing = target", () => {
    const gp = goalProgress({ monthlyTarget: 200000, allocated: -50000 });
    expect(gp).toEqual({ pct: 0, funded: false, missing: 200000 });
  });
});

describe("fillByGoals", () => {
  const env = (id: string, sort: number, allocated: number, target: number | null, archived = false) => ({
    id,
    sort,
    allocated,
    monthlyTarget: target,
    archived,
  });

  test("order priority, exact exhaustion: pool 800 fills A(500 missing) then B(300 missing)", () => {
    expect(fillByGoals([env("a", 0, 0, 500), env("b", 1, 0, 300)], 800)).toEqual([
      { envelopeId: "a", add: 500 },
      { envelopeId: "b", add: 300 },
    ]);
  });

  test("full-or-skip: pool 400 skips A(500 missing), fills B(300), leaves 100", () => {
    expect(fillByGoals([env("a", 0, 0, 500), env("b", 1, 0, 300)], 400)).toEqual([
      { envelopeId: "b", add: 300 },
    ]);
  });

  test("funded and overfilled skipped: A allocated 500/500, B 700/500 → only C fills", () => {
    expect(
      fillByGoals([env("a", 0, 500, 500), env("b", 1, 700, 500), env("c", 2, 0, 200)], 1000),
    ).toEqual([{ envelopeId: "c", add: 200 }]);
  });

  test("negative allocation = full target missing", () => {
    expect(fillByGoals([env("a", 0, -100, 300)], 300)).toEqual([{ envelopeId: "a", add: 300 }]);
  });

  test("fallback single partial: nothing fits fully → FIRST unfunded gets the whole pool", () => {
    expect(fillByGoals([env("a", 0, 0, 500), env("b", 1, 0, 400)], 200)).toEqual([
      { envelopeId: "a", add: 200 },
    ]);
  });

  test("pool ≤ 0 → empty", () => {
    expect(fillByGoals([env("a", 0, 0, 500)], 0)).toEqual([]);
  });

  test("no goals → empty", () => {
    expect(fillByGoals([env("a", 0, 0, null)], 900)).toEqual([]);
  });

  test("archived ignored", () => {
    expect(fillByGoals([env("a", 0, 0, 500, true)], 900)).toEqual([]);
  });

  test("sort order respected regardless of array order", () => {
    expect(fillByGoals([env("b", 5, 0, 300), env("a", 1, 0, 500)], 500)).toEqual([
      { envelopeId: "a", add: 500 },
    ]);
  });
});
