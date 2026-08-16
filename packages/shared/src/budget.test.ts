import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { budgetedPlusToBeBudgeted, computeBudgetState, nextMonth, prevMonth, totalOnBudget } from "./budget";
import { acc, alloc, env, grp, ledgerArb, MONTHS, tx } from "./ledger.test-support";
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
      transactions: [tx({ accountId: a.id, envelopeId: e.id, amount: 30_00 }), tx({ accountId: a.id, envelopeId: e.id, amount: 10_00, isRefund: true })],
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

  it("a transfer into one linked account adds to its envelope and removes the same amount from Ready to assign", () => {
    const g = grp();
    const source = acc({ initialBalance: 1_000_00 });
    const destination = acc({ initialBalance: 0 });
    const savings = env(g.id);
    const ledger: Ledger = {
      accounts: [source, destination],
      groups: [g],
      envelopes: [savings],
      allocations: [],
      transactions: [
        tx({
          type: "transfer",
          accountId: source.id,
          toAccountId: destination.id,
          amount: 500_00,
          allocationToEnvelopeId: savings.id,
        }),
      ],
    };

    const state = computeBudgetState(ledger, "2026-06");
    expect(state.envelopes[0]!.allocated).toBe(500_00);
    expect(state.envelopes[0]!.available).toBe(500_00);
    expect(state.toBeBudgeted).toBe(500_00);
    expect(state.readyToAssign).toBe(500_00);
    expect(totalOnBudget(state)).toBe(1_000_00);
  });

  it("a transfer out of one linked account releases its allocation to Ready to assign", () => {
    const g = grp();
    const source = acc({ initialBalance: 1_000_00 });
    const destination = acc({ initialBalance: 0 });
    const savings = env(g.id);
    const ledger: Ledger = {
      accounts: [source, destination],
      groups: [g],
      envelopes: [savings],
      allocations: [alloc(savings.id, "2026-05", 500_00)],
      transactions: [
        tx({
          type: "transfer",
          accountId: source.id,
          toAccountId: destination.id,
          amount: 200_00,
          allocationFromEnvelopeId: savings.id,
        }),
      ],
    };

    const state = computeBudgetState(ledger, "2026-06");
    expect(state.envelopes[0]!.allocated).toBe(-200_00);
    expect(state.envelopes[0]!.available).toBe(300_00);
    expect(state.toBeBudgeted).toBe(700_00);
    expect(state.readyToAssign).toBe(700_00);
  });

  it("income into a linked account increases its envelope without leaving money Ready to assign", () => {
    const g = grp();
    const account = acc({ initialBalance: 0 });
    const savings = env(g.id);
    const ledger: Ledger = {
      accounts: [account],
      groups: [g],
      envelopes: [savings],
      allocations: [],
      transactions: [tx({ type: "income", accountId: account.id, amount: 100_00, allocationToEnvelopeId: savings.id })],
    };

    const state = computeBudgetState(ledger, "2026-06");
    expect(state.accounts[0]!.balance).toBe(100_00);
    expect(state.envelopes[0]!.allocated).toBe(100_00);
    expect(state.envelopes[0]!.available).toBe(100_00);
    expect(state.toBeBudgeted).toBe(0);
    expect(state.readyToAssign).toBe(0);
    expect(state.monthIncome).toBe(100_00);
  });

  it("a transfer between different linked envelopes moves allocation without changing Ready to assign", () => {
    const g = grp();
    const source = acc({ initialBalance: 1_000_00 });
    const destination = acc({ initialBalance: 0 });
    const savings = env(g.id);
    const travel = env(g.id);
    const ledger: Ledger = {
      accounts: [source, destination],
      groups: [g],
      envelopes: [savings, travel],
      allocations: [alloc(savings.id, "2026-05", 500_00)],
      transactions: [
        tx({
          type: "transfer",
          accountId: source.id,
          toAccountId: destination.id,
          amount: 500_00,
          allocationFromEnvelopeId: savings.id,
          allocationToEnvelopeId: travel.id,
        }),
      ],
    };

    const state = computeBudgetState(ledger, "2026-06");
    expect(state.envelopes.map(({ allocated }) => allocated)).toEqual([-500_00, 500_00]);
    expect(state.envelopes.map(({ available }) => available)).toEqual([0, 500_00]);
    expect(state.toBeBudgeted).toBe(500_00);
    expect(state.readyToAssign).toBe(500_00);
  });

  it("amount edits change the recorded flow magnitude and deletion removes it", () => {
    const g = grp();
    const account = acc({ initialBalance: 0 });
    const savings = env(g.id);
    const transaction = tx({ type: "income", accountId: account.id, amount: 100_00, allocationToEnvelopeId: savings.id });
    const ledger: Ledger = {
      accounts: [account],
      groups: [g],
      envelopes: [savings],
      allocations: [],
      transactions: [transaction],
    };

    expect(computeBudgetState(ledger, "2026-06").envelopes[0]!.allocated).toBe(100_00);
    expect(computeBudgetState({ ...ledger, transactions: [{ ...transaction, amount: 175_00 }] }, "2026-06").envelopes[0]!.allocated).toBe(175_00);
    expect(computeBudgetState({ ...ledger, transactions: [] }, "2026-06").envelopes[0]!.allocated).toBe(0);
  });

  it("date edits move the flow to the new month while prior-month flow carries forward", () => {
    const g = grp();
    const source = acc({ initialBalance: 500_00 });
    const destination = acc({ initialBalance: 0 });
    const savings = env(g.id);
    const juneTransaction = tx({
      type: "transfer",
      accountId: source.id,
      toAccountId: destination.id,
      amount: 200_00,
      date: "2026-06-15",
      allocationFromEnvelopeId: savings.id,
    });
    const ledger: Ledger = {
      accounts: [source, destination],
      groups: [g],
      envelopes: [savings],
      allocations: [alloc(savings.id, "2026-05", 300_00)],
      transactions: [juneTransaction],
    };

    const julyWithCarry = computeBudgetState(ledger, "2026-07");
    expect(julyWithCarry.envelopes[0]!.carryIn).toBe(100_00);
    expect(julyWithCarry.envelopes[0]!.allocated).toBe(0);

    const movedLedger = { ...ledger, transactions: [{ ...juneTransaction, date: "2026-07-15" }] };
    expect(computeBudgetState(movedLedger, "2026-06").envelopes[0]!.available).toBe(300_00);
    const julyAfterMove = computeBudgetState(movedLedger, "2026-07");
    expect(julyAfterMove.envelopes[0]!.carryIn).toBe(300_00);
    expect(julyAfterMove.envelopes[0]!.allocated).toBe(-200_00);
    expect(julyAfterMove.envelopes[0]!.available).toBe(100_00);
  });

  it("adds the manual and automatic monthly components into the existing Added value", () => {
    const g = grp();
    const account = acc({ initialBalance: 1_000_00 });
    const savings = env(g.id);
    const ledger: Ledger = {
      accounts: [account],
      groups: [g],
      envelopes: [savings],
      allocations: [alloc(savings.id, "2026-06", 300_00)],
      transactions: [tx({ type: "income", accountId: account.id, amount: 500_00, allocationToEnvelopeId: savings.id })],
    };

    const state = computeBudgetState(ledger, "2026-06");
    expect(state.envelopes[0]!.allocated).toBe(800_00);
    expect(state.envelopes[0]!.available).toBe(800_00);
    expect(state.toBeBudgeted).toBe(700_00);
  });
});

