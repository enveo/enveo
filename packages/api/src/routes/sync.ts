/**
 * Local-first sync endpoints: snapshot / pull (delta from the `changes` log) /
 * push (idempotent ops from the client's outbox).
 *
 * Every response carries `budgetId` — the epoch marker: a DB wipe+reseed yields
 * a new `budgets.id`, and on mismatch the client does a fullResync().
 */
import {
  clientLedgerSchema,
  opSchemas,
  REPLICATED_TABLES,
  type ClientLedgerInput,
  type OpKind,
  type OpPayload,
  type ReplicatedTable,
} from "@enveo/shared";
import { and, eq, gt, inArray, sql as dsql } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import { z } from "zod";
import { requireTier, sessionUserId } from "../context";
import { db } from "../db/client";
import * as s from "../db/schema";
import {
  applyAccountCreate,
  applyAccountDelete,
  applyAccountUpdate,
  applyAllocSet,
  applyBudgetUpdate,
  applyCategoryCreate,
  applyEnvelopeCreate,
  applyEnvelopeDelete,
  applyEnvelopeUpdate,
  applyGroupCreate,
  applyGroupDelete,
  applyGroupUpdate,
  applyPlaceCreate,
  applyTxnCreate,
  applyTxnDelete,
  applyTxnUpdate,
  findForeignLedgerRef,
  NOT_FOUND,
  ScopeViolation,
  wipeBudgetData,
  type Executor,
} from "../sync/apply";
import { claimOp } from "../sync/idempotency";
import {
  loadClientLedger,
  mapAccount,
  mapAllocation,
  mapBudget,
  mapCategory,
  mapEnvelope,
  mapGroup,
  mapPlace,
  mapTransaction,
  mapTxnItem,
} from "../repo";

export const syncRoutes = new Hono();

/**
 * Cursor barrier — the counterpart of the SHARED lock taken in the
 * `log_change()` triggers on every insert into `changes` (migration 0005; the
 * key must match). `seq` (BIGSERIAL) is assigned at INSERT but visible after
 * COMMIT, so a bare MAX(seq) could skip past the seq of an in-flight
 * transaction — the client got a cursor too high and would NEVER fetch that
 * change. The EXCLUSIVE lock waits until every transaction with an assigned seq
 * finishes, and holds off new writes until the end of our transaction: MAX(seq)
 * then sees every assigned seq, and the data selects are consistent with the
 * cursor.
 *
 * MUST be the FIRST statement of the transaction and requires the default read
 * committed (fresh snapshot per statement): a repeatable-read snapshot would be
 * taken BEFORE acquiring the lock and would lose writes committed while waiting.
 */
async function lockChangesCursor(x: Executor): Promise<void> {
  await x.execute(dsql`SELECT pg_advisory_xact_lock(hashtext('enveo:changes')::bigint)`);
}

/** COALESCE(MAX(seq),0) — change-log cursor; call AFTER `lockChangesCursor`. */
async function maxSeq(x: Executor): Promise<number> {
  const [row] = await x
    .select({ cursor: dsql<number>`COALESCE(MAX(${s.changes.seq}), 0)`.mapWith(Number) })
    .from(s.changes);
  return row?.cursor ?? 0;
}

/* ── GET /sync/snapshot — full replica + cursor, consistently (cursor barrier) ── */

syncRoutes.get("/sync/snapshot", async (c) => {
  const { budgetId, cursor, ledger } = await db.transaction(async (tx) => {
    await lockChangesCursor(tx);
    const budgetId = (await requireTier(c, "plain", tx)).id;
    return { budgetId, cursor: await maxSeq(tx), ledger: await loadClientLedger(tx, budgetId) };
  });
  return c.json({ budgetId, cursor, ...ledger });
});

/* ── GET /sync/pull?since=<seq> — delta with per-row coalescing ─────── */

type PullChange =
  | { seq: number; table: ReplicatedTable; op: "upsert"; row: unknown }
  | { seq: number; table: ReplicatedTable; op: "delete"; rowId: string };

