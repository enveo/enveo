import { describe, expect, test } from "bun:test";
import type { ClientLedger, Transaction } from "@enveo/shared";
import { purgeLegacyPlannedIds } from "./legacyPlanned";

const emptyLedger = (): ClientLedger => ({
  accounts: [],
  groups: [],
  envelopes: [],
  transactions: [],
  allocations: [],
  categories: [],
  places: [],
  budgets: [],
});

const baseTxn = (id: string): Transaction => ({
  id,
  type: "expense",
  accountId: "acc-1",
  toAccountId: null,
  amount: 500,
  date: "2026-01-01",
  isRefund: false,
  envelopeId: null,
  placeId: null,
  categoryId: null,
  name: null,
  note: null,
  tag: null,
  items: [],
  createdAt: "2026-01-01T00:00:00.000Z",
});

/** Simulates an old IDB blob / e2ee replica that still carries the legacy `planned` field —
 *  the TS type no longer declares it, so it must be attached past the type. */
const withLegacyPlanned = (id: string, planned: boolean): Transaction => ({ ...baseTxn(id), planned }) as unknown as Transaction;

describe("purgeLegacyPlannedIds", () => {
  test("a ledger with no legacy planned rows → empty list", () => {
    const ledger: ClientLedger = { ...emptyLedger(), transactions: [baseTxn("t1"), baseTxn("t2")] };
    expect(purgeLegacyPlannedIds(ledger)).toEqual([]);
  });

  test("a leftover planned=true row (raw JSON, past the TS type) → its id is returned", () => {
    const ledger: ClientLedger = {
      ...emptyLedger(),
      transactions: [baseTxn("normal-1"), withLegacyPlanned("planned-1", true)],
    };
    expect(purgeLegacyPlannedIds(ledger)).toEqual(["planned-1"]);
  });

  test("planned=false is not swept (only planned === true counts)", () => {
    const ledger: ClientLedger = { ...emptyLedger(), transactions: [withLegacyPlanned("t1", false)] };
    expect(purgeLegacyPlannedIds(ledger)).toEqual([]);
  });

  test("multiple leftover rows → every id is returned, in ledger order", () => {
    const ledger: ClientLedger = {
      ...emptyLedger(),
      transactions: [withLegacyPlanned("p1", true), baseTxn("normal"), withLegacyPlanned("p2", true)],
    };
    expect(purgeLegacyPlannedIds(ledger)).toEqual(["p1", "p2"]);
  });

  test("idempotent: re-running on a ledger with the rows already removed finds nothing", () => {
    const ledger: ClientLedger = { ...emptyLedger(), transactions: [baseTxn("normal-1")] };
    expect(purgeLegacyPlannedIds(ledger)).toEqual([]);
  });
});
