/**
 * Reports overview card summaries (reportSummary.ts).
 *
 * budgetsSummary: THRESHOLD cases (79.9 / 80 / 100 / 100.1 %) — parity
 * with the BudgetsReport thresholds. upcomingWindow: a 30-day window of planned
 * transactions (total + nearest), an empty ledger → total 0, nearest null.
 */
import { describe, expect, test } from "bun:test";
import type { ClientLedger, Transaction } from "@enveo/shared";
import { budgetsSummary, upcomingWindow } from "./reportSummary";

const envRow = (over: Partial<{ archived: boolean; allocated: number; carryIn: number; spent: number }> = {}) => ({
  archived: false,
  allocated: 0,
  carryIn: 0,
  spent: 0,
  ...over,
});

describe("budgetsSummary", () => {
  test("thresholds: 79.9% → ok, 80% → near, 100% → near, 100.1% → over", () => {
    const out = budgetsSummary([
      envRow({ allocated: 1000, spent: 799 }), // 79.9% → ok
      envRow({ allocated: 1000, spent: 800 }), // 80% → near
      envRow({ allocated: 1000, spent: 1000 }), // 100% → near (overspend only >100)
      envRow({ allocated: 1000, spent: 1001 }), // 100.1% → over
    ]);
    expect(out).toEqual({ over: 1, near: 2, ok: 1 });
  });

  test("budget = allocated + carryIn (carry-in counts)", () => {
    // 800/(500+500) = 80% → near; without carryIn it would be 160% → over
    expect(budgetsSummary([envRow({ allocated: 500, carryIn: 500, spent: 800 })])).toEqual({ over: 0, near: 1, ok: 0 });
  });

  test("filter as in BudgetsReport: no allocation and no spending → outside the counters; archived → outside", () => {
    const out = budgetsSummary([
      envRow(), // an empty envelope — skipped
      envRow({ allocated: 1000, spent: 2000, archived: true }), // archived — skipped
    ]);
    expect(out).toEqual({ over: 0, near: 0, ok: 0 });
  });

  test("spending without an allocation → the budget has a 1-minor-unit floor → over", () => {
    expect(budgetsSummary([envRow({ spent: 500 })])).toEqual({ over: 1, near: 0, ok: 0 });
  });

  test("negative spent counts as 0 → ok", () => {
    expect(budgetsSummary([envRow({ allocated: 1000, spent: -200 })])).toEqual({ over: 0, near: 0, ok: 1 });
  });
});

/* ── upcomingWindow ─────────────────────────────────────────────────── */

const TODAY = "2026-07-11";

const mkLedger = (transactions: Transaction[]): ClientLedger => ({
  accounts: [],
  envelopes: [],
  groups: [],
  allocations: [],
  transactions,
  budgets: [],
  categories: [],
  places: [],
  recurrences: [],
});

let seq = 0;
const tx = (over: Partial<Transaction>): Transaction => ({
  id: `t${++seq}`,
  type: "expense",
  accountId: "acc1",
  toAccountId: null,
  amount: 1000,
  date: TODAY,
  confirmed: false,
  isRefund: false,
  envelopeId: null,
  placeId: null,
  categoryId: null,
  name: null,
  note: null,
  tag: null,
  planned: true,
  recurrenceId: null,
  items: [],
  createdAt: "2026-07-01T00:00:00Z",
  ...over,
});

describe("upcomingWindow", () => {
  test("empty ledger → total 0, nearest null, payments []", () => {
    const out = upcomingWindow(mkLedger([]), TODAY);
    expect(out.total).toBe(0);
    expect(out.nearest).toBeNull();
    expect(out.payments).toEqual([]);
  });

  test("total and nearest from planned ones within the 30-day window; outside the window/unplanned skipped", () => {
    const out = upcomingWindow(
      mkLedger([
        tx({ date: "2026-07-20", amount: 4299, name: "Netflix" }),
        tx({ date: "2026-07-14", amount: 2500, name: "Spotify" }),
        tx({ date: "2026-09-01", amount: 9900, name: "Za oknem" }), // outside the 30 days
        tx({ date: "2026-07-15", amount: 777, name: "Historia", planned: false }), // unplanned
      ]),
      TODAY,
      30,
    );
    expect(out.total).toBe(4299 + 2500);
    expect(out.nearest).toEqual({ name: "Spotify", date: "2026-07-14" });
    expect(out.payments.map((p) => p.txn.date)).toEqual(["2026-07-14", "2026-07-20"]);
  });

  test("the days parameter narrows the window", () => {
    const out = upcomingWindow(
      mkLedger([
        tx({ date: "2026-07-12", amount: 100, name: "Blisko" }),
        tx({ date: "2026-07-25", amount: 200, name: "Daleko" }),
      ]),
      TODAY,
      7,
    );
    expect(out.total).toBe(100);
    expect(out.nearest).toEqual({ name: "Blisko", date: "2026-07-12" });
  });
});
