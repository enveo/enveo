import { describe, expect, it } from "bun:test";
import { computeNetWorthSeries, computeSpendingByDimension } from "./reports";
import { computeBudgetState } from "./budget";
import { acc, alloc, asClientLedger, env, grp, ledgerArb, tx } from "./test-helpers";
import fc from "fast-check";
import type { Ledger } from "./types";
import { applyOp } from "./applyOp";
import type { SyncOp } from "./ops";

describe("computeNetWorthSeries", () => {
  it("sums ALL accounts (on + off budget) at each month's end", () => {
    const on = acc({ id: "ON", onBudget: true, initialBalance: 100_00 });
    const off = acc({ id: "OFF", onBudget: false, type: "savings", initialBalance: 900_00 });
    const g = grp();
    const e = env(g.id, { id: "E" });
    const l = asClientLedger({
      accounts: [on, off], groups: [g], envelopes: [e], allocations: [],
      transactions: [tx({ type: "expense", accountId: "ON", envelopeId: "E", amount: 40_00, date: "2026-06-10" })],
    });
    const series = computeNetWorthSeries(l, "2026-07", 12);
    expect(series.length).toBe(12);
    expect(series[series.length - 1]!.month).toBe("2026-07");
    // ON: 100−40=60; OFF: 900 → net worth 960 (both accounts, incl off-budget)
    expect(series[series.length - 1]!.total).toBe(960_00);
  });

  it("property: each point equals Σ of ALL account balances from computeBudgetState", () => {
    fc.assert(fc.property(ledgerArb(), (ledger: Ledger) => {
      const cl = asClientLedger(ledger);
      for (const p of computeNetWorthSeries(cl, "2026-07", 4)) {
        const expected = computeBudgetState(cl, p.month).accounts.reduce((s, a) => s + a.balance, 0);
        expect(p.total).toBe(expected);
      }
    }), { numRuns: 100 });
  });
});

describe("computeSpendingByDimension", () => {
  it("breaks down expenses by category, sorted desc, with share %", () => {
    const g = grp();
    const e = env(g.id, { id: "E" });
    const a = acc({ id: "A", onBudget: true });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [e], allocations: [],
      transactions: [
        tx({ type: "expense", accountId: "A", envelopeId: "E", categoryId: "C1", amount: 300_00, date: "2026-07-05" }),
        tx({ type: "expense", accountId: "A", envelopeId: "E", categoryId: "C2", amount: 100_00, date: "2026-07-06" }),
        tx({ type: "expense", accountId: "A", envelopeId: "E", categoryId: "C1", amount: 100_00, isRefund: true, date: "2026-07-07" }),
        tx({ type: "income", accountId: "A", amount: 999_00, date: "2026-07-08" }),
      ],
    });
    l.categories = [{ id: "C1", name: "Jedzenie" }, { id: "C2", name: "Auto" }];
    const rows = computeSpendingByDimension(l, "2026-07", "2026-07", "category");
    expect(rows.map((r) => [r.name, r.amount])).toEqual([["Jedzenie", 200_00], ["Auto", 100_00]]); // C1: 300−100 refund
    expect(rows[0]!.pct).toBeCloseTo(200_00 / 300_00, 5);
  });

  it("null keys get a labelled bucket; empty period → []", () => {
    const g = grp();
    const e = env(g.id, { id: "E" });
    const a = acc({ id: "A" });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [e], allocations: [],
      transactions: [tx({ type: "expense", accountId: "A", envelopeId: "E", categoryId: null, amount: 50_00, date: "2026-07-05" })],
    });
    expect(computeSpendingByDimension(l, "2026-07", "2026-07", "category")[0]!.name).toBe("Bez kategorii");
    expect(computeSpendingByDimension(l, "2026-01", "2026-01", "category")).toEqual([]);
  });
});

