import { describe, expect, it } from "bun:test";
import { computeBudgetState } from "./budget";
import { computeEnvelopeSummary } from "./summary";
import { acc, alloc, deepFreeze, env, grp, tx } from "./ledger.test-support";
import type { ClientLedger } from "./types";

/**
 * Tests of the VERBATIM PORT from routes/state.ts — including quirks we do
 * NOT fix (the UI numbers must not change after moving to shared).
 */

function fixture(): ClientLedger {
  const g = grp({ id: "G1" });
  return {
    accounts: [acc({ id: "A-on", initialBalance: 100_00 }), acc({ id: "A-off", onBudget: false })],
    groups: [g],
    envelopes: [env("G1", { id: "E1" }), env("G1", { id: "E2" })],
    allocations: [alloc("E1", "2026-06", 50_00)],
    transactions: [],
    categories: [
      { id: "C1", name: "Jedzenie" },
      { id: "C2", name: "Chemia" },
    ],
    places: [],
  };
}

describe("computeEnvelopeSummary — 6-month series", () => {
  it("covers the selected month + 5 back, in ascending order", () => {
    const s = computeEnvelopeSummary(deepFreeze(fixture()), "E1", "2026-07");
    expect(s.series.map((p) => p.month)).toEqual(["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"]);
  });

  it("QUIRK: counts spending also from OFF-budget accounts (unlike computeBudgetState)", () => {
    const l = fixture();
    l.transactions = [tx({ accountId: "A-off", envelopeId: "E1", amount: 7_00, date: "2026-06-05" })];
    const s = computeEnvelopeSummary(l, "E1", "2026-06");
    expect(s.series.at(-1)!.spent).toBe(7_00); // the series counts it
    expect(computeBudgetState(l, "2026-06").envelopes[0]!.spent).toBe(0); // the budget does not
  });

  it("skips transfer; refund subtracts; income with an envelope subtracts; split per item", () => {
    const l = fixture();
    l.transactions = [
      tx({ accountId: "A-on", envelopeId: "E1", amount: 30_00, date: "2026-06-05" }),
      tx({ type: "transfer", accountId: "A-on", toAccountId: "A-off", envelopeId: "E1", amount: 50_00, date: "2026-06-07" }),
      tx({ accountId: "A-on", envelopeId: "E1", amount: 10_00, date: "2026-06-08", isRefund: true }),
      tx({ type: "income", accountId: "A-on", envelopeId: "E1", amount: 5_00, date: "2026-06-09" }),
      tx({
        accountId: "A-on",
        amount: 20_00,
        date: "2026-06-10",
        items: [
          { id: "i1", envelopeId: "E1", categoryId: null, amount: 12_00 },
          { id: "i2", envelopeId: "E2", categoryId: null, amount: 8_00 },
        ],
      }),
      tx({ accountId: "A-on", envelopeId: "E1", amount: 3_00, date: "2026-05-15" }), // different month
    ];
    const s = computeEnvelopeSummary(l, "E1", "2026-06");
    // 30 (expense) − 10 (refund) − 5 (income) + 12 (split item); transfer skipped
    expect(s.series.at(-1)!.spent).toBe(30_00 - 10_00 - 5_00 + 12_00);
    expect(s.series.at(-2)!.spent).toBe(3_00); // May
  });
});

