/**
 * Pure subs.ts helpers. An e2e regression (Task 8): a pause deleted the ONLY
 * planned template of a rule → the template-driven materialization never
 * resurrected the rule, it vanished from "Recurring", and detection re-proposed
 * the group. Fix: the template is MOVED to the first occurrence ≥ pausedUntil
 * (nextOccurrenceOnOrAfter — step parity with occurrences() in api/extras.ts).
 */
import { describe, expect, test } from "bun:test";
import { addMonthsISO, nextOccurrenceOnOrAfter } from "./subs";

describe("addMonthsISO", () => {
  test("adds months (UTC)", () => {
    expect(addMonthsISO("2026-07-08", 1)).toBe("2026-08-08");
    expect(addMonthsISO("2026-07-08", 3)).toBe("2026-10-08");
  });
  test("day overflow per Date semantics (Jan 31 +1 → Mar 3 in a non-leap year)", () => {
    expect(addMonthsISO("2026-01-31", 1)).toBe("2026-03-03");
  });
});

describe("nextOccurrenceOnOrAfter", () => {
  test("monthly: stepping from 2026-08-07 past pausedUntil 2026-08-08 → 2026-09-07", () => {
    expect(nextOccurrenceOnOrAfter("monthly", "2026-08-07", "2026-08-08")).toBe("2026-09-07");
  });
  test("date already ≥ min → no step", () => {
    expect(nextOccurrenceOnOrAfter("monthly", "2026-09-07", "2026-08-08")).toBe("2026-09-07");
  });
  test("weekly: +7 days until ≥ min", () => {
    expect(nextOccurrenceOnOrAfter("weekly", "2026-07-01", "2026-07-20")).toBe("2026-07-22");
  });
  test("yearly: +1 year", () => {
    expect(nextOccurrenceOnOrAfter("yearly", "2026-01-15", "2026-02-01")).toBe("2027-01-15");
  });
  test("quarterly: +3 months", () => {
    expect(nextOccurrenceOnOrAfter("quarterly", "2026-06-01", "2026-07-01")).toBe("2026-09-01");
  });
  test("monthEnd: the last day of the next month (parity with api occurrences)", () => {
    expect(nextOccurrenceOnOrAfter("monthEnd", "2026-07-31", "2026-08-01")).toBe("2026-08-31");
  });
  test("none: does not step — returns minISO", () => {
    expect(nextOccurrenceOnOrAfter("none", "2026-07-01", "2026-08-01")).toBe("2026-08-01");
  });
});
