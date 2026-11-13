import { describe, expect, it } from "bun:test";
import { type BalanceMatchCandidate, balanceMatchOptions, findBalanceMatches } from "./importBalanceMatch";

const candidate = (id: string, effect: number, included: boolean, flippable = false) => ({ id, effect, included, flippable });

describe("balance match options", () => {
  it("offers exclusion for a selected row, inclusion for a left-out one and a sign flip when the direction is uncertain", () => {
    expect(balanceMatchOptions(candidate("a", -2500, true))).toEqual([{ id: "a", action: "exclude", delta: 2500 }]);
    expect(balanceMatchOptions(candidate("b", -2500, false))).toEqual([{ id: "b", action: "include", delta: -2500 }]);
    expect(balanceMatchOptions(candidate("c", -2500, true, true))).toEqual([
      { id: "c", action: "exclude", delta: 2500 },
      { id: "c", action: "flip", delta: 5000 },
    ]);
    expect(balanceMatchOptions(candidate("d", -2500, false, true))).toEqual([
      { id: "d", action: "include", delta: -2500 },
      { id: "d", action: "flip", delta: 2500 },
    ]);
    expect(balanceMatchOptions(candidate("zero", 0, true))).toEqual([]);
  });
});

describe("finding a selection that matches the bank balance", () => {
  const pool = [
    candidate("pending-lunch", -1847, true),
    candidate("refund", 5273, false),
    candidate("topup", 84216, false, true),
    candidate("dup", -27641, true),
  ];

  it("returns nothing when the balance already matches", () => {
    expect(findBalanceMatches(pool, 0)).toEqual([]);
  });

  it("prefers the smallest number of changes and lists every minimal solution", () => {
    expect(findBalanceMatches(pool, 27641)).toEqual([[{ id: "dup", action: "exclude", delta: 27641 }]]);
  });

  it("combines changes when no single row explains the difference", () => {
    expect(findBalanceMatches(pool, 32914)).toEqual([
      [
        { id: "refund", action: "include", delta: 5273 },
        { id: "dup", action: "exclude", delta: 27641 },
      ],
    ]);
  });

  it("uses a sign flip only where the direction was uncertain", () => {
    expect(findBalanceMatches(pool, -84216)).toEqual([[{ id: "topup", action: "flip", delta: -84216 }]]);
    expect(findBalanceMatches(pool, 1847)).toEqual([[{ id: "pending-lunch", action: "exclude", delta: 1847 }]]);
    expect(findBalanceMatches(pool, 3694)).toEqual([]);
  });

  it("respects the change bound and the solution cap", () => {
    const many = Array.from({ length: 12 }, (_, index) => candidate(`r${index}`, -100, false));
    expect(findBalanceMatches(many, -300, { maxSolutions: 3 })).toHaveLength(3);
    expect(findBalanceMatches(many, -600)).toEqual([]);
    // Four changes already fit by coincidence too often to be offered.
    expect(findBalanceMatches(many, -400)).toEqual([]);
    expect(findBalanceMatches(many, -400, { maxChanges: 4 })).not.toEqual([]);
    expect(findBalanceMatches(many, -300, { maxCandidates: 2 })).toEqual([]);
  });
});

describe("how often the match is right on a simulated review", () => {
  // A seeded generator, so the rates are a fixed fence a later change cannot quietly worsen.
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Mostly card payments of 1–99, some of 100–499, a few larger; 85% of them expenses.
  const entry = (next: () => number) => {
    const size = next();
    const magnitude = size < 0.6 ? 100 + Math.floor(next() * 9900) : size < 0.9 ? 10000 + Math.floor(next() * 40000) : 50000 + Math.floor(next() * 200000);
    return (next() < 0.85 ? -1 : 1) * magnitude;
  };
  const doubtfulRows = (next: () => number, count: number): BalanceMatchCandidate[] =>
    Array.from({ length: count }, (_, index) => ({ id: `row${index}`, effect: entry(next), included: next() < 0.5, flippable: next() < 0.3 }));
  const TRIALS = 200;
  const simulate = () => {
    const next = random(40);
    let coincidences = 0;
    let causesFound = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const rows = doubtfulRows(next, 40);
      // An entry missing between screenshots: no row of the review explains it.
      if (findBalanceMatches(rows, entry(next)).length > 0) coincidences += 1;
      // One to three doubtful rows the human should have treated the other way.
      const cause = new Set<number>();
      const size = 1 + Math.floor(next() * 3);
      while (cause.size < size) cause.add(Math.floor(next() * rows.length));
      const difference = [...cause].reduce((sum, index) => sum + (rows[index]!.included ? -rows[index]!.effect : rows[index]!.effect), 0);
      const expected = [...cause]
        .map((index) => `row${index}`)
        .sort()
        .join();
      if (
        findBalanceMatches(rows, difference).some(
          (changes) =>
            changes
              .map((change) => change.id)
              .sort()
              .join() === expected,
        )
      )
        causesFound += 1;
    }
    return { coincidences: coincidences / TRIALS, causesFound: causesFound / TRIALS };
  };

  it("finds a real cause among 40 doubtful rows and rarely invents one for an entry missing from the screenshots", () => {
    // given: 200 reviews of 40 doubtful rows (observed: 11% coincidences, 100% causes found;
    // the former cap of five changes per suggestion fits 97% of the missing entries by coincidence)
    const rates = simulate();

    expect(rates.coincidences).toBeLessThan(0.2);
    expect(rates.causesFound).toBeGreaterThan(0.95);
  });
});