describe("computeBudgetState — readyToAssign (month-independent)", () => {
  it("equals toBeBudgeted when there are no allocations/txns beyond the selected month", () => {
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
    expect(s.readyToAssign).toBe(s.toBeBudgeted);
  });

  it("assigning in a FUTURE month lowers readyToAssign for an earlier month, leaving that month's toBeBudgeted unchanged", () => {
    const g = grp();
    const a = acc({ initialBalance: 100_00 });
    const e = env(g.id);
    const ledger: Ledger = {
      accounts: [a],
      groups: [g],
      envelopes: [e],
      allocations: [alloc(e.id, "2026-08", 30_00)], // future relative to 2026-06
      transactions: [],
    };
    const june = computeBudgetState(ledger, "2026-06");
    expect(june.toBeBudgeted).toBe(100_00); // month-bounded figure ignores the future allocation
    expect(june.readyToAssign).toBe(70_00); // month-independent figure already accounts for it
  });

  it("a FUTURE automatic allocation lowers readyToAssign but not the selected month's toBeBudgeted", () => {
    const g = grp();
    const source = acc({ initialBalance: 1_000_00 });
    const destination = acc({ initialBalance: 0 });
    const savings = env(g.id);
    const ledger: Ledger = {
      accounts: [source, destination],
      groups: [g],
      envelopes: [savings],
      allocations: [],
      transactions: [
        tx({
          type: "transfer",
          accountId: source.id,
          toAccountId: destination.id,
          amount: 200_00,
          date: "2026-08-10",
          allocationToEnvelopeId: savings.id,
        }),
      ],
    };

    const june = computeBudgetState(ledger, "2026-06");
    expect(june.envelopes[0]!.allocated).toBe(0);
    expect(june.toBeBudgeted).toBe(1_000_00);
    expect(june.readyToAssign).toBe(800_00);
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
