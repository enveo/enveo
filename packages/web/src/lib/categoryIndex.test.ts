import { describe, expect, test } from "bun:test";
import type { ClientLedger } from "@enveo/shared";
import { categoryCountsFor, rankCategories } from "./categoryIndex";

const L = (txns: Array<Partial<ClientLedger["transactions"][number]>>): ClientLedger =>
  ({
    accounts: [],
    groups: [],
    envelopes: [],
    categories: [],
    places: [],
    allocations: [],
    transactions: txns as ClientLedger["transactions"],
  }) as unknown as ClientLedger;

describe("envelope→categories index", () => {
  test("counts co-occurrences (also from splits) and sorts descending, ties alphabetically", () => {
    const ledger = L([
      { envelopeId: "E1", categoryId: "Cspoz" },
      { envelopeId: "E1", categoryId: "Cspoz" },
      { envelopeId: "E1", categoryId: "Crest" },
      { envelopeId: "E2", categoryId: "Cauto" },
      { envelopeId: null, categoryId: "Cspoz", items: [{ envelopeId: "E1", amount: 1 }] } as never,
    ]);
    const counts = categoryCountsFor(ledger, 1, "E1");
    expect(counts.get("Cspoz")).toBe(3);
    expect(counts.get("Crest")).toBe(1);
    const cats = [
      { id: "Cauto", name: "Auto" },
      { id: "Crest", name: "Restauracje" },
      { id: "Cspoz", name: "Spożywcze" },
      { id: "Cinne", name: "Bnne" },
    ];
    expect(rankCategories(cats, counts).map((c) => c.id)).toEqual(["Cspoz", "Crest", "Cauto", "Cinne"]);
  });
  test("memo: the same version does not rebuild (result identity), a new version does", () => {
    const ledger = L([{ envelopeId: "E1", categoryId: "C1" }]);
    const a = categoryCountsFor(ledger, 7, "E1");
    const b = categoryCountsFor(ledger, 7, "E1");
    expect(a).toBe(b); // the same object from the cache
    const c = categoryCountsFor(ledger, 8, "E1");
    expect(c).not.toBe(a);
  });
  test("no envelope / no history → an empty map, ranking = alphabetical", () => {
    const ledger = L([]);
    expect(categoryCountsFor(ledger, 2, null).size).toBe(0);
    expect(
      rankCategories(
        [
          { id: "b", name: "B" },
          { id: "a", name: "A" },
        ],
        new Map(),
      ).map((x) => x.id),
    ).toEqual(["a", "b"]);
  });
});