describe("isSavings field", () => {
  it("envelope.create/update carries isSavings; default false", () => {
    const g = grp();
    const base = asClientLedger({ accounts: [], groups: [g], envelopes: [], allocations: [], transactions: [] });
    const create: SyncOp = { opId: "o1", kind: "envelope.create", payload: { id: "S1", groupId: g.id, name: "Obligacje", isSavings: true } as never };
    const l1 = applyOp(base, create);
    expect(l1.envelopes[0]!.isSavings).toBe(true);
    const create2: SyncOp = { opId: "o2", kind: "envelope.create", payload: { id: "S2", groupId: g.id, name: "Jedzenie" } as never };
    expect(applyOp(l1, create2).envelopes[1]!.isSavings).toBe(false); // default
    const off: SyncOp = { opId: "o3", kind: "envelope.update", payload: { id: "S1", isSavings: false } as never };
    expect(applyOp(l1, off).envelopes[0]!.isSavings).toBe(false);
  });
});

import { computeCashflowSeries } from "./reports";

describe("computeCashflowSeries", () => {
  it("income − expense per month, all accounts, transfers excluded", () => {
    const g = grp();
    const e = env(g.id, { id: "E" });
    const a = acc({ id: "A" });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [e], allocations: [],
      transactions: [
        tx({ type: "income", accountId: "A", amount: 500_00, date: "2026-07-03" }),
        tx({ type: "expense", accountId: "A", envelopeId: "E", amount: 200_00, date: "2026-07-05" }),
        tx({ type: "expense", accountId: "A", envelopeId: "E", amount: 50_00, isRefund: true, date: "2026-07-06" }),
        tx({ type: "transfer", accountId: "A", toAccountId: "A", amount: 999_00, date: "2026-07-07" }),
      ],
    });
    const jul = computeCashflowSeries(l, "2026-07", 12).at(-1)!;
    expect(jul.income).toBe(500_00);
    expect(jul.expense).toBe(150_00); // 200 − 50 refund; transfer ignored
    expect(jul.net).toBe(350_00);
  });

  it("excludes expenses attributed to isSavings envelopes", () => {
    const g = grp();
    const eNorm = env(g.id, { id: "N" });
    const eSav = env(g.id, { id: "S", name: "Obligacje", isSavings: true });
    const a = acc({ id: "A" });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [eNorm, eSav], allocations: [],
      transactions: [
        tx({ type: "income", accountId: "A", amount: 1000_00, date: "2026-07-03" }),
        tx({ type: "expense", accountId: "A", envelopeId: "N", amount: 200_00, date: "2026-07-05" }),
        tx({ type: "expense", accountId: "A", envelopeId: "S", amount: 500_00, date: "2026-07-06" }), // net-worth envelope — skipped
      ],
    });
    const jul = computeCashflowSeries(l, "2026-07", 12).at(-1)!;
    expect(jul.expense).toBe(200_00); // the 500 net-worth spend excluded
    expect(jul.net).toBe(800_00); // 1000 − 200
  });
});

describe("computeSpendingByDimension savings exclusion", () => {
  it("excludes expenses attributed to isSavings envelopes", () => {
    const g = grp();
    const eNorm = env(g.id, { id: "N", name: "Jedzenie" });
    const eSav = env(g.id, { id: "S", name: "Obligacje", isSavings: true });
    const a = acc({ id: "A" });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [eNorm, eSav], allocations: [],
      transactions: [
        tx({ type: "expense", accountId: "A", envelopeId: "N", categoryId: "C1", amount: 100_00, date: "2026-07-05" }),
        tx({ type: "expense", accountId: "A", envelopeId: "S", categoryId: "C1", amount: 900_00, date: "2026-07-06" }),
      ],
    });
    l.categories = [{ id: "C1", name: "Zakupy" }];
    const rows = computeSpendingByDimension(l, "2026-07", "2026-07", "category");
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(100_00); // savings 900 excluded
    const byEnv = computeSpendingByDimension(l, "2026-07", "2026-07", "envelope");
    expect(byEnv.some((r) => r.name === "Obligacje")).toBe(false);
  });
});

import {
  computeDailySpending,
  computeEnvelopeTrends,
  largestExpenses,
  savingsRate,
  spendingBaseline,
  topPlaces,
  type CashflowPoint,
} from "./reports";

