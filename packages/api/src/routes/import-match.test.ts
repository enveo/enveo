import { describe, expect, test } from "bun:test";
import { confidentSourceRef, decideAssignment, type HistGroup, type HistPattern, rankPatterns, textSim } from "./import-match";

const g = (over: Partial<HistGroup> & { key: string }): HistGroup => ({
  place: null,
  name: null,
  envelope: null,
  category: null,
  count: 1,
  fromSourceRef: false,
  type: "expense",
  isRefund: false,
  toAccountId: null,
  ...over,
});

describe("textSim", () => {
  test("identical / containing → high", () => {
    expect(textSim("PRO*PLATNOSC", "PRO*PLATNOSC")).toBeGreaterThanOrEqual(0.95);
    expect(textSim("PRO*PLATNOSC 12345", "PRO*PLATNOSC")).toBeGreaterThanOrEqual(0.95);
  });
  test("different → low", () => {
    expect(textSim("PRO*PLATNOSC", "Orlen")).toBeLessThan(0.3);
  });
  test("single-letter keys → 0", () => {
    expect(textSim("N", "Netflix")).toBe(0);
  });
});

describe("rankPatterns — source_ref learns from corrections", () => {
  test("an exact source_ref hit wins even though name/place were corrected to something entirely different", () => {
    // real-life scenario: the bank shows 'PRO*PLATNOSC', the user corrected it to Orlen/Paliwo.
    // The corrected row has source_ref='PRO*PLATNOSC' (immutable) but place='Orlen'.
    const corrected = g({
      key: "PRO*PLATNOSC",
      fromSourceRef: true,
      place: "Orlen",
      name: "Paliwo",
      envelope: "Samochód",
      category: "Paliwo",
      count: 1,
    });
    // a competing, misleadingly similar pattern by place name alone
    const distractor = g({ key: "Play", place: "Play", name: "Telefon", envelope: "Rachunki", count: 9 });

    const top = rankPatterns("PRO*PLATNOSC", [corrected, distractor])[0];
    expect(top?.place).toBe("Orlen");
    expect(top?.envelope).toBe("Samochód");
    expect(top?.name).toBe("Paliwo");
  });

  test("source_ref wins even against a much more numerous place-name pattern", () => {
    const learned = g({ key: "ZEN*ABC", fromSourceRef: true, place: "Żabka", envelope: "Jedzenie", count: 1 });
    const popularByPlace = g({ key: "zen", place: "Zen", envelope: "Inne", count: 50 }); // fuzzy by name
    const top = rankPatterns("ZEN*ABC", [learned, popularByPlace])[0];
    expect(top?.place).toBe("Żabka");
    expect(top?.envelope).toBe("Jedzenie");
  });

  test("without source_ref — behavior as before (place anchor, 0.3 threshold, top5)", () => {
    const byPlace = g({ key: "Lidl", place: "Lidl", envelope: "Jedzenie", count: 3 });
    const unrelated = g({ key: "Bilety PKP", place: "PKP", envelope: "Transport", count: 1 });
    const ranked = rankPatterns("LIDL WARSZAWA", [byPlace, unrelated]);
    expect(ranked[0]?.place).toBe("Lidl");
    expect(ranked.find((p) => p.place === "PKP")).toBeUndefined(); // below the threshold
  });

  test("no matches → empty list", () => {
    const only = g({ key: "Orlen", place: "Orlen", envelope: "Samochód", count: 1 });
    expect(rankPatterns("Netflix", [only])).toEqual([]);
  });

  test("normalization: asterisks/letter case don't break an exact source_ref hit", () => {
    const learned = g({ key: "PRO*PLATNOSC", fromSourceRef: true, place: "Orlen", envelope: "Samochód", count: 1 });
    const top = rankPatterns("pro*platnosc", [learned])[0];
    expect(top?.place).toBe("Orlen");
  });
});

const p = (over: Partial<HistPattern>): HistPattern => ({
  place: null,
  name: null,
  envelope: null,
  category: null,
  count: 1,
  fromSourceRef: false,
  type: "expense",
  isRefund: false,
  toAccountId: null,
  ...over,
});

