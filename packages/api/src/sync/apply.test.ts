




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