describe("computeDailySpending", () => {
  it("buckets expenses by date, nets refunds, excludes savings envelopes, ignores income/transfers, zero-fills every day", () => {
    const g = grp();
    const eNorm = env(g.id, { id: "N" });
    const eSav = env(g.id, { id: "S", isSavings: true });
    const a = acc({ id: "A" });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [eNorm, eSav], allocations: [],
      transactions: [
        tx({ type: "expense", accountId: "A", envelopeId: "N", amount: 100_00, date: "2026-07-05" }),
        tx({ type: "expense", accountId: "A", envelopeId: "N", amount: 30_00, isRefund: true, date: "2026-07-05" }),
        tx({ type: "expense", accountId: "A", envelopeId: "S", amount: 500_00, date: "2026-07-10" }), // savings — excluded
        tx({ type: "income", accountId: "A", amount: 999_00, date: "2026-07-15" }), // ignored
        tx({ type: "transfer", accountId: "A", toAccountId: "A", amount: 50_00, date: "2026-07-20" }), // ignored
      ],
    });
    const points = computeDailySpending(l, "2026-07");
    expect(points.length).toBe(31); // July has 31 days
    expect(points[0]!.date).toBe("2026-07-01");
    expect(points[30]!.date).toBe("2026-07-31");
    expect(points.find((p) => p.date === "2026-07-05")!.total).toBe(70_00); // 100 − 30 refund
    expect(points.find((p) => p.date === "2026-07-10")!.total).toBe(0); // savings envelope excluded
    expect(points.find((p) => p.date === "2026-07-15")!.total).toBe(0); // income ignored
    expect(points.find((p) => p.date === "2026-07-01")!.total).toBe(0); // zero-filled, no txns
  });

  it("returns the correct day count for 28/29 (leap)/30/31-day months", () => {
    const g = grp();
    const e = env(g.id, { id: "E" });
    const a = acc({ id: "A" });
    const l = asClientLedger({ accounts: [a], groups: [g], envelopes: [e], allocations: [], transactions: [] });
    expect(computeDailySpending(l, "2026-02").length).toBe(28); // 2026 — not a leap year
    expect(computeDailySpending(l, "2028-02").length).toBe(29); // 2028 — IS a leap year
    expect(computeDailySpending(l, "2026-04").length).toBe(30);
    expect(computeDailySpending(l, "2026-07").length).toBe(31);
  });
});

describe("topPlaces", () => {
  it("sorts by count desc, tie-break total desc; excludes refunds entirely; resolves names via ledger.places", () => {
    const g = grp();
    const e = env(g.id, { id: "E" });
    const a = acc({ id: "A" });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [e], allocations: [],
      transactions: [
        tx({ type: "expense", accountId: "A", envelopeId: "E", placeId: "P1", amount: 100_00, date: "2026-07-01" }),
        tx({ type: "expense", accountId: "A", envelopeId: "E", placeId: "P1", amount: 150_00, date: "2026-07-02" }), // P1: count 2, total 250
        tx({ type: "expense", accountId: "A", envelopeId: "E", placeId: "P2", amount: 120_00, date: "2026-07-03" }),
        tx({ type: "expense", accountId: "A", envelopeId: "E", placeId: "P2", amount: 180_00, date: "2026-07-04" }), // P2: count 2, total 300 — ties P1 on count, wins on total
        tx({ type: "expense", accountId: "A", envelopeId: "E", placeId: "P3", amount: 999_00, date: "2026-07-05" }), // P3: count 1
        tx({ type: "expense", accountId: "A", envelopeId: "E", placeId: "P4", amount: 500_00, isRefund: true, date: "2026-07-06" }), // refund-only — must not appear
        tx({ type: "expense", accountId: "A", envelopeId: "E", amount: 50_00, date: "2026-07-07" }), // no place — must not appear
      ],
    });
    l.places = [{ id: "P1", name: "Sklep A" }, { id: "P2", name: "Sklep B" }, { id: "P3", name: "Sklep C" }];
    const top = topPlaces(l, "2026-07", "2026-07");
    expect(top.map((p) => p.name)).toEqual(["Sklep B", "Sklep A", "Sklep C"]);
    expect(top[0]!.count).toBe(2);
    expect(top[0]!.total).toBe(300_00);
    expect(top.some((p) => p.key === "P4")).toBe(false);
  });

  it("respects the `limit` param (default 5)", () => {
    const g = grp();
    const e = env(g.id, { id: "E" });
    const a = acc({ id: "A" });
    const placeIds = ["P1", "P2", "P3", "P4", "P5", "P6"];
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [e], allocations: [],
      transactions: placeIds.map((pid, i) =>
        tx({ type: "expense", accountId: "A", envelopeId: "E", placeId: pid, amount: (i + 1) * 10_00, date: "2026-07-10" }),
      ),
    });
    l.places = placeIds.map((id) => ({ id, name: id }));
    expect(topPlaces(l, "2026-07", "2026-07").length).toBe(5);
    expect(topPlaces(l, "2026-07", "2026-07", 2).length).toBe(2);
  });
});

