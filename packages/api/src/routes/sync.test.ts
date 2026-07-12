/**
 * Tenant isolation of sync v1 (spec §4):
 *  - the PER-REQUEST budget assertion on push (budgetAssertionFails): the server resolves the
 *    target budget from the session cookie alone, so a cookie swapped between two batches of
 *    the same push loop would apply the rest of one user's outbox to another user's budget,
 *  - the `changes` journal is per-tenant since 0015: /sync/pull used to hand EVERY tenant EVERY
 *    other tenant's delete rows (table + row id + seq) — upserts were content-filtered, deletes
 *    were not.
 *
 * The journal part is DB-backed (the attribution lives in a Postgres TRIGGER, and FK cascades
 * must be attributed too). OPT-IN: set TEST_DATABASE_URL to a THROWAWAY Postgres — these tests
 * migrate and WRITE. CI provides a service container; locally:
 *   docker run -d --rm --name enveotest -e POSTGRES_USER=enveo \
 *     -e POSTGRES_PASSWORD=enveo -e POSTGRES_DB=enveo \
 *     -p 127.0.0.1:5499:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://enveo:enveo@127.0.0.1:5499/enveo \
 *     bun test packages/api/src/routes/sync.test.ts
 * There is deliberately NO fallback to DATABASE_URL (that one points at real data).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as s from "../db/schema";
import {
  budgetAssertionFails,
  legacyChangesWatermark,
  ownerAssertionFails,
  pullChanges,
  pushInput,
  replaceInput,
} from "./sync";

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";

const EMPTY_LEDGER = {
  accounts: [],
  groups: [],
  envelopes: [],
  categories: [],
  places: [],
  recurrences: [],
  allocations: [],
  transactions: [],
};

/* ── The per-request tenant assertion (pure) ──────────────────────────── */

describe("push: the per-request budget assertion", () => {
  it("a client that names ANOTHER budget than the session's is refused", () => {
    expect(budgetAssertionFails(UUID_A, UUID_B)).toBe(true);
  });

  it("naming the session's own budget passes", () => {
    expect(budgetAssertionFails(UUID_A, UUID_A)).toBe(false);
  });

  it("a client that names no budget is not refused (pre-2.0 client, legacy e2ee replica)", () => {
    expect(budgetAssertionFails(undefined, UUID_A)).toBe(false);
  });

  it("the push body accepts an optional budgetId and rejects a non-uuid", () => {
    const ops = [{ opId: UUID_A, kind: "txn.delete", payload: { id: UUID_B } }];
    expect(pushInput.safeParse({ clientId: "dev", ops }).success).toBe(true);
    expect(pushInput.safeParse({ clientId: "dev", budgetId: UUID_B, ops }).success).toBe(true);
    expect(pushInput.safeParse({ clientId: "dev", budgetId: "nope", ops }).success).toBe(false);
  });
});

/* ── The per-request OWNER assertion (full-budget overwrite routes) ────────
 *
 * /sync/replace (and /sync2/reset, /budget/e2ee/enable|disable) resolve the target budget from
 * the session cookie ALONE, and the client's ownership check is a different request than the
 * write — a sign-in in another tab can complete while a whole ledger is being uploaded, after
 * which restoreLedger would wipe the NEW user's budget and rebuild it from THIS body. The write
 * therefore names the tenant the client verified.
 *
 * The tenant is the USER, not the budget: on a restore the client's replica deliberately carries
 * the BACKUP FILE's budgetId (web/lib/data.ts), which is exactly not the session's — a budget
 * assertion here would refuse every restore of a backup taken on another install. */

describe("overwrite routes: the per-request owner assertion", () => {
  it("a body naming ANOTHER user than the session's is refused", () => {
    expect(ownerAssertionFails("user-A", "user-B")).toBe(true);
  });

  it("naming the session's own user passes", () => {
    expect(ownerAssertionFails("user-A", "user-A")).toBe(false);
  });

  it("a client that names no user is not refused (pre-2.0 client)", () => {
    expect(ownerAssertionFails(undefined, "user-A")).toBe(false);
  });

  it("a session with no user id refuses any claim (defensive — the middleware always sets one)", () => {
    expect(ownerAssertionFails("user-A", undefined)).toBe(true);
  });

  it("the replace body accepts an optional userId next to the ledger", () => {
    expect(replaceInput.safeParse({ ledger: EMPTY_LEDGER }).success).toBe(true);
    expect(replaceInput.safeParse({ ledger: EMPTY_LEDGER, userId: "user-A" }).success).toBe(true);
    expect(replaceInput.safeParse({ ledger: EMPTY_LEDGER, userId: "" }).success).toBe(false);
  });
});

/* ── The change journal is per-tenant (DB-backed: trigger + pull) ─────── */

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");
}

