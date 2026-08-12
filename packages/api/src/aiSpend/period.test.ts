import { describe, expect, it } from "bun:test";
import { periodAtUtc, periodForKey, retryAfterSecondsUntil } from "./period";

const utc = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0, ms = 0) => Date.UTC(y, m - 1, d, hh, mm, ss, ms);

describe("periodAtUtc — UTC calendar months, half-open [start, nextStart)", () => {
  it("maps a mid-month instant to its canonical key and boundaries", () => {
    const p = periodAtUtc(utc(2026, 8, 12, 13, 45));
    expect(p).toEqual({ key: "2026-08", startMs: utc(2026, 8, 1), endMs: utc(2026, 9, 1) });
  });

  it("the exact month start belongs to the NEW month (half-open interval)", () => {
    expect(periodAtUtc(utc(2026, 9, 1)).key).toBe("2026-09");
    expect(periodAtUtc(utc(2026, 9, 1) - 1).key).toBe("2026-08");
  });

  it("handles 28/29/30/31-day months", () => {
    expect(periodAtUtc(utc(2026, 2, 15)).endMs).toBe(utc(2026, 3, 1)); // Feb 2026: 28 days
    expect(periodAtUtc(utc(2028, 2, 15)).endMs).toBe(utc(2028, 3, 1)); // Feb 2028: 29 days (leap)
    expect(periodAtUtc(utc(2028, 2, 29, 23, 59, 59, 999)).key).toBe("2028-02"); // Feb 29 exists and stays in February
    expect(periodAtUtc(utc(2026, 4, 30)).endMs).toBe(utc(2026, 5, 1)); // 30-day April
    expect(periodAtUtc(utc(2026, 7, 31)).endMs).toBe(utc(2026, 8, 1)); // 31-day July
  });

  it("December→January crosses the year boundary by calendar arithmetic", () => {
    const p = periodAtUtc(utc(2026, 12, 31, 23, 59, 59));
    expect(p.key).toBe("2026-12");
    expect(p.endMs).toBe(utc(2027, 1, 1));
    expect(periodAtUtc(p.endMs).key).toBe("2027-01");
  });

  it("is independent of the host timezone by construction (UTC accessors only)", () => {
    // An instant that is Aug 31 22:00 UTC is already September in UTC+3 — the period must not care.
    expect(periodAtUtc(utc(2026, 8, 31, 22)).key).toBe("2026-08");
  });

  it("rejects a non-finite timestamp", () => {
    expect(() => periodAtUtc(Number.NaN)).toThrow();
  });
});

describe("periodForKey — re-derives the checked period for a late-arriving charge", () => {
  it("round-trips with periodAtUtc", () => {
    const p = periodAtUtc(utc(2026, 2, 3));
    expect(periodForKey(p.key)).toEqual(p);
  });
  it("December key ends at January 1 of the next year", () => {
    expect(periodForKey("2026-12").endMs).toBe(utc(2027, 1, 1));
  });
  it("rejects malformed and out-of-range keys", () => {
    for (const bad of ["2026-13", "2026-00", "2026-1", "26-01", "2026/01", "2026-01-01", ""]) {
      expect(() => periodForKey(bad)).toThrow();
    }
  });
});

describe("retryAfterSecondsUntil — integer ceiling against the next UTC month boundary", () => {
  const end = utc(2026, 9, 1);
  it("whole seconds pass through", () => {
    expect(retryAfterSecondsUntil(end, end - 60_000)).toBe(60);
  });
  it("fractions round UP (the client may not retry early)", () => {
    expect(retryAfterSecondsUntil(end, end - 60_001)).toBe(61);
    expect(retryAfterSecondsUntil(end, end - 1)).toBe(1);
  });
  it("never returns less than 1 even at (or past) the boundary", () => {
    expect(retryAfterSecondsUntil(end, end)).toBe(1);
    expect(retryAfterSecondsUntil(end, end + 5_000)).toBe(1);
  });
});
