import { describe, expect, test } from "bun:test";
import { type DictionaryEntry, dictionaryEntries, duplicateGroups, normalizeDictionaryName, sortDictionary } from "./Dictionaries";

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

describe("duplicateGroups", () => {
  const e = (name: string, uses: number): DictionaryEntry => ({ id: name, name, archived: false, uses });

  test("collapses case, diacritics and punctuation onto one group", () => {
    const groups = duplicateGroups([e("Żabka", 3), e("ZABKA", 1), e("zabka.", 7), e("Lidl", 4)]);
    expect(groups.map((g) => g.map((x) => x.name))).toEqual([["zabka.", "Żabka", "ZABKA"]]);
  });

  test("the most-used variant leads the group — that is the name the merge keeps", () => {
    const [group] = duplicateGroups([e("kino", 2), e("Kino", 9)]);
    expect(group?.[0]?.name).toBe("Kino");
  });

  test("names that only look similar are NOT grouped — a wrong merge cannot be undone", () => {
    expect(duplicateGroups([e("Lidl", 1), e("Lidl Express", 1), e("Biedronka", 1)])).toEqual([]);
  });

  test("an entry alone in its group is not a suggestion", () => {
    expect(duplicateGroups([e("Auto", 0)])).toEqual([]);
  });

  test("normalising leaves nothing to key on for punctuation-only names, so they never group", () => {
    expect(normalizeDictionaryName("—")).toBe("");
    expect(duplicateGroups([e("—", 1), e("…", 1)])).toEqual([]);
  });
});
