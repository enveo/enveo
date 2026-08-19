import { assertThrowawayDb, emitChildResult } from "../api.test-support";

export const SENTINEL = "__SYNC_DICTIONARIES_CHILD__";

export interface SyncDictionariesOutput {
  merge: { sourceGone: boolean; transactionRepointed: boolean; itemRepointed: boolean; replayNoop: boolean; foreignRefused: boolean };
  hide: { archived: boolean; transactionKeptIt: boolean; replayIdempotent: boolean };
  restore: { archived: boolean };
  deleteUnused: { rowGone: boolean };
  deleteRaced: { rowKept: boolean; archived: boolean; transactionKeptIt: boolean };
  deleteRacedByItem: { rowKept: boolean; archived: boolean; itemKeptIt: boolean };
}

async function main() {
  const { env } = await import("../env");
  assertThrowawayDb(env.DATABASE_URL);
  const { db, sql } = await import("../db/client");
  const s = await import("../db/schema");
  const { and, eq } = await import("drizzle-orm");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { applyPushOp } = await import("./sync");

  await migrate(drizzle(sql, { schema: s }), { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  const [user] = await db
    .insert(s.users)
    .values({ email: `sync-dictionaries-${crypto.randomUUID()}@test.local` })
    .returning({ id: s.users.id });
  const [budget] = await db.insert(s.budgets).values({ userId: user!.id, name: "Dictionaries" }).returning({ id: s.budgets.id });
  const budgetId = budget!.id;
  const CLIENT = "dictionaries-client";

  try {
    const [account] = await db.insert(s.accounts).values({ budgetId, name: "Main" }).returning({ id: s.accounts.id });
    const [group] = await db.insert(s.envelopeGroups).values({ budgetId, name: "Everyday" }).returning({ id: s.envelopeGroups.id });
    const [envelope] = await db.insert(s.envelopes).values({ budgetId, groupId: group!.id, name: "Food" }).returning({ id: s.envelopes.id });
    const place = async (name: string) => (await db.insert(s.places).values({ budgetId, name }).returning({ id: s.places.id }))[0]!.id;
    const category = async (name: string) => (await db.insert(s.categories).values({ budgetId, name }).returning({ id: s.categories.id }))[0]!.id;
    const push = (kind: "place.update" | "place.delete" | "category.delete" | "place.merge" | "category.merge", payload: object) =>
      applyPushOp(budgetId, CLIENT, { opId: crypto.randomUUID(), kind, payload });
    const readPlace = async (id: string) =>
      (
        await db
          .select()
          .from(s.places)
          .where(and(eq(s.places.id, id), eq(s.places.budgetId, budgetId)))
      )[0];
    const readCategory = async (id: string) =>
      (
        await db
          .select()
          .from(s.categories)
          .where(and(eq(s.categories.id, id), eq(s.categories.budgetId, budgetId)))
      )[0];

    /* hide + restore, with a transaction that must keep the value throughout */
    const used = await place("Corner shop");
    const [usedTxn] = await db
      .insert(s.transactions)
      .values({ budgetId, type: "expense", accountId: account!.id, amount: 1000, date: "2026-08-19", placeId: used })
      .returning({ id: s.transactions.id });
    const hideOpId = crypto.randomUUID();
    await applyPushOp(budgetId, CLIENT, { opId: hideOpId, kind: "place.update", payload: { id: used, archived: true } });
    const afterHide = await readPlace(used);
    const txnAfterHide = (await db.select().from(s.transactions).where(eq(s.transactions.id, usedTxn!.id)))[0];
    // same opId again: the sync_ops guard must not double-apply
    const replay = await applyPushOp(budgetId, CLIENT, { opId: hideOpId, kind: "place.update", payload: { id: used, archived: true } });

    await push("place.update", { id: used, archived: false });
    const afterRestore = await readPlace(used);

    /* delete with nothing referencing it — the row really goes */
    const unused = await place("Typo");
    await push("place.delete", { id: unused });
    const afterDeleteUnused = await readPlace(unused);

    /* delete that LOST THE RACE: a reference exists, so it must degrade to archive */
    const raced = await place("Bakery");
    const [racedTxn] = await db
      .insert(s.transactions)
      .values({ budgetId, type: "expense", accountId: account!.id, amount: 2000, date: "2026-08-19", placeId: raced })
      .returning({ id: s.transactions.id });
    await push("place.delete", { id: raced });
    const afterRaced = await readPlace(raced);
    const racedTxnRow = (await db.select().from(s.transactions).where(eq(s.transactions.id, racedTxn!.id)))[0];

    /* the same, but the only reference lives in a SPLIT ITEM */
    const racedCategory = await category("Coffee");
    const [splitTxn] = await db
      .insert(s.transactions)
      .values({ budgetId, type: "expense", accountId: account!.id, amount: 3000, date: "2026-08-19" })
      .returning({ id: s.transactions.id });
    const [item] = await db
      .insert(s.txnItems)
      .values({ transactionId: splitTxn!.id, envelopeId: envelope!.id, amount: 3000, categoryId: racedCategory })
      .returning({ id: s.txnItems.id });
    await push("category.delete", { id: racedCategory });
    const afterRacedItem = await readCategory(racedCategory);
    const itemRow = (await db.select().from(s.txnItems).where(eq(s.txnItems.id, item!.id)))[0];

    /* merge: every reference is repointed, the source disappears, a replay changes nothing */
    const keep = await place("Zabka");
    const dupe = await place("ZABKA");
    const [dupeTxn] = await db
      .insert(s.transactions)
      .values({ budgetId, type: "expense", accountId: account!.id, amount: 4000, date: "2026-08-19", placeId: dupe })
      .returning({ id: s.transactions.id });
    const catKeep = await category("Kawa");
    const catDupe = await category("kawa");
    const [mergeSplit] = await db
      .insert(s.transactions)
      .values({ budgetId, type: "expense", accountId: account!.id, amount: 5000, date: "2026-08-19" })
      .returning({ id: s.transactions.id });
    const [mergeItem] = await db
      .insert(s.txnItems)
      .values({ transactionId: mergeSplit!.id, envelopeId: envelope!.id, amount: 5000, categoryId: catDupe })
      .returning({ id: s.txnItems.id });

    await push("place.merge", { fromId: dupe, intoId: keep });
    await push("category.merge", { fromId: catDupe, intoId: catKeep });
    const mergedTxn = (await db.select().from(s.transactions).where(eq(s.transactions.id, dupeTxn!.id)))[0];
    const mergedItem = (await db.select().from(s.txnItems).where(eq(s.txnItems.id, mergeItem!.id)))[0];
    const beforeReplay = (await db.select().from(s.places).where(eq(s.places.budgetId, budgetId))).length;
    await push("place.merge", { fromId: dupe, intoId: keep });
    const afterReplay = (await db.select().from(s.places).where(eq(s.places.budgetId, budgetId))).length;

    // a foreign source id must move nothing at all
    const [otherUser] = await db
      .insert(s.users)
      .values({ email: `sync-dictionaries-foreign-${crypto.randomUUID()}@test.local` })
      .returning({ id: s.users.id });
    const [otherBudget] = await db.insert(s.budgets).values({ userId: otherUser!.id, name: "Other" }).returning({ id: s.budgets.id });
    const [foreign] = await db.insert(s.places).values({ budgetId: otherBudget!.id, name: "Foreign" }).returning({ id: s.places.id });
    await push("place.merge", { fromId: foreign!.id, intoId: keep });
    const foreignStillThere = (await db.select().from(s.places).where(eq(s.places.id, foreign!.id))).length === 1;
    await db.delete(s.budgets).where(eq(s.budgets.id, otherBudget!.id));
    await db.delete(s.users).where(eq(s.users.id, otherUser!.id));

    const out: SyncDictionariesOutput = {
      merge: {
        sourceGone: (await readPlace(dupe)) === undefined,
        transactionRepointed: mergedTxn?.placeId === keep,
        itemRepointed: mergedItem?.categoryId === catKeep,
        replayNoop: beforeReplay === afterReplay,
        foreignRefused: foreignStillThere,
      },
      hide: {
        archived: afterHide?.archived === true,
        transactionKeptIt: txnAfterHide?.placeId === used,
        replayIdempotent: replay.status === "duplicate",
      },
      restore: { archived: (await readPlace(used))?.archived === false && afterRestore?.archived === false },
      deleteUnused: { rowGone: afterDeleteUnused === undefined },
      deleteRaced: {
        rowKept: afterRaced !== undefined,
        archived: afterRaced?.archived === true,
        transactionKeptIt: racedTxnRow?.placeId === raced,
      },
      deleteRacedByItem: {
        rowKept: afterRacedItem !== undefined,
        archived: afterRacedItem?.archived === true,
        itemKeptIt: itemRow?.categoryId === racedCategory,
      },
    };
    await emitChildResult(SENTINEL, out);
  } finally {
    await db.delete(s.budgets).where(eq(s.budgets.id, budgetId));
    await db.delete(s.users).where(eq(s.users.id, user!.id));
    await sql.end({ timeout: 5 });
  }
}

// Imported by the parent suite for SENTINEL/typing — only a direct `bun <file>` run may execute it.
if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