/** Current table rows (mapped to shared types), by id. */
async function loadCurrentRows(
  x: Executor,
  budgetId: string,
  table: ReplicatedTable,
  ids: string[],
): Promise<Map<string, unknown>> {
  switch (table) {
    case "accounts": {
      const rows = await x
        .select()
        .from(s.accounts)
        .where(and(eq(s.accounts.budgetId, budgetId), inArray(s.accounts.id, ids)));
      return new Map(rows.map((r) => [r.id, mapAccount(r)]));
    }
    case "envelope_groups": {
      const rows = await x
        .select()
        .from(s.envelopeGroups)
        .where(and(eq(s.envelopeGroups.budgetId, budgetId), inArray(s.envelopeGroups.id, ids)));
      return new Map(rows.map((r) => [r.id, mapGroup(r)]));
    }
    case "envelopes": {
      const rows = await x
        .select()
        .from(s.envelopes)
        .where(and(eq(s.envelopes.budgetId, budgetId), inArray(s.envelopes.id, ids)));
      return new Map(rows.map((r) => [r.id, mapEnvelope(r)]));
    }
    case "categories": {
      const rows = await x
        .select()
        .from(s.categories)
        .where(and(eq(s.categories.budgetId, budgetId), inArray(s.categories.id, ids)));
      return new Map(rows.map((r) => [r.id, mapCategory(r)]));
    }
    case "places": {
      const rows = await x
        .select()
        .from(s.places)
        .where(and(eq(s.places.budgetId, budgetId), inArray(s.places.id, ids)));
      return new Map(rows.map((r) => [r.id, mapPlace(r)]));
    }
    case "transactions": {
      const [rows, itemRows] = await Promise.all([
        x
          .select()
          .from(s.transactions)
          .where(and(eq(s.transactions.budgetId, budgetId), inArray(s.transactions.id, ids))),
        x.select().from(s.txnItems).where(inArray(s.txnItems.transactionId, ids)),
      ]);
      const itemsByTxn = new Map<string, ReturnType<typeof mapTxnItem>[]>();
      for (const it of itemRows) {
        const arr = itemsByTxn.get(it.transactionId) ?? [];
        arr.push(mapTxnItem(it));
        itemsByTxn.set(it.transactionId, arr);
      }
      return new Map(rows.map((r) => [r.id, mapTransaction(r, itemsByTxn.get(r.id) ?? [])]));
    }
    case "allocations": {
      const rows = await x
        .select()
        .from(s.allocations)
        .where(and(eq(s.allocations.budgetId, budgetId), inArray(s.allocations.id, ids)));
      return new Map(rows.map((r) => [r.id, mapAllocation(r)]));
    }
    case "budgets": {
      const rows = await x
        .select()
        .from(s.budgets)
        .where(and(eq(s.budgets.id, budgetId), inArray(s.budgets.id, ids)));
      return new Map(rows.map((r) => [r.id, mapBudget(r)]));
    }
    default:
      // a table this switch does not (or no longer) handle — no application code writes it
      // any more, so there is no current row to serve; the caller treats a missing map entry
      // the same as "upsert with no existing row" (defense).
      return new Map();
  }
}

const isReplicated = (t: string): t is ReplicatedTable =>
  (REPLICATED_TABLES as readonly string[]).includes(t);

/**
 * The highest seq of a change row that carries NO budget (pre-0015 — the journal used to be
 * global). Such a row cannot be attributed to a tenant, so it can neither be served nor safely
 * skipped: a client whose cursor sits BELOW it would silently lose its own changes. It gets a
 * `resetRequired` (snapshot) instead. 0 on every database migrated from a single-budget install
 * (0015 backfills those) and on every fresh one — the partial index makes this ~free.
 */
export async function legacyChangesWatermark(x: Executor): Promise<number> {
  const [row] = await x
    .select({ seq: dsql<number>`COALESCE(MAX(${s.changes.seq}), 0)`.mapWith(Number) })
    .from(s.changes)
    .where(dsql`${s.changes.budgetId} is null`);
  return row?.seq ?? 0;
}

/**
 * The delta for ONE budget: change rows of THAT budget only (§4 — the journal is per-tenant
 * since 0015), coalesced per (table, row), materialized as upsert rows / delete tombstones.
 * Exported for the DB-backed tests: this is where tenant isolation of the pull lives.
 */
