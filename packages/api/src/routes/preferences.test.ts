import { describe, expect, test } from "bun:test";
import { accountPreferencesPatchInput, canonicalAccountPreferences } from "./preferences";

describe("account preference route contracts", () => {
  test("PATCH requires a user assertion and a strict non-empty patch", () => {
    expect(accountPreferencesPatchInput.safeParse({ userId: "user-a", patch: { lang: "pl" } }).success).toBe(true);
    expect(accountPreferencesPatchInput.safeParse({ userId: "user-a", patch: {} }).success).toBe(false);
    expect(accountPreferencesPatchInput.safeParse({ userId: "", patch: { lang: "pl" } }).success).toBe(false);
    expect(accountPreferencesPatchInput.safeParse({ userId: "user-a", patch: { lang: "xx" } }).success).toBe(false);
    expect(accountPreferencesPatchInput.safeParse({ userId: "user-a", patch: { unknown: true } }).success).toBe(false);
  });

  test("a missing row has a stable complete default response", () => {
    expect(canonicalAccountPreferences(undefined)).toEqual({ schemaVersion: 1, lang: "en", themeMode: "light", accentTheme: "auto", revision: 0 });
  });

  test("a stored row becomes the same stable response shape", () => {
    expect(canonicalAccountPreferences({ lang: "pl", themeMode: "dark", accentTheme: "duet", revision: 4 })).toEqual({
      schemaVersion: 1,
      lang: "pl",
      themeMode: "dark",
      accentTheme: "duet",
      revision: 4,
    });
  });
});