describe("computeEnvelopeSummary — category breakdown (byCat)", () => {
  it("non-split counted only for type=expense", () => {
    const l = fixture();
    l.transactions = [
      tx({ accountId: "A-on", envelopeId: "E1", categoryId: "C1", amount: 30_00, date: "2026-06-05" }),
      // non-split income with an envelope — byCat SKIPS it (only type === "expense")
      tx({ type: "income", accountId: "A-on", envelopeId: "E1", categoryId: "C1", amount: 100_00, date: "2026-06-07" }),
    ];
    const s = computeEnvelopeSummary(l, "E1", "2026-06");
    expect(s.categories).toEqual([{ categoryId: "C1", name: "Jedzenie", amount: 30_00 }]);
  });

  it("QUIRK: splits counted for EVERY transaction type (even income)", () => {
    const l = fixture();
    l.transactions = [
      tx({
        type: "income", // hand-built quirk — normalization would not create this
        accountId: "A-on",
        amount: 25_00,
        date: "2026-06-05",
        items: [{ id: "i1", envelopeId: "E1", categoryId: "C2", amount: 25_00 }],
      }),
    ];
    const s = computeEnvelopeSummary(l, "E1", "2026-06");
    expect(s.categories).toEqual([{ categoryId: "C2", name: "Chemia", amount: 25_00 }]);
  });

  it("refund subtracts; name fallbacks: null → 'Bez kategorii', unknown id → 'Inne'; sorted by amount descending", () => {
    const l = fixture();
    l.transactions = [
      tx({ accountId: "A-on", envelopeId: "E1", categoryId: null, amount: 40_00, date: "2026-06-05" }),
      tx({ accountId: "A-on", envelopeId: "E1", categoryId: "C-ZNIKLA", amount: 15_00, date: "2026-06-06" }),
      tx({ accountId: "A-on", envelopeId: "E1", categoryId: "C1", amount: 20_00, date: "2026-06-07" }),
      tx({ accountId: "A-on", envelopeId: "E1", categoryId: "C1", amount: 5_00, date: "2026-06-08", isRefund: true }),
      // split item on a DIFFERENT envelope — does not count
      tx({
        accountId: "A-on",
        amount: 11_00,
        date: "2026-06-09",
        items: [{ id: "i1", envelopeId: "E2", categoryId: "C2", amount: 11_00 }],
      }),
    ];
    const s = computeEnvelopeSummary(l, "E1", "2026-06");
    expect(s.categories).toEqual([
      { categoryId: null, name: "Bez kategorii", amount: 40_00 },
      // equal amounts: stable sort ⇒ map insertion order (C-ZNIKLA before C1)
      { categoryId: "C-ZNIKLA", name: "Inne", amount: 15_00 },
      { categoryId: "C1", name: "Jedzenie", amount: 15_00 },
    ]);
  });
});

/**
 * Fixture for category windows: transactions in m (2026-06), m-1 and m-2
 * (various categories, split, refund, a deleted category and null) + distant
 * history for the 12-month window boundary test.
 */
function windowFixture(): ClientLedger {
  const g = grp({ id: "G1" });
  return {
    accounts: [acc({ id: "A-on", initialBalance: 10_000_00 })],
    groups: [g],
    envelopes: [env("G1", { id: "E1" }), env("G1", { id: "E2" })],
    allocations: [alloc("E1", "2026-05", 50_00), alloc("E1", "2026-06", 40_00)],
    transactions: [
      // m = 2026-06
      tx({ accountId: "A-on", envelopeId: "E1", categoryId: "C1", amount: 20_00, date: "2026-06-05" }),
      tx({
        accountId: "A-on",
        amount: 20_00,
        date: "2026-06-06",
        items: [
          { id: "i1", envelopeId: "E1", categoryId: "C2", amount: 12_00 },
          { id: "i2", envelopeId: "E2", categoryId: "C2", amount: 8_00 },
        ],
      }),
      tx({ accountId: "A-on", envelopeId: "E1", categoryId: "C1", amount: 5_00, date: "2026-06-07", isRefund: true }),
      // m-1 = 2026-05
      tx({ accountId: "A-on", envelopeId: "E1", categoryId: "C1", amount: 30_00, date: "2026-05-10" }),
      tx({ accountId: "A-on", envelopeId: "E1", categoryId: "C-ZNIKLA", amount: 4_00, date: "2026-05-11" }),
      // m-2 = 2026-04
      tx({ accountId: "A-on", envelopeId: "E1", categoryId: "C2", amount: 7_00, date: "2026-04-15" }),
      tx({ accountId: "A-on", envelopeId: "E1", categoryId: null, amount: 2_00, date: "2026-04-16" }),
      // m-11 = 2025-07 (still inside the 12 window) and m-12 = 2025-06 (already outside)
      tx({ accountId: "A-on", envelopeId: "E1", categoryId: "C1", amount: 100_00, date: "2025-07-20" }),
      tx({ accountId: "A-on", envelopeId: "E1", categoryId: "C1", amount: 999_00, date: "2025-06-20" }),
    ],
    budgets: [],
    categories: [
      { id: "C1", name: "Jedzenie" },
      { id: "C2", name: "Chemia" },
    ],
    places: [],
  };
}

