/**
 * Pure part of the budget-scope guards (no DB): which body FKs get collected
 * for the ownership EXISTS checks. The DB behavior (foreign id → rejected op)
 * is covered by E2E.
 */
import { describe, expect, it } from "bun:test";
import { collectFkChecks } from "./apply";

describe("collectFkChecks", () => {
  it("collects only non-null ids with their tables", () => {
    expect(
      collectFkChecks({
        accountId: "A",
        toAccountId: null,
        envelopeId: "E",
        categoryId: undefined,
        recurrenceId: null,
      }),
    ).toEqual([
      { table: "accounts", id: "A" },
      { table: "envelopes", id: "E" },
    ]);
  });

  it("toAccountId checks the accounts table", () => {
    expect(collectFkChecks({ toAccountId: "B" })).toEqual([{ table: "accounts", id: "B" }]);
  });
});