describe("decideAssignment — source_ref dominates end-to-end (not just in the ranking)", () => {
  test("a source_ref pattern outvotes the model's proposal (which picks by count)", () => {
    // rank[0] is a learned source_ref correction; the model, instructed to "take the highest count",
    // proposes the more numerous place-name pattern. source_ref MUST win deterministically.
    const top = p({ fromSourceRef: true, place: "Żabka", name: "Zakupy", envelope: "Jedzenie", category: "Spożywcze" });
    const model = { place: "Zen", name: "Przelew", envelope: "Inne", category: null };
    expect(decideAssignment("ZEN*8891", top, model)).toEqual({ name: "Zakupy", place: "Żabka", envelope: "Jedzenie", category: "Spożywcze" });
  });

  test("source_ref with empty fields honors null (does not fall back to the model's proposal)", () => {
    const top = p({ fromSourceRef: true, place: null, name: null, envelope: null, category: null });
    const model = { place: "Zen", name: "Przelew", envelope: "Inne", category: "X" };
    expect(decideAssignment("ZEN*8891", top, model)).toEqual({ name: "ZEN*8891", place: null, envelope: null, category: null });
  });

  test("without source_ref: the model wins, and top fills the MISSING fields (also envelope/category)", () => {
    const top = p({ place: "Lidl", name: "Zakupy", envelope: "Jedzenie", category: "Spożywcze", count: 50 });
    const model = { place: "Lidl", name: "Zakupy spożywcze", envelope: null, category: null };
    // the model provided name/place; envelope and category empty → backstop from top (previously missing)
    expect(decideAssignment("LIDL W-WA", top, model)).toEqual({ name: "Zakupy spożywcze", place: "Lidl", envelope: "Jedzenie", category: "Spożywcze" });
  });

  test("no pattern and no model → name = raw description, rest null", () => {
    expect(decideAssignment("NIEZNANE 123", undefined, undefined)).toEqual({ name: "NIEZNANE 123", place: null, envelope: null, category: null });
  });

  test("hardOverride=false: even fromSourceRef does NOT outvote the model (uncertain path → AI decides)", () => {
    const top = p({ fromSourceRef: true, place: "Żabka", envelope: "Jedzenie" });
    const model = { place: "Zen", name: "Przelew", envelope: "Inne", category: null };
    expect(decideAssignment("ZEN COS", top, model, false)).toEqual({ name: "Przelew", place: "Zen", envelope: "Inne", category: null });
  });
});

describe("confidentSourceRef — qualification for assignment WITHOUT AI", () => {
  test("an exact source_ref hit with an assignment → confident", () => {
    const learned = g({ key: "PRO*PLATNOSC", fromSourceRef: true, place: "Orlen", envelope: "Samochód", category: "Paliwo" });
    expect(confidentSourceRef("PRO*PLATNOSC", [learned])).toMatchObject({ envelope: "Samochód", place: "Orlen" });
  });

  test("containment (raw description with address noise) is also confident", () => {
    const learned = g({ key: "PRO*PLATNOSC", fromSourceRef: true, envelope: "Samochód" });
    expect(confidentSourceRef("PRO*PLATNOSC 99 WARSZAWA", [learned])).toMatchObject({ envelope: "Samochód" });
  });

  test("only trigram fuzzy (<0.95) → NOT confident (null → to the AI)", () => {
    const learned = g({ key: "PRO PLATNOSC", fromSourceRef: true, envelope: "Samochód" });
    expect(confidentSourceRef("PRA PLETNOSE", [learned])).toBeNull();
  });

  test("a place match (not source_ref) → is never confident", () => {
    const byPlace = g({ key: "Orlen", place: "Orlen", envelope: "Samochód", count: 99 });
    expect(confidentSourceRef("Orlen", [byPlace])).toBeNull();
  });

  test("source_ref without any assignment → NOT confident (nothing to copy)", () => {
    const learned = g({ key: "PRO*PLATNOSC", fromSourceRef: true, place: null, envelope: null, category: null });
    expect(confidentSourceRef("PRO*PLATNOSC", [learned])).toBeNull();
  });

  test("with two confident hits the more numerous one wins", () => {
    const a = g({ key: "PRO*PLATNOSC", fromSourceRef: true, envelope: "Samochód", count: 1 });
    const b = g({ key: "PRO*PLATNOSC", fromSourceRef: true, envelope: "Inne", count: 5 });
    expect(confidentSourceRef("PRO*PLATNOSC", [a, b])?.envelope).toBe("Inne");
  });
});

describe("TYPE learning from history (2026-07-12)", () => {
  test("confident carries over the type/refund/transfer target account", () => {
    const tr = g({ key: "ZEN*ABC", fromSourceRef: true, type: "transfer", toAccountId: "ACC-B" });
    const hit = confidentSourceRef("ZEN*ABC", [tr]);
    expect(hit?.type).toBe("transfer");
    expect(hit?.toAccountId).toBe("ACC-B");
  });
  test("a pure transfer (no envelope/category/place) is NOT rejected — the type is a real assignment", () => {
    const tr = g({ key: "ZEN*ABC", fromSourceRef: true, type: "transfer", toAccountId: "ACC-B" });
    expect(confidentSourceRef("zen*abc", [tr])).not.toBeNull();
  });
  test("a learned refund: expense+isRefund passes through", () => {
    const rf = g({ key: "ALLEGRO*R", fromSourceRef: true, type: "expense", isRefund: true });
    const hit = confidentSourceRef("ALLEGRO*R", [rf]);
    expect(hit?.isRefund).toBe(true);
  });
  test("a plain expense without assignments still falls through to the AI (no regression)", () => {
    const ex = g({ key: "XX*1", fromSourceRef: true });
    expect(confidentSourceRef("XX*1", [ex])).toBeNull();
  });
  test("rankPatterns carries the type in patterns (context for cycle 2)", () => {
    const tr = g({ key: "ZEN*ABC", fromSourceRef: true, type: "transfer", toAccountId: "ACC-B", place: "Zen" });
    expect(rankPatterns("zen*abc", [tr])[0]?.type).toBe("transfer");
  });
});
