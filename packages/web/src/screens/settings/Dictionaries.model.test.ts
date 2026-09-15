import { describe, expect, test } from "bun:test";
import { type DictionaryEntry, dictionaryEntries, duplicateGroups, normalizeDictionaryName, planMerge, sortDictionary } from "./Dictionaries";

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
      categories: [cat("C1", "Coffee"), cat("C2", "Auto care")],
      places: [],
      transactions: [txn({ items: [{ categoryId: "C1" }, { categoryId: "C1" }] }), txn({ categoryId: "C2" })],
    });

    expect(categories.map((c) => [c.name, c.uses])).toEqual([
      ["Auto care", 1],
      ["Coffee", 2],
    ]);
  });

  test("reports zero for an unused entry and keeps hidden ones in the list", () => {
    const { places } = dictionaryEntries({
      categories: [],
      places: [cat("P1", "Archived typo", true), cat("P2", "Clover Market")],
      transactions: [txn({ placeId: "P2" })],
    });

    expect(places).toEqual([
      { id: "P1", name: "Archived typo", archived: true, uses: 0 },
      { id: "P2", name: "Clover Market", archived: false, uses: 1 },
    ]);
  });
});

describe("sortDictionary", () => {
  const e = (name: string, uses: number): DictionaryEntry => ({ id: name, name, archived: false, uses });

  test("by uses ascending puts the prune candidates first, name breaking ties", () => {
    const rows = [e("Clover Market", 5), e("Auto care", 0), e("Movies", 2), e("Bar", 0)];
    expect(sortDictionary(rows, "uses", true).map((r) => r.name)).toEqual(["Auto care", "Bar", "Movies", "Clover Market"]);
  });

  test("by uses descending flips only the count, never the tie-break", () => {
    const rows = [e("Clover Market", 5), e("Auto care", 0), e("Movies", 2), e("Bar", 0)];
    expect(sortDictionary(rows, "uses", false).map((r) => r.name)).toEqual(["Clover Market", "Movies", "Auto care", "Bar"]);
  });

  test("by name ignores the direction toggle", () => {
    const rows = [e("Clover Market", 5), e("Auto care", 0)];
    expect(sortDictionary(rows, "name", false).map((r) => r.name)).toEqual(["Auto care", "Clover Market"]);
  });
});

describe("duplicateGroups", () => {
  const e = (name: string, uses: number): DictionaryEntry => ({ id: name, name, archived: false, uses });

  test("collapses case, diacritics and punctuation onto one group", () => {
    const groups = duplicateGroups([e("Clóver Market", 3), e("CLOVER MARKET", 1), e("clover market.", 7), e("Linden Market", 4)]);
    expect(groups.map((g) => g.map((x) => x.name))).toEqual([["clover market.", "Clóver Market", "CLOVER MARKET"]]);
  });

  test("the most-used variant leads the group — that is the name the merge keeps", () => {
    const [group] = duplicateGroups([e("movies", 2), e("Movies", 9)]);
    expect(group?.[0]?.name).toBe("Movies");
  });

  test("names that only look similar are NOT grouped — a wrong merge cannot be undone", () => {
    expect(duplicateGroups([e("Linden Market", 1), e("Linden Market Express", 1), e("Clover Market", 1)])).toEqual([]);
  });

  test("an entry alone in its group is not a suggestion", () => {
    expect(duplicateGroups([e("Auto care", 0)])).toEqual([]);
  });

  test("normalising leaves nothing to key on for punctuation-only names, so they never group", () => {
    expect(normalizeDictionaryName("—")).toBe("");
    expect(duplicateGroups([e("—", 1), e("…", 1)])).toEqual([]);
  });
});

describe("planMerge", () => {
  const e = (id: string, name: string, uses = 0, archived = false): DictionaryEntry => ({ id, name, archived, uses });
  const rows = [
    e("a", "Clover Market", 3),
    e("b", "CLOVER MARKET", 1),
    e("c", "clover market.", 1),
    e("d", "Linden Market", 5),
    e("z", "Clover Market Outlet", 0, true),
  ];

  test("one selection is not a merge", () => {
    expect(planMerge(["a"], rows, "Clover Market")).toBeNull();
  });

  test("the first entry ticked survives and keeps its id; the rest are absorbed", () => {
    expect(planMerge(["b", "a", "c"], rows, "CLOVER MARKET")).toEqual({ survivorId: "b", sourceIds: ["a", "c"], rename: null });
  });

  test("a different typed name renames the survivor — the human's name wins over any existing spelling", () => {
    expect(planMerge(["b", "a"], rows, "Clover Market Express")).toEqual({ survivorId: "b", sourceIds: ["a"], rename: "Clover Market Express" });
  });

  test("case-only difference is not a rename", () => {
    expect(planMerge(["a", "b"], rows, "clover market")?.rename).toBeNull();
  });

  test("typing the name of an entry NOT selected adopts it instead of minting a second row with that name", () => {
    expect(planMerge(["a", "b"], rows, "Linden Market")).toEqual({ survivorId: "d", sourceIds: ["a", "b"], rename: null });
  });

  test("a HIDDEN namesake is not adopted — merging into it would hide the result", () => {
    expect(planMerge(["a", "b"], rows, "Clover Market Outlet")).toEqual({ survivorId: "a", sourceIds: ["b"], rename: "Clover Market Outlet" });
  });

  test("ids that vanished (another device deleted them) drop out, and below two nothing happens", () => {
    expect(planMerge(["a", "gone"], rows, "Clover Market")).toBeNull();
  });

  test("an empty name leaves the survivor's own name alone", () => {
    expect(planMerge(["a", "b"], rows, "   ")?.rename).toBeNull();
  });
});
