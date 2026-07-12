/**
 * DB-backed tests for the push idempotency guard (spec §6: "per-budget opId
 * idempotency — same opId in two budgets both apply; replay within one budget
 * is a no-op"). Also pins the pre-0014 (budget_id NULL) upgrade semantics.
 *
 * OPT-IN: set TEST_DATABASE_URL to a THROWAWAY Postgres — these tests migrate
 * and WRITE. CI provides a service container; locally:
 *   docker run -d --rm --name enveotest -e POSTGRES_USER=enveo \
 *     -e POSTGRES_PASSWORD=enveo -e POSTGRES_DB=enveo \
 *     -p 127.0.0.1:5499:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://enveo:enveo@127.0.0.1:5499/enveo \
 *     bun test packages/api/src/sync/idempotency.test.ts
 * There is deliberately NO fallback to DATABASE_URL (that one points at real data).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as s from "../db/schema";
import { claimOp } from "./idempotency";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");
}

const CLIENT_ID = "idempotency-test";
const KIND = "txn.create";

/** Same construction as db/client.ts — so the instance IS an `Executor`. */
const connect = (url: string) => {
  const client = postgres(url, { max: 2, onnotice: () => {} });
  return { client, db: drizzle(client, { schema: s }) };
};

let client: ReturnType<typeof connect>["client"];
let db: ReturnType<typeof connect>["db"];
let budgetA = "";
let budgetB = "";

const opsFor = (opId: string) =>
  db
    .select({ opId: s.syncOps.opId, budgetId: s.syncOps.budgetId })
    .from(s.syncOps)
    .where(eq(s.syncOps.opId, opId));

describe.skipIf(!TEST_URL)("push idempotency guard (per budget)", () => {
  beforeAll(async () => {
    ({ client, db } = connect(TEST_URL));
    // the real migration folder — 0014 (drop of the global op_id PK, composite
    // unique index, partial legacy index) is exercised here too
    await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
    const [user] = await db
      .insert(s.users)
      .values({ email: `idempotency-${crypto.randomUUID()}@example.test` })
      .returning({ id: s.users.id });
    const rows = await db
      .insert(s.budgets)
      .values([
        { userId: user!.id, name: "tenant A" },
        { userId: user!.id, name: "tenant B" },
      ])
      .returning({ id: s.budgets.id });
    budgetA = rows[0]!.id;
    budgetB = rows[1]!.id;
  });

  afterAll(async () => {
    await client?.end();
  });

  it("the same opId in two budgets: BOTH apply (no cross-tenant blocking)", async () => {
    const opId = crypto.randomUUID();
    expect(await claimOp(db, { opId, budgetId: budgetA, clientId: CLIENT_ID, kind: KIND })).toBe(true);
    expect(await claimOp(db, { opId, budgetId: budgetB, clientId: CLIENT_ID, kind: KIND })).toBe(true);
    const rows = await opsFor(opId);
    expect(rows.map((r) => r.budgetId).sort()).toEqual([budgetA, budgetB].sort());
  });

  it("replay within one budget is a no-op (duplicate, no second row)", async () => {
    const opId = crypto.randomUUID();
    expect(await claimOp(db, { opId, budgetId: budgetA, clientId: CLIENT_ID, kind: KIND })).toBe(true);
    expect(await claimOp(db, { opId, budgetId: budgetA, clientId: CLIENT_ID, kind: KIND })).toBe(false);
    expect(await claimOp(db, { opId, budgetId: budgetA, clientId: "other-device", kind: KIND })).toBe(
      false,
    );
    expect(await opsFor(opId)).toHaveLength(1);
  });

  it("a pre-0014 row (budget_id NULL) is treated as already applied in EVERY budget", async () => {
    // an op pushed before the upgrade: 0014 could not backfill its budget
    // (multi-budget database). A client re-pushing it must NOT re-apply it.
    const opId = crypto.randomUUID();
    await db.insert(s.syncOps).values({ opId, budgetId: null, clientId: CLIENT_ID, kind: KIND });
    expect(await claimOp(db, { opId, budgetId: budgetA, clientId: CLIENT_ID, kind: KIND })).toBe(false);
    expect(await claimOp(db, { opId, budgetId: budgetB, clientId: CLIENT_ID, kind: KIND })).toBe(false);
    expect(await opsFor(opId)).toHaveLength(1);
  });

  it("the claim rolls back with its transaction (a rejected op leaves no row)", async () => {
    const opId = crypto.randomUUID();
    await expect(
      db.transaction(async (tx) => {
        expect(await claimOp(tx, { opId, budgetId: budgetA, clientId: CLIENT_ID, kind: KIND })).toBe(
          true,
        );
        throw new Error("domain rejection");
      }),
    ).rejects.toThrow("domain rejection");
    expect(await opsFor(opId)).toHaveLength(0);
    // …so the client may retry it and it applies
    expect(await claimOp(db, { opId, budgetId: budgetA, clientId: CLIENT_ID, kind: KIND })).toBe(true);
  });
});
