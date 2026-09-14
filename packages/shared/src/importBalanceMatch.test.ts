import { describe, expect, it } from "bun:test";
import { balanceMatchOptions, findBalanceMatches, findNearestBalanceMatch } from "./importBalanceMatch";

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
    expect(findBalanceMatches(many, -300, { maxCandidates: 2 })).toEqual([]);
  });
});

describe("the closest fit when nothing is exact", () => {
  const candidate = (id: string, effect: number, included = true, flippable = false): BalanceMatchCandidate => ({ id, effect, included, flippable });

  it("returns the change set with the smallest residual, then the fewest changes", () => {
     
    const nearest = findNearestBalanceMatch([candidate("dup-credit", 74218), candidate("cancelled", 91863), candidate("pending", -36529, false)], -166822);

    expect(nearest).toEqual({
      changes: [
        { id: "dup-credit", action: "exclude", delta: -74218 },
        { id: "cancelled", action: "exclude", delta: -91863 },
      ],
      residual: -741,
    });
  });

  it("prefers one large plausible change over several small ones that fit a few cents better", () => {
    

    const nearest = findNearestBalanceMatch(
      [
        candidate("cancelled", 91863),
        candidate("example-grocer", -12944),
        candidate("topup-a", 60000),
        candidate("example-market", -35322),
        candidate("topup-b", 80137),
      ],
      -92604,
    );

    expect(nearest).toEqual({ changes: [{ id: "cancelled", action: "exclude", delta: -91863 }], residual: -741 });
  });

  it("leaves a difference of a few units alone rather than unchecking rows to chase it", () => {
    expect(findNearestBalanceMatch([candidate("a", -20000), candidate("b", -3400), candidate("c", 15000, false)], -317)).toBeNull();
  });

  it("offers nothing when no change brings the difference closer, or when it is already zero", () => {
    expect(findNearestBalanceMatch([candidate("a", -500)], -700)).toBeNull();  
    expect(findNearestBalanceMatch([candidate("a", -500)], 0)).toBeNull();
    expect(findNearestBalanceMatch([], -700)).toBeNull();
  });
});
