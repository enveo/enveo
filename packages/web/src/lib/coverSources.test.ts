import { describe, expect, test } from "bun:test";
import { coverDonors, coverPlanStatus, POOL_SOURCE_ID, proposeCoverSources } from "./coverSources";

const env = (id: string, available: number, over: Partial<{ archived: boolean; isSavings: boolean; name: string }> = {}) => ({
  id,
  name: over.name ?? id,
  available,
  archived: over.archived ?? false,
  isSavings: over.isSavings ?? false,
});

describe("coverDonors", () => {
  test("keeps only unarchived envelopes with money left, never the target itself", () => {
    const donors = coverDonors([env("target", 500_00), env("a", 10_00), env("zero", 0), env("neg", -5_00), env("arch", 99_00, { archived: true })], "target");
    expect(donors.map((d) => d.id)).toEqual(["a"]);
  });

  test("orders by slack, largest first, with savings envelopes last regardless of slack", () => {
    const donors = coverDonors([env("small", 5_00), env("big", 50_00), env("savings", 999_00, { isSavings: true }), env("mid", 20_00)], "target");
    expect(donors.map((d) => d.id)).toEqual(["big", "mid", "small", "savings"]);
  });

  test("breaks slack ties by name", () => {
    const donors = coverDonors([env("b", 10_00, { name: "Zeta" }), env("a", 10_00, { name: "Alpha" })], "target");
    expect(donors.map((d) => d.id)).toEqual(["a", "b"]);
  });
});

describe("proposeCoverSources", () => {
  const donors = [env("big", 50_00), env("mid", 20_00), env("small", 5_00)];

  test("takes everything from the pool when it covers the amount", () => {
    expect(proposeCoverSources(30_00, 100_00, donors)).toEqual({ [POOL_SOURCE_ID]: 30_00 });
  });

  test("with an empty pool, drains donors greedily in order until the amount is met", () => {
    expect(proposeCoverSources(60_00, 0, donors)).toEqual({ big: 50_00, mid: 10_00 });
  });

  test("uses the pool first and tops the rest up from envelopes", () => {
    expect(proposeCoverSources(60_00, 25_00, donors)).toEqual({ [POOL_SOURCE_ID]: 25_00, big: 35_00 });
  });

  test("a negative pool counts as empty", () => {
    expect(proposeCoverSources(10_00, -40_00, donors)).toEqual({ big: 10_00 });
  });

  test("proposes only what exists when the sources cannot cover the amount", () => {
    expect(proposeCoverSources(500_00, 0, donors)).toEqual({ big: 50_00, mid: 20_00, small: 5_00 });
  });

  test("never proposes anything for a non-positive amount", () => {
    expect(proposeCoverSources(0, 100_00, donors)).toEqual({});
  });
});

describe("coverPlanStatus", () => {
  const sources = [
    { id: POOL_SOURCE_ID, available: 25_00 },
    { id: "big", available: 50_00 },
  ];

  test("sums the plan and reports it valid when every source stays within its slack", () => {
    const s = coverPlanStatus({ [POOL_SOURCE_ID]: 25_00, big: 10_00 }, sources);
    expect(s).toEqual({ sum: 35_00, overdrawn: [], valid: true });
  });

  test("flags a source asked for more than it has and invalidates the plan", () => {
    const s = coverPlanStatus({ [POOL_SOURCE_ID]: 30_00, big: 10_00 }, sources);
    expect(s.overdrawn).toEqual([POOL_SOURCE_ID]);
    expect(s.valid).toBe(false);
    expect(s.sum).toBe(40_00);
  });

  test("a negative entry is overdrawn too — a cover never pulls money the other way", () => {
    expect(coverPlanStatus({ big: -1 }, sources).overdrawn).toEqual(["big"]);
  });

  test("an empty plan is not valid", () => {
    expect(coverPlanStatus({}, sources)).toEqual({ sum: 0, overdrawn: [], valid: false });
  });

  test("ignores entries for sources that are no longer offered", () => {
    expect(coverPlanStatus({ gone: 10_00, big: 5_00 }, sources)).toEqual({ sum: 5_00, overdrawn: [], valid: true });
  });
});