export async function pullChanges(
  x: Executor,
  budgetId: string,
  since: number,
): Promise<PullChange[]> {
  const rows = await x
    .select()
    .from(s.changes)
    .where(and(gt(s.changes.seq, since), eq(s.changes.budgetId, budgetId)))
    .orderBy(s.changes.seq);

  // coalescing per (table, row) — the newest entry wins
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latest.set(`${r.tableName}|${r.rowId}`, r);

  // batches of ids to fetch current rows for, per table
  const upsertIds = new Map<ReplicatedTable, string[]>();
  for (const r of latest.values()) {
    if (r.op !== "upsert" || !isReplicated(r.tableName)) continue;
    const arr = upsertIds.get(r.tableName) ?? [];
    arr.push(r.rowId);
    upsertIds.set(r.tableName, arr);
  }
  const currentByTable = new Map<ReplicatedTable, Map<string, unknown>>();
  for (const [table, ids] of upsertIds) {
    currentByTable.set(table, await loadCurrentRows(x, budgetId, table, ids));
  }

  const changes: PullChange[] = [];
  for (const r of [...latest.values()].sort((a, b) => a.seq - b.seq)) {
    if (!isReplicated(r.tableName)) continue; // defense: unknown table in the log
    if (r.op === "delete") {
      changes.push({ seq: r.seq, table: r.tableName, op: "delete", rowId: r.rowId });
      continue;
    }
    const row = currentByTable.get(r.tableName)?.get(r.rowId);
    if (row === undefined) continue; // upsert with no existing row — skip (defense)
    changes.push({ seq: r.seq, table: r.tableName, op: "upsert", row });
  }
  return changes;
}

syncRoutes.get("/sync/pull", async (c) => {
  const since = Number(c.req.query("since"));
  if (!Number.isInteger(since) || since < 0) {
    return c.json({ error: "since must be an integer ≥ 0" }, 400);
  }

  const { budgetId, ...result } = await db.transaction(
    async (tx) => {
      await lockChangesCursor(tx);
      const budgetId = (await requireTier(c, "plain", tx)).id;
      const cursor = await maxSeq(tx);
      // client is ahead of a log that no longer exists (server reset / future pruning), or its
      // cursor predates the un-attributable pre-0015 rows → full snapshot instead of a delta
      if (since > cursor || since < (await legacyChangesWatermark(tx))) {
        return { budgetId, cursor, resetRequired: true, changes: [] as PullChange[] };
      }
      return {
        budgetId,
        cursor,
        resetRequired: false,
        changes: await pullChanges(tx, budgetId, since),
      };
    },
  );

  return c.json({ budgetId, ...result });
});

/* ── POST /sync/push — idempotent ops, sequential, atomic per op ────── */

export const pushInput = z.object({
  clientId: z.string().min(1),
  /** The budget the CLIENT believes it is writing to — see budgetAssertionFails. Optional:
   *  a pre-2.0 client omits it, and so does a legacy e2ee replica that cannot name its budget. */
  budgetId: z.string().uuid().optional(),
  ops: z
    .array(z.object({ opId: z.string().uuid(), kind: z.string(), payload: z.unknown() }))
    .max(100),
});

/**
 * PER-REQUEST tenant assertion (spec §4). The server resolves the target budget from the
 * session cookie alone, and the client's own identity guard runs once per SYNC CYCLE — but one
 * cycle pushes many batches, and the cookie is shared by every tab on the device: a sign-out +
 * sign-in in another tab swaps the session BETWEEN two batches, and the rest of user A's outbox
 * would be applied to user B's budget (fresh creates pass every FK guard — those only reject
 * references to another budget's EXISTING rows). So each push NAMES the budget it is for, and a
 * mismatch is refused with 409 { error: "budget_mismatch" } BEFORE anything is written.
 */
export function budgetAssertionFails(claimed: string | undefined, resolved: string): boolean {
  return claimed !== undefined && claimed !== resolved;
}

