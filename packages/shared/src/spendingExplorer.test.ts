import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { acc, asClientLedger, env, grp, ledgerArb, tx } from "./ledger.test-support";
import { computeSpendingByDimension } from "./reports";
import {
  breakdownEntries,
  defaultGrouping,
  type ExploreFilter,
  filterEntries,
  monthlyTotals,
  skipSingleRows,
  spendingEntries,
  statementLines,
  sumEntries,
} from "./spendingExplorer";
import type { Ledger } from "./types";

const all: ExploreFilter = { from: "2000-01-01", to: "2999-12-31", account: null, path: [] };

function fixture() {
  const a = acc({ id: "A" });
  const b = acc({ id: "B" });
  const g = grp({ id: "G" });
  const home = env("G", { id: "HOME" });
  const food = env("G", { id: "FOOD" });
  const save = env("G", { id: "SAVE", isSavings: true });
  return asClientLedger({
    accounts: [a, b],
    groups: [g],
    envelopes: [home, food, save],
    allocations: [],
    transactions: [
      tx({ id: "rent1", accountId: "A", envelopeId: "HOME", categoryId: "RENT", placeId: "LANDLORD", amount: 900_00, date: "2026-01-05" }),
      tx({ id: "rent2", accountId: "A", envelopeId: "HOME", categoryId: "RENT", placeId: "LANDLORD", amount: 900_00, date: "2026-02-05" }),
      tx({ id: "rent3", accountId: "A", envelopeId: "HOME", categoryId: "RENT", placeId: "LANDLORD", amount: 900_00, date: "2026-03-05" }),
      tx({ id: "lamp", accountId: "B", envelopeId: "HOME", categoryId: "DECOR", placeId: "SHOP", amount: 120_00, date: "2026-02-11" }),
      tx({ id: "refund", accountId: "B", envelopeId: "HOME", categoryId: "DECOR", placeId: "SHOP", amount: 20_00, isRefund: true, date: "2026-02-12" }),
      tx({
        id: "split",
        accountId: "B",
        placeId: "MARKET",
        amount: 80_00,
        date: "2026-03-02",
        items: [
          { id: "i1", envelopeId: "FOOD", categoryId: "GROCERIES", amount: 50_00 },
          { id: "i2", envelopeId: "HOME", categoryId: "DECOR", amount: 20_00 },
          { id: "i3", envelopeId: "SAVE", categoryId: null, amount: 10_00 },
        ],
      }),
      tx({ id: "in", type: "income", accountId: "A", amount: 5000_00, date: "2026-03-01" }),
      tx({ id: "xfer", type: "transfer", accountId: "A", toAccountId: "B", amount: 100_00, date: "2026-03-01" }),
    ],
  });
}

describe("spendingEntries", () => {
  it("keeps expenses only, signs refunds, splits items and drops savings items", () => {
    const e = spendingEntries(fixture());
    expect(e.map((x) => x.id).sort()).toEqual(["lamp", "refund", "rent1", "rent2", "rent3", "split:i1", "split:i2"]);
    expect(e.find((x) => x.id === "refund")!.amount).toBe(-20_00);
    expect(e.find((x) => x.id === "split:i2")).toMatchObject({ envelope: "HOME", category: "DECOR", place: "MARKET", account: "B", group: "G" });
  });

  it("property: per-envelope totals equal computeSpendingByDimension", () => {
    fc.assert(
      fc.property(ledgerArb(), (ledger: Ledger) => {
        const cl = asClientLedger(ledger);
        const f = { ...all, from: "2026-07-01", to: "2026-07-31" };
        const rows = breakdownEntries(filterEntries(spendingEntries(cl), f), "envelope");
        const expected = computeSpendingByDimension(cl, "2026-07", "2026-07", "envelope");
        expect(rows.map((r) => [r.key, r.amount]).sort()).toEqual(expected.map((r) => [r.key, r.amount]).sort());
      }),
      { numRuns: 100 },
    );
  });
});

describe("filter, breakdown and drill", () => {
  const entries = spendingEntries(fixture());

  it("filters by inclusive dates, account and path", () => {
    const f: ExploreFilter = { from: "2026-02-01", to: "2026-03-02", account: "B", path: [{ dim: "envelope", key: "HOME" }] };
    expect(
      filterEntries(entries, f)
        .map((e) => e.id)
        .sort(),
    ).toEqual(["lamp", "refund", "split:i2"]);
  });

  it("breaks down largest first and nets refunds", () => {
    const rows = breakdownEntries(filterEntries(entries, { ...all, path: [{ dim: "envelope", key: "HOME" }] }), "category");
    expect(rows.map((r) => [r.key, r.amount])).toEqual([
      ["RENT", 2700_00],
      ["DECOR", 120_00],
    ]);
    expect(rows[1]!.entries.map((e) => e.id)).toEqual(["lamp", "split:i2", "refund"]);
  });

  it("groups by month newest first", () => {
    expect(breakdownEntries(entries, "month").map((r) => r.key)).toEqual(["2026-03", "2026-02", "2026-01"]);
  });

  it("opens each level with the natural next dimension and skips used ones", () => {
    expect(defaultGrouping(all, true)).toBe("envelope");
    expect(defaultGrouping({ ...all, path: [{ dim: "envelope", key: "HOME" }] }, true)).toBe("category");
    expect(defaultGrouping({ ...all, path: [{ dim: "category", key: "RENT" }] }, true)).toBe("place");
    expect(defaultGrouping({ ...all, path: [{ dim: "place", key: "SHOP" }] }, true)).toBe("txn");
    expect(
      defaultGrouping(
        {
          ...all,
          path: [
            { dim: "place", key: "SHOP" },
            { dim: "category", key: "DECOR" },
          ],
        },
        true,
      ),
    ).toBe("envelope");
  });

  it("skips levels that would list a single row", () => {
    const f = skipSingleRows(
      entries,
      {
        ...all,
        path: [
          { dim: "envelope", key: "HOME" },
          { dim: "category", key: "RENT" },
        ],
      },
      true,
    );
    expect(f.path).toEqual([
      { dim: "envelope", key: "HOME" },
      { dim: "category", key: "RENT" },
      { dim: "place", key: "LANDLORD" },
    ]);
  });

  it("folds three or more identical payments at one place into one line", () => {
    const lines = statementLines(filterEntries(entries, { ...all, path: [{ dim: "envelope", key: "HOME" }] }));
    expect(lines[0]).toMatchObject({ count: 3, amount: 2700_00 });
    expect(lines.slice(1).map((l) => l.entry.id)).toEqual(["lamp", "split:i2", "refund"]);
  });

  it("totals every month the range touches", () => {
    expect(monthlyTotals(entries, "2025-12-15", "2026-02-01")).toEqual([
      { month: "2025-12", amount: 0 },
      { month: "2026-01", amount: 900_00 },
      { month: "2026-02", amount: 1000_00 },
    ]);
    expect(sumEntries(entries)).toBe(2700_00 + 100_00 + 70_00);
  });
});