describe("largestExpenses", () => {
  it("sorts non-refund expenses by amount desc, within `month`, respecting `limit`", () => {
    const g = grp();
    const e = env(g.id, { id: "E" });
    const a = acc({ id: "A" });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [e], allocations: [],
      transactions: [
        tx({ type: "expense", accountId: "A", envelopeId: "E", amount: 100_00, date: "2026-07-01" }),
        tx({ type: "expense", accountId: "A", envelopeId: "E", amount: 300_00, date: "2026-07-02" }),
        tx({ type: "expense", accountId: "A", envelopeId: "E", amount: 900_00, isRefund: true, date: "2026-07-03" }), // excluded
        tx({ type: "expense", accountId: "A", envelopeId: "E", amount: 200_00, date: "2026-06-30" }), // outside month
      ],
    });
    const rows = largestExpenses(l, "2026-07");
    expect(rows.map((r) => r.amount)).toEqual([300_00, 100_00]);
  });

  it('label preference: place name > txn note > category name > envelope name > "—"', () => {
    const g = grp();
    const e = env(g.id, { id: "E", name: "Jedzenie" });
    const a = acc({ id: "A" });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [e], allocations: [],
      transactions: [
        tx({ id: "t1", type: "expense", accountId: "A", envelopeId: "E", categoryId: "C1", placeId: "P1", note: "Nota", amount: 10_00, date: "2026-07-01" }),
        tx({ id: "t2", type: "expense", accountId: "A", envelopeId: "E", categoryId: "C1", note: "Nota", amount: 20_00, date: "2026-07-02" }),
        tx({ id: "t3", type: "expense", accountId: "A", envelopeId: "E", categoryId: "C1", amount: 30_00, date: "2026-07-03" }),
        tx({ id: "t4", type: "expense", accountId: "A", envelopeId: "E", amount: 40_00, date: "2026-07-04" }),
        tx({ id: "t5", type: "expense", accountId: "A", amount: 50_00, date: "2026-07-05" }),
      ],
    });
    l.places = [{ id: "P1", name: "Sklep" }];
    l.categories = [{ id: "C1", name: "Jedzenie kat" }];
    const byId = Object.fromEntries(largestExpenses(l, "2026-07", 10).map((r) => [r.id, r.label]));
    expect(byId.t1).toBe("Sklep");
    expect(byId.t2).toBe("Nota");
    expect(byId.t3).toBe("Jedzenie kat");
    expect(byId.t4).toBe("Jedzenie");
    expect(byId.t5).toBe("—");
  });

  it("includes split transactions at their full amount", () => {
    const g = grp();
    const e1 = env(g.id, { id: "E1" });
    const e2 = env(g.id, { id: "E2" });
    const a = acc({ id: "A" });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [e1, e2], allocations: [],
      transactions: [
        tx({
          type: "expense", accountId: "A", amount: 150_00, date: "2026-07-01",
          items: [{ id: "i1", envelopeId: "E1", categoryId: null, amount: 100_00 }, { id: "i2", envelopeId: "E2", categoryId: null, amount: 50_00 }],
        }),
      ],
    });
    const rows = largestExpenses(l, "2026-07");
    expect(rows.length).toBe(1);
    expect(rows[0]!.amount).toBe(150_00);
  });
});

