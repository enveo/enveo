import { beforeAll, describe, expect, test } from "bun:test";
import { runChild } from "../api.test-support";
import { SENTINEL, type SyncDictionariesOutput } from "./sync.dictionaries.db.test-child";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");

const CHILD = new URL("./sync.dictionaries.db.test-child.ts", import.meta.url).pathname;

describe.skipIf(!TEST_URL)("dictionary upkeep through sync push", () => {
  let output: SyncDictionariesOutput;

  beforeAll(async () => {
    output = await runChild<SyncDictionariesOutput>({ path: CHILD, testUrl: TEST_URL, sentinel: SENTINEL, cwd: new URL("../..", import.meta.url).pathname });
  }, 120_000);

  test("hiding an entry leaves every transaction that carries it untouched, and replays once", () => {
    expect(output.hide).toEqual({ archived: true, transactionKeptIt: true, replayIdempotent: true });
  });

  test("restoring clears the flag", () => {
    expect(output.restore).toEqual({ archived: true });
  });

  test("deleting an entry nothing references removes the row", () => {
    expect(output.deleteUnused).toEqual({ rowGone: true });
  });

  // The client offers delete only at zero usages, but it checked its OWN replica: another device
  // may have added a referencing transaction first. `place_id` is `on delete set null`, so a real
  // delete here would strip the value out of that transaction — the server must archive instead.
  test("a delete that lost the race degrades to an archive and spares the transaction", () => {
    expect(output.deleteRaced).toEqual({ rowKept: true, archived: true, transactionKeptIt: true });
  });

  test("a reference living only inside a SPLIT ITEM counts too", () => {
    expect(output.deleteRacedByItem).toEqual({ rowKept: true, archived: true, itemKeptIt: true });
  });
});
