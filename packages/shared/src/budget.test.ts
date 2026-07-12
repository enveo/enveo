import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  budgetedPlusToBeBudgeted,
  computeBudgetState,
  nextMonth,
  prevMonth,
  totalOnBudget,
} from "./budget";
import { acc, alloc, env, grp, ledgerArb, MONTHS, tx } from "./test-helpers";
import type { Ledger } from "./types";

/* ── Unit tests on concrete scenarios ───────────────────────────────── */

describe("computeBudgetState — scenarios", () => {
  it("an expense lowers the account balance and envelope available", () => {
    const g = grp();
    const a = acc({ initialBalance: 100_00 });
    const e = env(g.id);
    const ledger: Ledger = {
      accounts: [a],
      groups: [g],
      envelopes: [e],
      allocations: [alloc(e.id, "2026-06", 50_00)],
      transactions: [tx({ accountId: a.id, envelopeId: e.id, amount: 30_00 })],
    };
    const s = computeBudgetState(ledger, "2026-06");
    expect(s.accounts[0]!.balance).toBe(70_00);
    expect(s.envelopes[0]!.allocated).toBe(50_00);
    expect(s.envelopes[0]!.spent).toBe(30_00);
    expect(s.envelopes[0]!.available).toBe(20_00);
    expect(s.toBeBudgeted).toBe(100_00 - 50_00);
  });

  it("a refund raises the balance and available", () => {
    const g = grp();
    const a = acc({ initialBalance: 100_00 });
    const e = env(g.id);
    const ledger: Ledger = {
      accounts: [a],
      groups: [g],
      envelopes: [e],
      allocations: [alloc(e.id, "2026-06", 50_00)],
      transactions: [
        tx({ accountId: a.id, envelopeId: e.id, amount: 30_00 }),
        tx({ accountId: a.id, envelopeId: e.id, amount: 10_00, isRefund: true }),
      ],
    };
    const s = computeBudgetState(ledger, "2026-06");
    expect(s.accounts[0]!.balance).toBe(80_00);
    expect(s.envelopes[0]!.available).toBe(30_00);
  });

  it("income without an envelope increases To be budgeted", () => {
    const g = grp();
    const a = acc({ initialBalance: 0 });
    const e = env(g.id);
    const ledger: Ledger = {
      accounts: [a],
      groups: [g],
      envelopes: [e],
      allocations: [],
      transactions: [tx({ type: "income", accountId: a.id, amount: 200_00 })],
    };
    const s = computeBudgetState(ledger, "2026-06");
    expect(s.accounts[0]!.balance).toBe(200_00);
    expect(s.toBeBudgeted).toBe(200_00);
    expect(s.envelopes[0]!.available).toBe(0);
  });

  it("a transfer between on-budget accounts does not touch the budget", () => {
    const g = grp();
    const a1 = acc({ initialBalance: 100_00 });
    const a2 = acc({ initialBalance: 0 });
    const ledger: Ledger = {
      accounts: [a1, a2],
      groups: [g],
      envelopes: [env(g.id)],
      allocations: [],
      transactions: [tx({ type: "transfer", accountId: a1.id, toAccountId: a2.id, amount: 40_00 })],
    };
    const s = computeBudgetState(ledger, "2026-06");
    expect(s.accounts[0]!.balance).toBe(60_00);
    expect(s.accounts[1]!.balance).toBe(40_00);
    expect(s.toBeBudgeted).toBe(100_00); // unchanged
  });

  it("carry-over Variant A: negative available carries into the next month", () => {
    const g = grp();
    const a = acc({ initialBalance: 100_00 });
    const e = env(g.id);
    const ledger: Ledger = {
      accounts: [a],
      groups: [g],
      envelopes: [e],
      allocations: [alloc(e.id, "2026-06", 50_00)],
      transactions: [tx({ accountId: a.id, envelopeId: e.id, amount: 80_00, date: "2026-06-15" })],
    };
    const june = computeBudgetState(ledger, "2026-06");
    expect(june.envelopes[0]!.available).toBe(-30_00); // overspend
    const july = computeBudgetState(ledger, "2026-07");
    expect(july.envelopes[0]!.carryIn).toBe(-30_00); // negative carry-in
    expect(july.envelopes[0]!.available).toBe(-30_00); // no new allocation
  });

  it("split: items sum to the amount and charge the right envelopes", () => {
    const g = grp();
    const a = acc({ initialBalance: 100_00 });
    const e1 = env(g.id);
    const e2 = env(g.id);
    const ledger: Ledger = {
      accounts: [a],
      groups: [g],
      envelopes: [e1, e2],
      allocations: [alloc(e1.id, "2026-06", 40_00), alloc(e2.id, "2026-06", 40_00)],
      transactions: [
        tx({
          accountId: a.id,
          amount: 50_00,
          envelopeId: null,
          items: [
            { id: "i1", envelopeId: e1.id, categoryId: null, amount: 30_00 },
            { id: "i2", envelopeId: e2.id, categoryId: null, amount: 20_00 },
          ],
        }),
      ],
    };
    const s = computeBudgetState(ledger, "2026-06");
    expect(s.accounts[0]!.balance).toBe(50_00);
    expect(s.envelopes[0]!.spent).toBe(30_00);
    expect(s.envelopes[1]!.spent).toBe(20_00);
  });
});

describe("month helpers", () => {
  it("nextMonth/prevMonth cross year boundaries", () => {
    expect(nextMonth("2026-12")).toBe("2027-01");
    expect(prevMonth("2026-01")).toBe("2025-12");
    expect(nextMonth("2026-06")).toBe("2026-07");
  });
});

/* ── Property test: INVARIANT §2.3 ──────────────────────────────────── */

describe("invariant §2.3 (property-based)", () => {
  it("Σ available + toBeBudgeted = Σ on-budget account balances, for any ledger", () => {
    fc.assert(
      fc.property(ledgerArb(), fc.constantFrom(...MONTHS), (ledger, month) => {
        const s = computeBudgetState(ledger, month);
        expect(budgetedPlusToBeBudgeted(s)).toBe(totalOnBudget(s));
      }),
      { numRuns: 500 },
    );
  });
});
