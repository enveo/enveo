import { describe, expect, test } from "bun:test";
import type { ClientLedger, Envelope } from "@enveo/shared";
import { clampCoverPlan, coverDonors, coverPlanStatus, donorSlack, POOL_SOURCE_ID, proposeCoverSources } from "./coverSources";

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

  test("a replica row with NO isSavings key sorts as a plain envelope, never scrambling the order", () => {
    // Oldest client shape (CLAUDE.md pitfall): the key is absent, not false.
    const legacy = env("legacy", 10_00) as { id: string; name: string; available: number; archived: boolean; isSavings?: boolean };
    delete legacy.isSavings;
    const donors = coverDonors([env("savings", 50_00, { isSavings: true }), legacy, env("a", 20_00)], "target");
    expect(donors.map((d) => d.id)).toEqual(["a", "legacy", "savings"]);
  });

  test("returns the input objects themselves so callers keep their extra fields", () => {
    const rich = { ...env("a", 10_00), color: "#abc", icon: "cart" };
    expect(coverDonors([rich], "target")[0]).toBe(rich);
  });
});

describe("donorSlack", () => {
  const envelope = (id: string): Envelope => ({
    id,
    groupId: "g",
    name: id,
    color: "#000",
    icon: "wallet",
    note: null,
    monthlyTarget: null,
    isSavings: false,
    sort: 0,
    archived: false,
  });
  // Groceries: 50.00 allocated in July, then −45.00 in August (a negative allocation reads as
  // money taken back out) → July available 50.00, August 5.00, September 5.00.
  const ledger: ClientLedger = {
    accounts: [],
    groups: [{ id: "g", name: "g", sort: 0 }],
    envelopes: [envelope("groceries"), envelope("fun")],
    transactions: [],
    allocations: [
      { id: "a1", envelopeId: "groceries", month: "2026-07", amount: 50_00 },
      { id: "a2", envelopeId: "groceries", month: "2026-08", amount: -45_00 },
      { id: "a3", envelopeId: "fun", month: "2026-07", amount: 30_00 },
    ],
    budgets: [],
    categories: [],
    places: [],
  };

  test("for the current month the slack is that month's own available", () => {
    const slack = donorSlack(ledger, "2026-09", "2026-09");
    expect(slack.get("groceries")).toBe(5_00);
    expect(slack.get("fun")).toBe(30_00);
  });

  test("for a past month the slack is the minimum available from that month up to today", () => {
    const slack = donorSlack(ledger, "2026-07", "2026-09");
    expect(slack.get("groceries")).toBe(5_00); // July says 50.00, but August already consumed 45.00 of it
    expect(slack.get("fun")).toBe(30_00);
  });

  test("a future month looks only at itself", () => {
    expect(donorSlack(ledger, "2026-12", "2026-09").get("groceries")).toBe(5_00);
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
    expect(s.sum).toBe(35_00);
    expect(s.overdrawn.size).toBe(0);
    expect(s.valid).toBe(true);
  });

  test("flags a source asked for more than it has and invalidates the plan", () => {
    const s = coverPlanStatus({ [POOL_SOURCE_ID]: 30_00, big: 10_00 }, sources);
    expect([...s.overdrawn]).toEqual([POOL_SOURCE_ID]);
    expect(s.valid).toBe(false);
    expect(s.sum).toBe(40_00);
  });

  test("a negative entry is overdrawn too — a cover never pulls money the other way", () => {
    expect([...coverPlanStatus({ big: -1 }, sources).overdrawn]).toEqual(["big"]);
  });

  test("an empty plan is not valid", () => {
    const s = coverPlanStatus({}, sources);
    expect(s.sum).toBe(0);
    expect(s.valid).toBe(false);
  });

  test("ignores entries for sources that are no longer offered", () => {
    const s = coverPlanStatus({ gone: 10_00, big: 5_00 }, sources);
    expect(s.sum).toBe(5_00);
    expect(s.valid).toBe(true);
  });
});

describe("clampCoverPlan", () => {
  test("writes the plan verbatim when the live sources still cover it", () => {
    const r = clampCoverPlan({ [POOL_SOURCE_ID]: 20_00, big: 30_00 }, 50_00, [env("big", 50_00)]);
    expect(r).toEqual({ pool: 20_00, takes: [{ id: "big", take: 30_00 }], moved: 50_00 });
  });

  test("clamps each part to what exists NOW — a donor spent down since the plan was made gives only what it has left", () => {
    const r = clampCoverPlan({ [POOL_SOURCE_ID]: 20_00, big: 30_00 }, 5_00, [env("big", 12_00)]);
    expect(r).toEqual({ pool: 5_00, takes: [{ id: "big", take: 12_00 }], moved: 17_00 });
  });

  test("drops donors that are gone and treats a negative pool as empty", () => {
    const r = clampCoverPlan({ [POOL_SOURCE_ID]: 20_00, gone: 30_00 }, -10_00, []);
    expect(r).toEqual({ pool: 0, takes: [], moved: 0 });
  });
});
