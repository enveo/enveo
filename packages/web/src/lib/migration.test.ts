import { describe, expect, test } from "bun:test";
import type { ClientLedger } from "@enveo/shared";
import { migrationBlockedByData, migrationFitsUpload, uploadFailureIsRetryable } from "./migration";
import { UnauthorizedError } from "./sync/contracts";

const empty: ClientLedger = { budgets: [], accounts: [], groups: [], envelopes: [], categories: [], places: [], allocations: [], transactions: [] };

describe("migration target", () => {
  test("given a fresh budget when checked then the migration may land", () => {
    expect(migrationBlockedByData(empty)).toBe(false);
  });

  test("given only the starter template when checked then nothing would be lost", () => {
    expect(migrationBlockedByData({ ...empty, groups: [{ id: "g", name: "Bills", sort: 0 }] })).toBe(false);
  });

  test("given an assignment when checked then the budget is refused", () => {
    expect(migrationBlockedByData({ ...empty, allocations: [{ id: "a", envelopeId: "e", month: "2026-09", amount: 100 }] })).toBe(true);
  });

  test("given no replica yet when checked then the budget is refused", () => {
    expect(migrationBlockedByData(null)).toBe(true);
  });

  test("given a ledger within the request limit when checked then the tier decides", () => {
    const name = "x".repeat(13 * 1024 * 1024);
    const large = { ...empty, places: [{ id: "p", name, archived: false }] };
    expect(migrationFitsUpload(large, "plain")).toBe(true);
    expect(migrationFitsUpload(large, "e2ee")).toBe(false);
  });

  test("given a ledger past the request limit when checked then it does not fit", () => {
    const large = { ...empty, places: [{ id: "p", name: "x".repeat(17 * 1024 * 1024), archived: false }] };
    expect(migrationFitsUpload(large, "plain")).toBe(false);
  });

  test("given a request wrapper that would cross the limit when checked then it does not fit", () => {
    const fill = 16 * 1024 * 1024 - 200;
    expect(migrationFitsUpload({ ...empty, places: [{ id: "p", name: "x".repeat(fill), archived: false }] }, "plain")).toBe(false);
  });

  test("given how an upload failed when judged then only what can heal is retried", () => {
    expect(uploadFailureIsRetryable(new TypeError("Failed to fetch"))).toBe(true);
    expect(uploadFailureIsRetryable(new Error("503 unavailable"))).toBe(true);
    expect(uploadFailureIsRetryable(new UnauthorizedError())).toBe(true);
    expect(uploadFailureIsRetryable(new Error("400 foreign_ref"))).toBe(false);
    expect(uploadFailureIsRetryable(new Error("413 too_large"))).toBe(false);
    expect(uploadFailureIsRetryable(new Error("foreign_replica"))).toBe(false);
  });
});
