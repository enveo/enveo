import { describe, expect, test } from "bun:test";
import { goalProgress } from "./goals";

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
