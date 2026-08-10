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
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as s from "../db/schema";
import {
  applyPushOp,
  budgetAssertionFails,
  legacyChangesWatermark,
  ownerAssertionFails,
  pullChanges,
  pushInput,
  replaceInput,
} from "./sync";
// Constant + type only — this module's app/db imports are lazy (see the file header), so
// importing it here does NOT pull env/db/client into THIS process.
import { SENTINEL as REPLACE_SENTINEL, type ReplaceRecurrenceOutput } from "./sync.replace-recurrence-child";
import {
  SENTINEL as BARRIER_SENTINEL,
  type FirstUseBarrierOutput,
} from "./sync.first-use-barrier-child";

// The lock-order child forces real lock waits (bounded pg_locks polling) — beyond bun's
// 5 s default.
setDefaultTimeout(60_000);

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";

const EMPTY_LEDGER = {
  accounts: [],
  groups: [],
  envelopes: [],
  categories: [],
  places: [],
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

/* ── Retired op kinds dead-letter, never a silent false "applied" (pure — no DB touched) ──
 *
 * `recurrence.create/update/delete` still exist in shared's OpKind/opSchemas until a later task
 * removes them, so a well-formed payload passes schema validation — without an explicit guard,
 * applyOp's switch would have no matching case, silently do nothing, and the op would be
 * reported "applied". The assertion below only pins the OBSERVABLE outcome (rejected — the
 * client dead-letters it), not which code path produced it, so it stays valid once shared drops
 * the schemas too (at that point `opSchemas[kind]` is undefined and the `!schema` branch reaches
 * the same outcome on its own). */

describe("push: a retired op kind (recurrence.*) is rejected, never silently applied", () => {
  it("a well-formed recurrence.create op dead-letters as rejected — nothing is applied", async () => {
    const result = await applyPushOp("some-budget-id", "test-client", {
      opId: UUID_A,
      kind: "recurrence.create",
      // matches recurrencePayload.extend({id}) exactly — proves the rejection is NOT a
      // validation failure of a malformed payload, but the kind itself being retired
      payload: { id: UUID_B, rule: "monthly", startDate: "2026-01-01", endDate: null, pausedUntil: null },
    });
    expect(result.status).toBe("rejected");
  });

  it("recurrence.update and recurrence.delete dead-letter the same way", async () => {
    const update = await applyPushOp("some-budget-id", "test-client", {
      opId: UUID_A,
      kind: "recurrence.update",
      payload: { id: UUID_B, rule: "weekly" },
    });
    expect(update.status).toBe("rejected");

    const del = await applyPushOp("some-budget-id", "test-client", {
      opId: UUID_A,
      kind: "recurrence.delete",
      payload: { id: UUID_B },
    });
    expect(del.status).toBe("rejected");
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

/* ── Backup compat: pre-3.2 recurrence fields keep importing (forever guard) ──────
 *
 * The recurring-payments feature was removed from the API in stages (routes/sync
 * handlers/mappers, then the shared/db fields, then the `recurrences` table itself —
 * migration 0018). A JSON backup taken BEFORE that removal still carries `recurrences` and
 * per-transaction `planned`/`recurrenceId` — `/api/sync/replace` must keep accepting it,
 * because zod object schemas here are never `.strict()`: once a field is removed from
 * clientLedgerSchema, the same key simply becomes an unrecognized key that safeParse silently
 * strips instead of a validation failure. The invariant this test pins ("old backup keeps
 * importing") holds regardless of which stage of the removal is live. */

describe("backup-compat: pre-3.2 recurrence fields do not break /sync/replace", () => {
  it("a ledger carrying recurrences + a planned/recurrenceId transaction still validates", () => {
    const ledgerWithRecurrence = {
      ...EMPTY_LEDGER,
      recurrences: [
        { id: UUID_A, rule: "monthly", startDate: "2026-01-01", endDate: null, pausedUntil: null },
      ],
      transactions: [
        {
          id: UUID_B,
          type: "expense",
          accountId: UUID_A,
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
          planned: false,
          recurrenceId: null,
          items: [],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    expect(replaceInput.safeParse({ ledger: ledgerWithRecurrence }).success).toBe(true);
  });
});

/* ── The change journal is per-tenant (DB-backed: trigger + pull) ─────── */

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");
}

const REPLACE_CHILD = new URL("./sync.replace-recurrence-child.ts", import.meta.url).pathname;

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

  /* ── Backup compat, exercised end-to-end through the real route (forever guard) ──
   *
   * The schema-level assertion above (describe("backup-compat: …")) only proves
   * `replaceInput.safeParse` accepts pre-3.2 recurrence fields — it never proves the ACTUAL
   * /api/sync/replace HANDLER does the right thing with them (real `db.transaction`, real
   * `restoreLedger`/`insertLedger`). That means a REAL Postgres write, and `routes/sync.ts`
   * (imported by this very file, above) already pins `db/client.ts`'s pool to whatever
   * `DATABASE_URL` resolves to for the WHOLE test process the moment it's first imported —
   * locally (and on a real deployment host) that is the real database, not `TEST_DATABASE_URL`
   * (see auth.signup-race-child.ts, which hit the identical hazard first). So this runs in a
   * CHILD process that gets `DATABASE_URL` handed to it explicitly, with a fuse that refuses to
   * write unless it matches the throwaway Postgres this suite migrated. */
  it("POST /api/sync/replace (child process): a ledger with pre-3.2 recurrence fields imports cleanly — the unknown keys are silently dropped", async () => {
    const child = Bun.spawn([process.execPath, REPLACE_CHILD], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL: TEST_URL, EXPECT_DATABASE_URL: TEST_URL },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const code = await child.exited;
    const line = stdout.split("\n").find((l) => l.startsWith(REPLACE_SENTINEL));
    if (code !== 0 || !line) {
      throw new Error(`sync-replace-recurrence child failed (exit ${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    const out = JSON.parse(line.slice(REPLACE_SENTINEL.length)) as ReplaceRecurrenceOutput;

    expect(out.status).toBe(200);
    expect(out.responseBudgetId).toBe(out.budgetId);
    // The `recurrences` table and the transaction's `planned`/`recurrenceId` columns are gone
    // (migration 0018) — there is nowhere left for the pre-3.2 `recurrences` key or the
    // transaction's `planned`/`recurrenceId` fields to land; zod strips them as unrecognized,
    // and the transaction itself still imports correctly.
    // The fixture submits THREE transactions, and the two legacy fields it exercises behave
    // OPPOSITELY:
    //  - `planned: true` (amount 999999) is a legacy recurring-payments TEMPLATE row that was
    //    always excluded from every ledger computation — clientLedgerSchema's preprocess must
    //    drop it before `restoreLedger` ever sees it, so it must NOT land.
    //  - `confirmed: false` (amount 777) is the removed transaction-confirmation flag (API task
    //    2) — unlike `planned`, `confirmed` never excluded a row from any computation (every
    //    transaction always counted in balances), so once the field is gone from
    //    `transactionEntity`, zod silently strips the now-unrecognized key and the row MUST land
    //    as an ordinary transaction, same as the real one (amount 500).
    // → exactly TWO rows (500 and 777) land in the DB, not three, and never 999999.
    expect(out.transactionRows).toHaveLength(2);
    expect(out.transactionRows.map((r) => r.amount).sort((a, b) => a - b)).toEqual([500, 777]);
    expect(out.transactionRows.every((r) => r.amount !== 999999)).toBe(true);
    // GROUND TRUTH, not just "the code doesn't reference it": query information_schema
    // directly, so a future re-introduction of `recurrences` fails this test loudly instead of
    // the guard quietly losing its teeth (it did once — see migration 0018's fix-up commit).
    expect(out.recurrencesTableExists).toBe(false);
    expect(out.transactionsPlannedColumnExists).toBe(false);
    expect(out.transactionsRecurrenceIdColumnExists).toBe(false);
  });
});

/* ── Lock order: first-use snapshot/pull/replace vs. a concurrent initializer (§0b) ──────
 *
 * An initializer's order is operation lock → shared changes lock (the budget INSERT fires
 * `log_change()`). Snapshot/pull/replace take the EXCLUSIVE changes lock for their cursor
 * barrier — if they lazily created the budget INSIDE that transaction, their order would be the
 * exact inverse and a concurrent initializer would deadlock with them. The routes must instead
 * ensure the initial budget through the STANDALONE operation-lock path BEFORE the barrier and
 * resolve only an EXISTING budget inside it (requireExistingTier).
 *
 * The child (sync.first-use-barrier-child.ts) FORCES the interleaving: a gate holds the fresh
 * user's ensure-initial lock, all three routes are fired and observed parked on the OPERATION
 * lock via pg_locks (changes-cursor waiters excluded), the changes lock is probed FREE at that
 * moment, then the gate inserts the budget (shared changes lock — must not deadlock) and
 * commits. */

const BARRIER_CHILD = new URL("./sync.first-use-barrier-child.ts", import.meta.url).pathname;

describe.skipIf(!TEST_URL)(
  "sync first use: ensure-initial runs BEFORE the cursor barrier (no deadlock, no split budget)",
  () => {
    let out: FirstUseBarrierOutput;

    beforeAll(async () => {
      const barrierClient = postgres(TEST_URL, { max: 1, onnotice: () => {} });
      await migrate(drizzle(barrierClient, { schema: s }), {
        migrationsFolder: new URL("../../drizzle", import.meta.url).pathname,
      });
      await barrierClient.end({ timeout: 5 });

      const child = Bun.spawn([process.execPath, BARRIER_CHILD], {
        cwd: new URL("../..", import.meta.url).pathname,
        env: { ...process.env, DATABASE_URL: TEST_URL, EXPECT_DATABASE_URL: TEST_URL },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const code = await child.exited;
      const line = stdout.split("\n").find((l) => l.startsWith(BARRIER_SENTINEL));
      if (code !== 0 || !line) {
        throw new Error(
          `first-use-barrier child failed (exit ${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
      }
      out = JSON.parse(line.slice(BARRIER_SENTINEL.length)) as FirstUseBarrierOutput;
    });

    it("all three routes really parked on the OPERATION lock (the interleaving was forced)", () => {
      expect(out.parkedBeforeBarrier).toBe(true);
    });

    it("none of them held the exclusive changes-cursor lock while waiting", () => {
      expect(out.changesLockFreeWhileParked).toBe(true);
    });

    it("the concurrent initializer's insert (shared changes lock) did not deadlock", () => {
      expect(out.gateInsertCompleted).toBe(true);
    });

    it("snapshot, pull and replace all finish 200 on the initializer's budget", () => {
      expect(out.snapshotStatus).toBe(200);
      expect(out.pullStatus).toBe(200);
      expect(out.replaceStatus).toBe(200);
      expect(out.snapshotBudgetId).toBe(out.gateBudgetId);
      expect(out.pullBudgetId).toBe(out.gateBudgetId);
      expect(out.replaceBudgetId).toBe(out.gateBudgetId);
    });

    it("exactly one budget row — no split across budget ids", () => {
      expect(out.budgetRowCount).toBe(1);
    });
  },
);