describe("computeEnvelopeSummary — category windows (opts.categoryMonths)", () => {
  it("default (no opts) — categories cover ONLY the selected month, exactly as today", () => {
    const s = computeEnvelopeSummary(deepFreeze(windowFixture()), "E1", "2026-06");
    // 2026-06: C1 = 20 − 5 (refund), C2 = 12 (split item); nothing from May/April
    expect(s.categories).toEqual([
      { categoryId: "C1", name: "Jedzenie", amount: 15_00 },
      { categoryId: "C2", name: "Chemia", amount: 12_00 },
    ]);
    // explicit {categoryMonths: 1} = same as default
    expect(computeEnvelopeSummary(windowFixture(), "E1", "2026-06", { categoryMonths: 1 }).categories).toEqual(s.categories);
    expect(s.categoriesTotal).toBe(27_00);
  });

  it("{categoryMonths: 3} — amounts = sum over the [m−2 … m] window, categoriesTotal = sum of rows", () => {
    const s = computeEnvelopeSummary(deepFreeze(windowFixture()), "E1", "2026-06", { categoryMonths: 3 });
    expect(s.categories).toEqual([
      { categoryId: "C1", name: "Jedzenie", amount: 45_00 }, // 15 (Jun) + 30 (May)
      { categoryId: "C2", name: "Chemia", amount: 19_00 }, // 12 (Jun) + 7 (Apr)
      { categoryId: "C-ZNIKLA", name: "Inne", amount: 4_00 },
      { categoryId: null, name: "Bez kategorii", amount: 2_00 },
    ]);
    expect(s.categoriesTotal).toBe(70_00);
    // the 6-month series does NOT depend on the category window
    expect(s.series).toEqual(computeEnvelopeSummary(windowFixture(), "E1", "2026-06").series);
  });

  it("{categoryMonths: 12} — the [m−11 … m] window covers all 12 months but not the 13th", () => {
    const s = computeEnvelopeSummary(deepFreeze(windowFixture()), "E1", "2026-06", { categoryMonths: 12 });
    // C1: 45 (as in the 3m window) + 100 (2025-07); 999 from 2025-06 OUTSIDE the window
    expect(s.categories[0]).toEqual({ categoryId: "C1", name: "Jedzenie", amount: 145_00 });
    expect(s.categoriesTotal).toBe(145_00 + 19_00 + 4_00 + 2_00);
  });
});

describe("computeEnvelopeSummary — carryIn (Variant A)", () => {
  it("positive: previous month available carries over in full", () => {
    const l = fixture();
    l.allocations = [alloc("E1", "2026-05", 50_00)];
    l.transactions = [tx({ accountId: "A-on", envelopeId: "E1", amount: 30_00, date: "2026-05-10" })];
    const s = computeEnvelopeSummary(deepFreeze(l), "E1", "2026-06");
    expect(s.carryIn).toBe(20_00);
    expect(s.carryIn).toBe(computeBudgetState(l, "2026-05").envelopes[0]!.available);
  });

  it("negative: no floor at 0 — overspend carries as a negative carry-in", () => {
    const l = fixture();
    l.allocations = [alloc("E1", "2026-05", 10_00)];
    l.transactions = [tx({ accountId: "A-on", envelopeId: "E1", amount: 30_00, date: "2026-05-10" })];
    const s = computeEnvelopeSummary(deepFreeze(l), "E1", "2026-06");
    expect(s.carryIn).toBe(-20_00);
  });

  it("no history → 0; unknown envelope → 0", () => {
    const l = fixture();
    l.allocations = [];
    expect(computeEnvelopeSummary(deepFreeze(l), "E1", "2026-06").carryIn).toBe(0);
    expect(computeEnvelopeSummary(l, "MISSING", "2026-06").carryIn).toBe(0);
  });
});

describe("computeEnvelopeSummary — envelope state", () => {
  it("returns EnvelopeState from computeBudgetState or null for an unknown id", () => {
    const l = fixture();
    l.transactions = [tx({ accountId: "A-on", envelopeId: "E1", amount: 30_00, date: "2026-06-05" })];
    const s = computeEnvelopeSummary(l, "E1", "2026-06");
    expect(s.envelopeId).toBe("E1");
    expect(s.month).toBe("2026-06");
    expect(s.envelope).toEqual(computeBudgetState(l, "2026-06").envelopes[0]!);
    expect(s.envelope!.available).toBe(20_00);

    expect(computeEnvelopeSummary(l, "MISSING", "2026-06").envelope).toBeNull();
  });
});
