import { describe, expect, test } from "bun:test";
import { highlightRanges, matchesSearch, normalizeForSearch } from "./search";

describe("normalizeForSearch", () => {
  test("lowercases", () => {
    expect(normalizeForSearch("ABC")).toBe("abc");
  });

  test("strips Polish diacritics", () => {
    expect(normalizeForSearch("Oszczędności")).toBe("oszczednosci");
    expect(normalizeForSearch("Żabka")).toBe("zabka");
    expect(normalizeForSearch("Środki")).toBe("srodki");
  });

  test("leaves already-plain text untouched (aside from casing)", () => {
    expect(normalizeForSearch("Hello World")).toBe("hello world");
  });
});

describe("matchesSearch", () => {
  test("diacritic-insensitive: a plain query matches accented text", () => {
    expect(matchesSearch("Oszczędności", "oszczednosci")).toBe(true);
  });

  test("diacritic-insensitive the other direction: an accented query matches plain text", () => {
    // (unlikely to happen from a real keyboard, but the normalization is symmetric)
    expect(matchesSearch("oszczednosci", "Oszczędności")).toBe(true);
  });

  test("case-insensitive", () => {
    expect(matchesSearch("Żabka", "ZABKA")).toBe(true);
    expect(matchesSearch("ŻABKA", "zabka")).toBe(true);
  });

  test("empty query matches everything", () => {
    expect(matchesSearch("anything at all", "")).toBe(true);
  });

  test("whitespace-only query matches everything", () => {
    expect(matchesSearch("anything at all", "   ")).toBe(true);
  });

  test("substring match, not whole-word", () => {
    expect(matchesSearch("Zakupy spożywcze", "spo")).toBe(true);
    expect(matchesSearch("Zakupy spożywcze", "kupy spo")).toBe(true);
  });

  test("no match", () => {
    expect(matchesSearch("Środki na koncie", "xyz")).toBe(false);
  });

  test("query longer than the text never matches", () => {
    expect(matchesSearch("ab", "abcd")).toBe(false);
  });
});

describe("highlightRanges", () => {
  test("whole-string match", () => {
    expect(highlightRanges("Żabka", "zabka")).toEqual([{ text: "Żabka", hit: true }]);
  });

  test("partial match in the middle, preserving original casing/diacritics", () => {
    expect(highlightRanges("Kawa i Herbata", "herb")).toEqual([
      { text: "Kawa i ", hit: false },
      { text: "Herb", hit: true },
      { text: "ata", hit: false },
    ]);
  });

  test("empty query returns the whole text unhit", () => {
    expect(highlightRanges("Something", "")).toEqual([{ text: "Something", hit: false }]);
  });

  test("no match returns the whole text unhit", () => {
    expect(highlightRanges("Something", "xyz")).toEqual([{ text: "Something", hit: false }]);
  });

  test("Polish diacritic trap: NFD decomposition must not desync original-string indices", () => {
    // "Środki" → NFD is "Środki"? No: Ś decomposes to S + combining acute (2 chars normalized
    // for 1 original char) — a naive normalize-then-slice-by-normalized-index would return the wrong
    // original substring here (off by the extra combining-mark code units).
    expect(highlightRanges("Środki", "srodki")).toEqual([{ text: "Środki", hit: true }]);
    expect(highlightRanges("Środki własne", "rodki")).toEqual([
      { text: "Ś", hit: false },
      { text: "rodki", hit: true },
      { text: " własne", hit: false },
    ]);
  });

  test("query longer than the text: no match, whole text unhit", () => {
    expect(highlightRanges("ab", "abcd")).toEqual([{ text: "ab", hit: false }]);
  });

  test("multi-word text: highlights only the matching word", () => {
    expect(highlightRanges("Ubezpieczenie na życie", "życie")).toEqual([
      { text: "Ubezpieczenie na ", hit: false },
      { text: "życie", hit: true },
    ]);
  });

  test("repeated occurrences are all highlighted", () => {
    expect(highlightRanges("ababab", "ab")).toEqual([
      { text: "ab", hit: true },
      { text: "ab", hit: true },
      { text: "ab", hit: true },
    ]);
  });
});