/**
 * PER-REQUEST tenant assertion for the full-budget OVERWRITE routes (/sync/replace,
 * /sync2/reset, /budget/e2ee/enable, /budget/e2ee/disable). Same threat as on push — the server
 * resolves the target from the session cookie alone, the cookie is shared by every tab, and the
 * client's identity check happens BEFORE the upload (serializing and shipping a whole ledger
 * takes seconds on mobile) — but the blast radius is the entire budget: restoreLedger wipes it
 * and rebuilds it from the body. So the client NAMES the tenant it just verified and the server
 * refuses a mismatch BEFORE any write.
 *
 * The tenant is the USER, not the budget: `budgets.id` is the replica EPOCH marker (lazy budget
 * creation, wipe+reseed and a DB restore all mint a new one — see context.ts), and on the very
 * path these routes serve, a restore, the client's replica DELIBERATELY carries the BACKUP
 * FILE's budgetId (web/lib/data.ts) — the id of the budget the file came from, which is exactly
 * NOT the session's. Asserting the budget here would therefore refuse every restore of a backup
 * taken from another install. The session user id is what the client's guard actually verified
 * (fetchSessionUserId) and what a mid-flight cookie swap changes.
 */
export function ownerAssertionFails(
  claimed: string | undefined,
  sessionUser: string | undefined,
): boolean {
  return claimed !== undefined && claimed !== sessionUser;
}

/** Domain rejection (entity does not exist) — rolls back the op's transaction. */
class OpNotFound extends Error {
  constructor() {
    super(NOT_FOUND);
  }
}

/**
 * Is the error a DETERMINISTIC domain refusal (the op is bad, a retry changes
 * nothing)? Only such errors map to status "rejected" (client: dead-letter).
 * Infrastructure errors (dropped connection, deadlock, pool timeout etc.) go
 * up as 5xx — the client retries the batch, and the `sync_ops` guard makes the
 * retry safe (already-applied ops get "duplicate").
 */
function isDomainRejection(e: unknown): boolean {
  if (e instanceof OpNotFound) return true;
  // cross-budget FK in the op body — permanent refusal, never retriable
  if (e instanceof ScopeViolation) return true;
  // SQLSTATE class 23 = constraint violation (PK/FK/CHECK/NOT NULL),
  // class 22 = bad data (e.g. invalid UUID/date format)
  return (
    e instanceof postgres.PostgresError && (e.code.startsWith("23") || e.code.startsWith("22"))
  );
}

async function applyOp(x: Executor, budgetId: string, kind: OpKind, payload: unknown): Promise<void> {
  const ensure = (r: unknown) => {
    if (r === NOT_FOUND) throw new OpNotFound();
  };
  switch (kind) {
    case "txn.create":
      await applyTxnCreate(x, budgetId, payload as OpPayload<"txn.create">);
      return;
    case "txn.update":
      ensure(await applyTxnUpdate(x, budgetId, payload as OpPayload<"txn.update">));
      return;
    case "txn.delete":
      await applyTxnDelete(x, budgetId, (payload as OpPayload<"txn.delete">).id);
      return;
    case "alloc.set":
      await applyAllocSet(x, budgetId, payload as OpPayload<"alloc.set">);
      return;
    case "account.create":
      await applyAccountCreate(x, budgetId, payload as OpPayload<"account.create">);
      return;
    case "account.update":
      ensure(await applyAccountUpdate(x, budgetId, payload as OpPayload<"account.update">));
      return;
    case "account.delete":
      await applyAccountDelete(x, budgetId, (payload as OpPayload<"account.delete">).id);
      return;
    case "group.create":
      await applyGroupCreate(x, budgetId, payload as OpPayload<"group.create">);
      return;
    case "group.update":
      ensure(await applyGroupUpdate(x, budgetId, payload as OpPayload<"group.update">));
      return;
    case "group.delete":
      await applyGroupDelete(x, budgetId, (payload as OpPayload<"group.delete">).id);
      return;
    case "envelope.create":
      await applyEnvelopeCreate(x, budgetId, payload as OpPayload<"envelope.create">);
      return;
    case "envelope.update":
      ensure(await applyEnvelopeUpdate(x, budgetId, payload as OpPayload<"envelope.update">));
      return;
    case "envelope.delete":
      await applyEnvelopeDelete(x, budgetId, (payload as OpPayload<"envelope.delete">).id);
      return;
    case "category.create":
      await applyCategoryCreate(x, budgetId, payload as OpPayload<"category.create">);
      return;
    case "place.create":
      await applyPlaceCreate(x, budgetId, payload as OpPayload<"place.create">);
      return;
    case "budget.update": {
      // scoped to the own budget — a foreign id is a permanent refusal (dead-letter)
      const p = payload as OpPayload<"budget.update">;
      ensure(p.id === budgetId ? await applyBudgetUpdate(x, budgetId, p.currency) : NOT_FOUND);
      return;
    }
  }
}