/** Same construction as db/client.ts — so the instance IS an `Executor`. */
const connect = (url: string) => {
  const client = postgres(url, { max: 2, onnotice: () => {} });
  return { client, db: drizzle(client, { schema: s }) };
};

let client: ReturnType<typeof connect>["client"];
let db: ReturnType<typeof connect>["db"];
let budgetA = "";
let budgetB = "";

/** An account + its own envelope group, so there is something to delete with a cascade. */
async function seedAccount(budgetId: string, name: string): Promise<string> {
  const [row] = await db
    .insert(s.accounts)
    .values({ budgetId, name })
    .returning({ id: s.accounts.id });
  return row!.id;
}

describe.skipIf(!TEST_URL)("sync/pull: the change journal is scoped to one budget", () => {
  beforeAll(async () => {
    ({ client, db } = connect(TEST_URL));
    await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
    const [user] = await db
      .insert(s.users)
      .values({ email: `pull-scope-${crypto.randomUUID()}@example.test` })
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

  it("the trigger attributes every logged row to its budget (and `budgets` to itself)", async () => {
    const accA = await seedAccount(budgetA, "A's wallet");
    const rows = await db
      .select({ budgetId: s.changes.budgetId, table: s.changes.tableName, rowId: s.changes.rowId })
      .from(s.changes)
      .where(eq(s.changes.rowId, accA));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.budgetId).toBe(budgetA);

    // the budgets table has its own trigger (0009) and no budget_id column — its tenant is itself
    await db.update(s.budgets).set({ currency: "EUR" }).where(eq(s.budgets.id, budgetB));
    const budgetRows = await db
      .select({ budgetId: s.changes.budgetId })
      .from(s.changes)
      .where(and(eq(s.changes.rowId, budgetB), eq(s.changes.tableName, "budgets")));
    expect(budgetRows.every((r) => r.budgetId === budgetB)).toBe(true);
    expect(budgetRows.length).toBeGreaterThan(0);
  });

  it("a tenant's delta carries NOTHING of another tenant's — not even its deletions", async () => {
    const accA = await seedAccount(budgetA, "A's account");
    const accB = await seedAccount(budgetB, "B's account");
    await db.delete(s.accounts).where(eq(s.accounts.id, accB)); // B deletes a row

    const deltaA = await pullChanges(db, budgetA, 0);
    const idsA = deltaA.map((ch) => (ch.op === "delete" ? ch.rowId : (ch.row as { id: string }).id));
    expect(idsA).toContain(accA); // A sees its own row…
    expect(idsA).not.toContain(accB); // …and NOT B's deletion (the leak this closes)
    expect(deltaA.some((ch) => ch.op === "delete")).toBe(false);

    // …while B's own delta does carry that tombstone (the delete must still replicate)
    const deltaB = await pullChanges(db, budgetB, 0);
    expect(deltaB.some((ch) => ch.op === "delete" && ch.rowId === accB)).toBe(true);
  });

  it("a FK cascade (account → its transactions) is attributed too", async () => {
    const acc = await seedAccount(budgetA, "cascade");
    const [txn] = await db
      .insert(s.transactions)
      .values({ budgetId: budgetA, type: "expense", accountId: acc, amount: 100, date: "2026-01-01" })
      .returning({ id: s.transactions.id });
    const before = await legacyChangesWatermark(db); // no legacy rows here — just a cheap probe
    expect(before).toBe(0);

    await db.delete(s.accounts).where(eq(s.accounts.id, acc)); // cascades to the transaction

    const delta = await pullChanges(db, budgetA, 0);
    expect(delta.some((ch) => ch.op === "delete" && ch.rowId === txn!.id)).toBe(true);
    const orphans = await db
      .select({ seq: s.changes.seq })
      .from(s.changes)
      .where(isNull(s.changes.budgetId));
    expect(orphans).toHaveLength(0); // nothing lands in the journal un-attributed
  });

  it("un-attributable pre-0015 rows raise the watermark (→ the pull answers resetRequired)", async () => {
    // 0015 backfills the journal only when the database holds exactly ONE budget. On a
    // multi-budget upgrade the old rows belong to nobody: they are invisible to a per-tenant
    // delta, so a client whose cursor sits BELOW them would silently lose its own changes.
    // The route turns `since < watermark` into resetRequired (a snapshot), never a lossy delta.
    const [row] = await db
      .insert(s.changes)
      .values({ tableName: "accounts", rowId: crypto.randomUUID(), op: "delete", budgetId: null })
      .returning({ seq: s.changes.seq });
    const mark = await legacyChangesWatermark(db);
    expect(mark).toBe(Number(row!.seq));
    expect(mark).toBeGreaterThan(0); // …so every cursor below it forces a snapshot

    await db.delete(s.changes).where(eq(s.changes.seq, row!.seq));
    expect(await legacyChangesWatermark(db)).toBe(0); // a clean journal costs nothing
  });
});
