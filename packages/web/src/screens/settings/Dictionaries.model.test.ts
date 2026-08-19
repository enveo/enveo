import { describe, expect, test } from "bun:test";
import { type DictionaryEntry, dictionaryEntries, sortDictionary } from "./Dictionaries";

const cat = (id: string, name: string, archived = false) => ({ id, name, archived });
const txn = (over: Partial<{ categoryId: string | null; placeId: string | null; items: { categoryId: string | null }[] }> = {}) => ({
  categoryId: null,
  placeId: null,
  items: [],
  ...over,
});

describe("dictionaryEntries", () => {
  test("counts a category used only INSIDE a split — that is what makes 'delete' safe to offer", () => {
    const { categories } = dictionaryEntries({
      categories: [cat("C1", "Kawa"), cat("C2", "Auto")],
      places: [],
      transactions: [txn({ items: [{ categoryId: "C1" }, { categoryId: "C1" }] }), txn({ categoryId: "C2" })],
    });

    expect(categories.map((c) => [c.name, c.uses])).toEqual([
      ["Auto", 1],
      ["Kawa", 2],
    ]);
  });

  test("reports zero for an unused entry and keeps hidden ones in the list", () => {
    const { places } = dictionaryEntries({
      categories: [],
      places: [cat("P1", "Literowka", true), cat("P2", "Zabka")],
      transactions: [txn({ placeId: "P2" })],
    });

    expect(places).toEqual([
      { id: "P1", name: "Literowka", archived: true, uses: 0 },
      { id: "P2", name: "Zabka", archived: false, uses: 1 },
    ]);
  });
});

describe("sortDictionary", () => {
  const e = (name: string, uses: number): DictionaryEntry => ({ id: name, name, archived: false, uses });

  test("by uses ascending puts the prune candidates first, name breaking ties", () => {
    const rows = [e("Zabka", 5), e("Auto", 0), e("Kino", 2), e("Bar", 0)];
    expect(sortDictionary(rows, "uses", true).map((r) => r.name)).toEqual(["Auto", "Bar", "Kino", "Zabka"]);
  });

  test("by uses descending flips only the count, never the tie-break", () => {
    const rows = [e("Zabka", 5), e("Auto", 0), e("Kino", 2), e("Bar", 0)];
    expect(sortDictionary(rows, "uses", false).map((r) => r.name)).toEqual(["Zabka", "Kino", "Auto", "Bar"]);
  });

  test("by name ignores the direction toggle", () => {
    const rows = [e("Zabka", 5), e("Auto", 0)];
    expect(sortDictionary(rows, "name", false).map((r) => r.name)).toEqual(["Auto", "Zabka"]);
  });
});