type PushResult = { opId: string; status: "applied" | "duplicate" | "rejected"; error?: string };

/**
 * Op kinds a client may still have QUEUED from before a feature was removed from the API.
 * `OpKind`/`opSchemas` (shared) still declare these until a later task drops the schemas
 * entirely — until then, the `!schema` check below finds a schema, a well-formed payload
 * parses, and `applyOp`'s switch has no matching case: it silently falls through and returns,
 * so the op would be reported "applied" while nothing was persisted (a false success the
 * client never dead-letters, and a permanent, invisible divergence from the server).
 *
 * Retired kinds must therefore take the SAME observable path as an unrecognized kind: the
 * client dead-letters "rejected" the same way either way. This set is deliberately checked
 * BEFORE the schema lookup so the outcome doesn't depend on `opSchemas` still knowing the kind
 * — once shared drops the schemas too, `opSchemas[kind]` becomes undefined and the `!schema`
 * branch reaches the identical outcome on its own; this check just makes it true NOW.
 *
 * Currently: the recurring-payments feature (routes/sync handlers/mappers already removed).
 */
const RETIRED_OP_KINDS = new Set<string>(["recurrence.create", "recurrence.update", "recurrence.delete"]);

/**
 * Applies one push op and returns its result — never throws for a domain rejection (those map
 * to `status: "rejected"`); an infrastructure error still propagates (5xx, client retries).
 * Exported for tests: a retired or unrecognized kind rejects WITHOUT touching the database, so
 * it is testable without a live Postgres.
 */
export async function applyPushOp(
  budgetId: string,
  clientId: string,
  op: { opId: string; kind: string; payload?: unknown },
): Promise<PushResult> {
  if (RETIRED_OP_KINDS.has(op.kind)) {
    // pre-removal client, queued before the feature went away — dead-letter it exactly like an
    // unknown kind (below): never a silent "applied" no-op.
    return { opId: op.opId, status: "rejected", error: `unknown kind: ${op.kind}` };
  }
  const schema = (opSchemas as Record<string, z.ZodTypeAny>)[op.kind];
  if (!schema) {
    return { opId: op.opId, status: "rejected", error: `unknown kind: ${op.kind}` };
  }
  const parsed = schema.safeParse(op.payload);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { opId: op.opId, status: "rejected", error: `validation: ${detail}` };
  }
  try {
    const status = await db.transaction(async (tx) => {
      // idempotency guard in the SAME transaction as the op application;
      // a rollback (rejected) also takes the sync_ops row with it
      const fresh = await claimOp(tx, { opId: op.opId, budgetId, clientId, kind: op.kind });
      if (!fresh) return "duplicate" as const;
      await applyOp(tx, budgetId, op.kind as OpKind, parsed.data);
      return "applied" as const;
    });
    return { opId: op.opId, status };
  } catch (e) {
    // a domain rejection does NOT abort the rest of the batch; an infrastructure
    // error DOES (5xx from app.onError) — "rejected" means a permanent refusal to the client
    if (!isDomainRejection(e)) throw e;
    const error = e instanceof OpNotFound ? NOT_FOUND : ((e as Error).message ?? "internal");
    return { opId: op.opId, status: "rejected", error };
  }
}