describe("spendingBaseline", () => {
  it("per-key median monthly spend over `months` months preceding `month`; missing month = 0; current month excluded", () => {
    const g = grp();
    const e = env(g.id, { id: "E" });
    const a = acc({ id: "A" });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [e], allocations: [],
      transactions: [
        tx({ type: "expense", accountId: "A", envelopeId: "E", categoryId: "C1", amount: 100_00, date: "2026-06-10" }),
        // 2026-05: no C1 txn → counts as 0
        tx({ type: "expense", accountId: "A", envelopeId: "E", categoryId: "C1", amount: 300_00, date: "2026-04-10" }),
        tx({ type: "expense", accountId: "A", envelopeId: "E", categoryId: "C1", amount: 900_00, date: "2026-07-10" }), // current month — excluded
      ],
    });
    l.categories = [{ id: "C1", name: "Jedzenie" }];
    const baseline = spendingBaseline(l, "2026-07", "category", 3);
    expect(baseline.get("C1")).toBe(100_00); // median([0(05), 100(06), 300(04)]) sorted [0,100,300] → middle = 100
  });

  it("respects a custom `months` window", () => {
    const g = grp();
    const e = env(g.id, { id: "E" });
    const a = acc({ id: "A" });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [e], allocations: [],
      transactions: [
        tx({ type: "expense", accountId: "A", envelopeId: "E", categoryId: "C1", amount: 100_00, date: "2026-06-10" }),
        tx({ type: "expense", accountId: "A", envelopeId: "E", categoryId: "C1", amount: 300_00, date: "2026-04-10" }), // outside a 2-month window
      ],
    });
    l.categories = [{ id: "C1", name: "Jedzenie" }];
    const baseline = spendingBaseline(l, "2026-07", "category", 2);
    expect(baseline.get("C1")).toBe(0); // median([100(06), 0(05)]) sorted [0,100] → lower-middle = 0
  });
});

