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
import { requireTier } from "../context";
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
  applyRecurrenceCreate,
  applyRecurrenceDelete,
  applyRecurrenceUpdate,
  applyTxnCreate,
  applyTxnDelete,
  applyTxnUpdate,
  NOT_FOUND,
  ScopeViolation,
  wipeBudgetData,
  type Executor,
} from "../sync/apply";
import {
  loadClientLedger,
  mapAccount,
  mapAllocation,
  mapBudget,
  mapCategory,
  mapEnvelope,
  mapGroup,
  mapPlace,
  mapRecurrence,
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
    case "recurrences": {
      const rows = await x
        .select()
        .from(s.recurrences)
        .where(and(eq(s.recurrences.budgetId, budgetId), inArray(s.recurrences.id, ids)));
      return new Map(rows.map((r) => [r.id, mapRecurrence(r)]));
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
  }
}

const isReplicated = (t: string): t is ReplicatedTable =>
  (REPLICATED_TABLES as readonly string[]).includes(t);

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
      // client is ahead of a log that no longer exists (server reset / future pruning)
      if (since > cursor) {
        return { budgetId, cursor, resetRequired: true, changes: [] as PullChange[] };
      }

      const rows = await tx
        .select()
        .from(s.changes)
        .where(gt(s.changes.seq, since))
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
        currentByTable.set(table, await loadCurrentRows(tx, budgetId, table, ids));
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
      return { budgetId, cursor, resetRequired: false, changes };
    },
  );

  return c.json({ budgetId, ...result });
});

/* ── POST /sync/push — idempotent ops, sequential, atomic per op ────── */

const pushInput = z.object({
  clientId: z.string().min(1),
  ops: z
    .array(z.object({ opId: z.string().uuid(), kind: z.string(), payload: z.unknown() }))
    .max(100),
});

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
    case "recurrence.create":
      await applyRecurrenceCreate(x, budgetId, payload as OpPayload<"recurrence.create">);
      return;
    case "recurrence.update":
      // unknown id → no-op (parity with shared/applyOp), not a refusal
      await applyRecurrenceUpdate(x, budgetId, payload as OpPayload<"recurrence.update">);
      return;
    case "recurrence.delete":
      // FK transactions.recurrence_id = ON DELETE SET NULL — transactions stay
      await applyRecurrenceDelete(x, budgetId, (payload as OpPayload<"recurrence.delete">).id);
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

syncRoutes.post("/sync/push", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const body = pushInput.parse(await c.req.json());

  const results: PushResult[] = [];
  // STRICTLY sequential — client op order = application order (LWW)
  for (const op of body.ops) {
    const schema = (opSchemas as Record<string, z.ZodTypeAny>)[op.kind];
    if (!schema) {
      results.push({ opId: op.opId, status: "rejected", error: `unknown kind: ${op.kind}` });
      continue;
    }
    const parsed = schema.safeParse(op.payload);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      results.push({ opId: op.opId, status: "rejected", error: `validation: ${detail}` });
      continue;
    }
    try {
      const status = await db.transaction(async (tx) => {
        // idempotency guard in the SAME transaction as the op application;
        // a rollback (rejected) also takes the sync_ops row with it
        const guard = await tx
          .insert(s.syncOps)
          .values({ opId: op.opId, clientId: body.clientId, kind: op.kind })
          .onConflictDoNothing()
          .returning({ opId: s.syncOps.opId });
        if (guard.length === 0) return "duplicate" as const;
        await applyOp(tx, budgetId, op.kind as OpKind, parsed.data);
        return "applied" as const;
      });
      results.push({ opId: op.opId, status });
    } catch (e) {
      // a domain rejection does NOT abort the rest of the batch; an infrastructure
      // error DOES (5xx from app.onError) — "rejected" means a permanent refusal to the client
      if (!isDomainRejection(e)) throw e;
      const error = e instanceof OpNotFound ? NOT_FOUND : ((e as Error).message ?? "internal");
      results.push({ opId: op.opId, status: "rejected", error });
    }
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

const replaceInput = z.object({ ledger: clientLedgerSchema });

/** Splits an array into chunks of `n` (bulk insert without oversized queries). */
const chunk = <T,>(arr: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, (i + 1) * n));

async function insertLedger(x: Executor, budgetId: string, ledger: ClientLedgerInput): Promise<void> {
  // FK-safe order: accounts → groups → envelopes → categories → places →
  // recurrences → allocations → transactions → split items
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
  for (const part of chunk(ledger.recurrences, 500)) {
    await x.insert(s.recurrences).values(
      part.map((r) => ({
        id: r.id,
        budgetId,
        rule: r.rule,
        startDate: r.startDate,
        endDate: r.endDate,
        pausedUntil: r.pausedUntil ?? null, // old JSON backups don't carry the field
      })),
    );
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
        planned: t.planned,
        recurrenceId: t.recurrenceId,
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
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return c.json({ error: `Kopia jest niepoprawna i nie została wczytana: ${detail}` }, 400);
  }
  const { ledger } = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      // Cursor barrier FIRST (like snapshot/pull) — the exclusive lock is held
      // until COMMIT: no concurrent push can weave in between our wipe and the
      // cursor read, and maxSeq after the inserts sees every seq we assigned.
      await lockChangesCursor(tx);
      const budgetId = (await requireTier(c, "plain", tx)).id;
      await restoreLedger(tx, budgetId, ledger);
      return { budgetId, cursor: await maxSeq(tx) };
    });
    return c.json(result);
  } catch (e) {
    // constraint violation (FK/PK/CHECK — e.g. an envelope points to a nonexistent
    // group, a transaction to a foreign envelope) → the whole transaction rolled back (atomically)
    if (e instanceof postgres.PostgresError && (e.code.startsWith("23") || e.code.startsWith("22"))) {
      return c.json(
        { error: "Nie udało się zapisać kopii — dane odwołują się do nieistniejących powiązań (uszkodzony lub obcy plik). Nic nie zostało zmienione." },
        400,
      );
    }
    throw e;
  }
});