syncRoutes.post("/sync/push", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const body = pushInput.parse(await c.req.json());
  // the session's budget is not the one this replica is pushing to → write NOTHING
  if (budgetAssertionFails(body.budgetId, budgetId)) {
    return c.json({ error: "budget_mismatch", budgetId }, 409);
  }

  const results: PushResult[] = [];
  // STRICTLY sequential — client op order = application order (LWW)
  for (const op of body.ops) {
    results.push(await applyPushOp(budgetId, body.clientId, op));
  }
  return c.json({ budgetId, results });
});

/* ── POST /sync/replace — full replacement of a budget's replica (backup/restore, wipe) ──

   Body: { ledger: ClientLedger }. In ONE transaction: WIPE the budget's data
   (FK-safe order) → INSERT all entities PRESERVING ids (transactions also
   createdAt/tag). Allocation and split-item ids are NOT preserved (they may be
   synthetic from offline mode — the server assigns uuids).
   Transactions' source_ref/external_id are NOT in ClientLedger → a known,
   accepted loss (import matching starts from zero after restore).

   An empty ledger = a clean server wipe (used by "local only" mode).
   Returns { budgetId, cursor } — the client sets this cursor locally (server ==
   local, no pull needed). Validation / FK violation → 400 (the whole
   transaction rolls back — atomically). */

export const replaceInput = z.object({
  ledger: clientLedgerSchema,
  /** The tenant the CLIENT verified right before this upload — see ownerAssertionFails.
   *  Optional: a pre-2.0 client omits it (and then nothing can be asserted). */
  userId: z.string().min(1).optional(),
});

/** Splits an array into chunks of `n` (bulk insert without oversized queries). */
const chunk = <T,>(arr: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, (i + 1) * n));

async function insertLedger(x: Executor, budgetId: string, ledger: ClientLedgerInput): Promise<void> {
  // §4.2 scope guard for the restore path: every FK must point INSIDE the
  // payload (ids are preserved on insert and the budget was just wiped) — a
  // foreign UUID would otherwise attach restored rows to ANOTHER budget's
  // entities, bypassing assertBudgetFks through this door.
  if (findForeignLedgerRef(ledger) !== null) throw new ScopeViolation();
  // FK-safe order: accounts → groups → envelopes → categories → places →
  // allocations → transactions → split items
  for (const part of chunk(ledger.accounts, 300)) {
    await x.insert(s.accounts).values(
      part.map((a) => ({
        id: a.id,
        budgetId,
        name: a.name,
        color: a.color,
        icon: a.icon,
        type: a.type,
        onBudget: a.onBudget,
        initialBalance: a.initialBalance,
        archived: a.archived,
        sort: a.sort,
      })),
    );
  }
  for (const part of chunk(ledger.groups, 500)) {
    await x.insert(s.envelopeGroups).values(part.map((g) => ({ id: g.id, budgetId, name: g.name, sort: g.sort })));
  }
  for (const part of chunk(ledger.envelopes, 500)) {
    await x.insert(s.envelopes).values(
      part.map((e) => ({
        id: e.id,
        budgetId,
        groupId: e.groupId,
        name: e.name,
        color: e.color,
        icon: e.icon,
        note: e.note,
        monthlyTarget: e.monthlyTarget ?? null,
        isSavings: e.isSavings ?? false,
        sort: e.sort,
        archived: e.archived,
      })),
    );
  }
  for (const part of chunk(ledger.categories, 500)) {
    await x.insert(s.categories).values(part.map((cat) => ({ id: cat.id, budgetId, name: cat.name })));
  }
  for (const part of chunk(ledger.places, 500)) {
    await x.insert(s.places).values(part.map((p) => ({ id: p.id, budgetId, name: p.name })));
  }
  // Scope guard: an allocation may only reference an envelope of THIS budget
  // (just inserted above) — a foreign envelopeId is silently dropped instead of
  // hijacking another budget's allocation row via the (envelopeId, month) unique.
  const ownEnvIds = new Set(
    (await x.select({ id: s.envelopes.id }).from(s.envelopes).where(eq(s.envelopes.budgetId, budgetId))).map(
      (r) => r.id,
    ),
  );
  const ownAllocs = ledger.allocations.filter((a) => ownEnvIds.has(a.envelopeId));
  for (const part of chunk(ownAllocs, 500)) {
    // allocation ids are NOT preserved (natural key env+month; may be synthetic)
    await x.insert(s.allocations).values(
      part.map((a) => ({ budgetId, envelopeId: a.envelopeId, month: a.month, amount: a.amount })),
    );
  }
  for (const part of chunk(ledger.transactions, 300)) {
    await x.insert(s.transactions).values(
      part.map((t) => ({
        id: t.id,
        budgetId,
        type: t.type,
        accountId: t.accountId,
        toAccountId: t.toAccountId,
        amount: t.amount,
        date: t.date,
        confirmed: t.confirmed,
        isRefund: t.isRefund,
        envelopeId: t.envelopeId,
        placeId: t.placeId,
        categoryId: t.categoryId,
        name: t.name,
        note: t.note,
        tag: t.tag, // preserved (it is in ClientLedger); source_ref/external_id are not
        createdAt: t.createdAt,
      })),
    );
    // split items — fresh ids (they may be synthetic in the ledger)
    const items = part.flatMap((t) =>
      t.items.map((it) => ({ transactionId: t.id, envelopeId: it.envelopeId, categoryId: it.categoryId, amount: it.amount })),
    );
    for (const ipart of chunk(items, 500)) {
      if (ipart.length > 0) await x.insert(s.txnItems).values(ipart);
    }
  }
}

