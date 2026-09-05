import { describe, expect, it } from "bun:test";
import { balanceMatchOptions, findBalanceMatches } from "./importBalanceMatch";

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
    candidate("pending-coffee", -1200, true), // selected pending card hold
    candidate("refund", 3499, false), // left-out refund
    candidate("topup", 100000, false, true), // left-out top-up with an uncertain direction
    candidate("dup", -30850, true), // probable duplicate, selected
  ];

  it("returns nothing when the balance already matches", () => {
    expect(findBalanceMatches(pool, 0)).toEqual([]);
  });

  it("prefers the smallest number of changes and lists every minimal solution", () => {
    // given: the bank shows 308.50 more than the selection explains
    // then: excluding the duplicate alone explains it; no two-change set is considered
    expect(findBalanceMatches(pool, 30850)).toEqual([[{ id: "dup", action: "exclude", delta: 30850 }]]);
  });

  it("combines changes when no single row explains the difference", () => {
    // 30850 + 3499 = including the refund and dropping the duplicate
    expect(findBalanceMatches(pool, 34349)).toEqual([
      [
        { id: "refund", action: "include", delta: 3499 },
        { id: "dup", action: "exclude", delta: 30850 },
      ],
    ]);
  });

  it("uses a sign flip only where the direction was uncertain", () => {
    expect(findBalanceMatches(pool, -100000)).toEqual([[{ id: "topup", action: "flip", delta: -100000 }]]);
    expect(findBalanceMatches(pool, 1200)).toEqual([[{ id: "pending-coffee", action: "exclude", delta: 1200 }]]);
    expect(findBalanceMatches(pool, 2400)).toEqual([]);
  });

  it("respects the change bound and the solution cap", () => {
    const many = Array.from({ length: 12 }, (_, index) => candidate(`r${index}`, -100, false));
    expect(findBalanceMatches(many, -300, { maxSolutions: 3 })).toHaveLength(3);
    expect(findBalanceMatches(many, -600)).toEqual([]);
    expect(findBalanceMatches(many, -300, { maxCandidates: 2 })).toEqual([]);
  });
});
