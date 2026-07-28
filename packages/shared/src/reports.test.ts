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