/**
 * Restore the budget's plaintext data from a client ledger — SHARED between
 * `/sync/replace` and `/budget/e2ee/disable` (sync2). Call INSIDE a transaction:
 * wipe (FK-safe) → insert the whole ledger → currency from the backup (if carried).
 */
export async function restoreLedger(
  x: Executor,
  budgetId: string,
  ledger: ClientLedgerInput,
): Promise<void> {
  await wipeBudgetData(x, budgetId);
  await insertLedger(x, budgetId, ledger);
  // currency from the backup — only when the backup carries it (old backups lack `budgets`)
  if (ledger.budgets?.[0]?.currency) {
    await x
      .update(s.budgets)
      .set({ currency: ledger.budgets[0].currency })
      .where(eq(s.budgets.id, budgetId));
  }
}

syncRoutes.post("/sync/replace", async (c) => {
  const parsed = replaceInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    // stable machine CODE + structured detail — the wording (and its locale) belongs to the client
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return c.json({ error: "backup_invalid", detail }, 400);
  }
  const { ledger, userId } = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      // Cursor barrier FIRST (like snapshot/pull) — the exclusive lock is held
      // until COMMIT: no concurrent push can weave in between our wipe and the
      // cursor read, and maxSeq after the inserts sees every seq we assigned.
      await lockChangesCursor(tx);
      const budgetId = (await requireTier(c, "plain", tx)).id;
      // PER-REQUEST tenant assertion — BEFORE the wipe: the session may have been swapped in
      // another tab while this (possibly large) ledger was being serialized and uploaded, and
      // this route REPLACES the resolved budget wholesale. Mismatch ⇒ write nothing.
      if (ownerAssertionFails(userId, sessionUserId(c))) return { mismatch: true, budgetId } as const;
      await restoreLedger(tx, budgetId, ledger);
      return { mismatch: false, budgetId, cursor: await maxSeq(tx) } as const;
    });
    if (result.mismatch) return c.json({ error: "budget_mismatch", budgetId: result.budgetId }, 409);
    return c.json({ budgetId: result.budgetId, cursor: result.cursor });
  } catch (e) {
    // ScopeViolation: a FK inside the payload points OUTSIDE it (foreign/corrupt file);
    // PostgresError class 23/22: constraint violation (FK/PK/CHECK) or bad data.
    // Either way the whole transaction rolled back (atomically).
    if (
      e instanceof ScopeViolation ||
      (e instanceof postgres.PostgresError && (e.code.startsWith("23") || e.code.startsWith("22")))
    ) {
      // same code the global onError uses for a ScopeViolation (index.ts) — one meaning, one code
      return c.json({ error: "foreign_ref" }, 400);
    }
    throw e;
  }
});