describe("computeEnvelopeTrends", () => {
  it("aggregates split-txn items per envelope across the window; computes series/last/baseline/deltaPct", () => {
    const g = grp();
    const e1 = env(g.id, { id: "E1", name: "Jedzenie", color: "#111" });
    const a = acc({ id: "A" });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [e1], allocations: [],
      transactions: [
        tx({ type: "expense", accountId: "A", amount: 100_00, date: "2026-05-10", items: [{ id: "i1", envelopeId: "E1", categoryId: null, amount: 100_00 }] }),
        tx({ type: "expense", accountId: "A", amount: 300_00, date: "2026-06-10", items: [{ id: "i2", envelopeId: "E1", categoryId: null, amount: 300_00 }] }),
        tx({
          type: "expense", accountId: "A", amount: 60_00, date: "2026-07-05",
          items: [{ id: "i3", envelopeId: "E1", categoryId: null, amount: 40_00 }, { id: "i4", envelopeId: "E1", categoryId: null, amount: 20_00 }],
        }),
      ],
    });
    const trends = computeEnvelopeTrends(l, "2026-07", 3);
    expect(trends.length).toBe(1);
    const t1 = trends[0]!;
    expect(t1.id).toBe("E1");
    expect(t1.series).toEqual([100_00, 300_00, 60_00]); // May, June, July — oldest → newest
    expect(t1.last).toBe(60_00);
    expect(t1.baseline).toBe(100_00); // median([100(May), 300(Jun)]) sorted [100,300] → lower-middle = 100
    expect(t1.deltaPct).toBeCloseTo((60_00 - 100_00) / 100_00, 5);
  });

  it("drops envelopes with an all-zero series and archived envelopes", () => {
    const g = grp();
    const eUsed = env(g.id, { id: "USED" });
    const eUnused = env(g.id, { id: "UNUSED" });
    const eArchived = env(g.id, { id: "ARCH", archived: true });
    const a = acc({ id: "A" });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [eUsed, eUnused, eArchived], allocations: [],
      transactions: [
        tx({ type: "expense", accountId: "A", envelopeId: "USED", amount: 50_00, date: "2026-07-05" }),
        tx({ type: "expense", accountId: "A", envelopeId: "ARCH", amount: 999_00, date: "2026-07-05" }),
      ],
    });
    const trends = computeEnvelopeTrends(l, "2026-07", 3);
    expect(trends.map((t) => t.id)).toEqual(["USED"]);
  });

  it("excludes spending attributed to isSavings envelopes from their own trend (all-zero → dropped)", () => {
    const g = grp();
    const eSav = env(g.id, { id: "S", isSavings: true });
    const a = acc({ id: "A" });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [eSav], allocations: [],
      transactions: [tx({ type: "expense", accountId: "A", envelopeId: "S", amount: 500_00, date: "2026-07-05" })],
    });
    expect(computeEnvelopeTrends(l, "2026-07", 3)).toEqual([]);
  });

  it("deltaPct is null when baseline is 0 (no prior spend)", () => {
    const g = grp();
    const e = env(g.id, { id: "E" });
    const a = acc({ id: "A" });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [e], allocations: [],
      transactions: [tx({ type: "expense", accountId: "A", envelopeId: "E", amount: 100_00, date: "2026-07-05" })],
    });
    const t = computeEnvelopeTrends(l, "2026-07", 2)[0]!;
    expect(t.series).toEqual([0, 100_00]); // June empty, July has the txn
    expect(t.baseline).toBe(0);
    expect(t.deltaPct).toBeNull();
  });

  it("sorts by |last − baseline| desc", () => {
    const g = grp();
    const eBig = env(g.id, { id: "BIG" });
    const eSmall = env(g.id, { id: "SMALL" });
    const a = acc({ id: "A" });
    const l = asClientLedger({
      accounts: [a], groups: [g], envelopes: [eBig, eSmall], allocations: [],
      transactions: [
        tx({ type: "expense", accountId: "A", envelopeId: "BIG", amount: 100_00, date: "2026-06-10" }),
        tx({ type: "expense", accountId: "A", envelopeId: "BIG", amount: 900_00, date: "2026-07-10" }), // |900−100| = 800
        tx({ type: "expense", accountId: "A", envelopeId: "SMALL", amount: 100_00, date: "2026-06-10" }),
        tx({ type: "expense", accountId: "A", envelopeId: "SMALL", amount: 110_00, date: "2026-07-10" }), // |110−100| = 10
      ],
    });
    const trends = computeEnvelopeTrends(l, "2026-07", 2);
    expect(trends.map((t) => t.id)).toEqual(["BIG", "SMALL"]);
  });
});

describe("savingsRate", () => {
  it("current = last point's net/income; median = same ratio over the earlier points", () => {
    const points: CashflowPoint[] = [
      { month: "2026-04", income: 1000_00, expense: 800_00, net: 200_00 }, // ratio 0.2
      { month: "2026-05", income: 1000_00, expense: 900_00, net: 100_00 }, // ratio 0.1
      { month: "2026-06", income: 1000_00, expense: 700_00, net: 300_00 }, // ratio 0.3
      { month: "2026-07", income: 2000_00, expense: 1000_00, net: 1000_00 }, // current, ratio 0.5
    ];
    const { current, median } = savingsRate(points);
    expect(current).toBeCloseTo(0.5, 5);
    expect(median).toBeCloseTo(0.2, 5); // median([0.2, 0.1, 0.3]) sorted [0.1,0.2,0.3] → middle = 0.2
  });

  it("zero-income current month → current null; zero-income earlier month excluded from median (not treated as 0)", () => {
    const points: CashflowPoint[] = [
      { month: "2026-05", income: 0, expense: 0, net: 0 }, // excluded from median entirely
      { month: "2026-06", income: 1000_00, expense: 900_00, net: 100_00 }, // ratio 0.1
      { month: "2026-07", income: 0, expense: 0, net: 0 }, // current, income=0 → current null
    ];
    const { current, median } = savingsRate(points);
    expect(current).toBeNull();
    expect(median).toBeCloseTo(0.1, 5); // only the 0.1 ratio counted
  });

  it("empty series → both null", () => {
    expect(savingsRate([])).toEqual({ current: null, median: null });
  });
});
