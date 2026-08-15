import { assertThrowawayDb, emitChildResult } from "../api.test-support";

export const SENTINEL = "__SYNC_PREFERENCES_CHILD__";

export interface SyncPreferencesOutput {
  sync: { nullMappedToDefaults: boolean; firstApplied: boolean; secondApplied: boolean; bothFieldsPreserved: boolean };
  guards: { replayDuplicate: boolean; emptyRejected: boolean; foreignRejected: boolean; rejectedDidNotMutate: boolean };
  pullCarriesCompletePreferences: boolean;
  restore: { currentRoundTrips: boolean; oldBackupGetsDefaults: boolean };
  sourceRef: { createApplied: boolean; updateApplied: boolean; snapshotPreserved: boolean; pullPreserved: boolean; restorePreserved: boolean };
}

async function main() {
  const { env } = await import("../env");
  assertThrowawayDb(env.DATABASE_URL);
  const { clientLedgerSchema, createDefaultBudgetPreferences } = await import("@enveo/shared");
  const { db, sql } = await import("../db/client");
  const s = await import("../db/schema");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { loadClientLedger } = await import("../repo");
  const { applyPushOp, pullChanges, restoreLedger } = await import("./sync");

  await migrate(drizzle(sql, { schema: s }), { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  const [user] = await db
    .insert(s.users)
    .values({ email: `sync-preferences-${crypto.randomUUID()}@test.local` })
    .returning({ id: s.users.id });
  const [budget] = await db.insert(s.budgets).values({ userId: user!.id, name: "Preferences", preferences: null }).returning({ id: s.budgets.id });
  const budgetId = budget!.id;

  try {
    const initial = await loadClientLedger(db, budgetId);
    const defaults = createDefaultBudgetPreferences();
    const nullMappedToDefaults = JSON.stringify(initial.budgets[0]!.preferences) === JSON.stringify(defaults);

    const first = await applyPushOp(budgetId, "preferences-client", {
      opId: crypto.randomUUID(),
      kind: "budget.preferences.update",
      payload: { id: budgetId, patch: { openaiModel: "gpt-5.6-sol" } },
    });
    const widgets = [...defaults.startWidgets].reverse();
    const secondOpId = crypto.randomUUID();
    const second = await applyPushOp(budgetId, "preferences-client", {
      opId: secondOpId,
      kind: "budget.preferences.update",
      payload: { id: budgetId, patch: { startWidgets: widgets } },
    });
    const replay = await applyPushOp(budgetId, "preferences-client", {
      opId: secondOpId,
      kind: "budget.preferences.update",
      payload: { id: budgetId, patch: { startWidgets: widgets } },
    });
    const after = await loadClientLedger(db, budgetId);
    const bothFieldsPreserved =
      after.budgets[0]!.preferences.openaiModel === "gpt-5.6-sol" && JSON.stringify(after.budgets[0]!.preferences.startWidgets) === JSON.stringify(widgets);

    const beforeRejected = JSON.stringify(after.budgets[0]!.preferences);
    const empty = await applyPushOp(budgetId, "preferences-client", {
      opId: crypto.randomUUID(),
      kind: "budget.preferences.update",
      payload: { id: budgetId, patch: {} },
    });
    const foreign = await applyPushOp(budgetId, "preferences-client", {
      opId: crypto.randomUUID(),
      kind: "budget.preferences.update",
      payload: { id: crypto.randomUUID(), patch: { aiProvider: "openai" } },
    });
    const afterRejected = await loadClientLedger(db, budgetId);

    const changes = await pullChanges(db, budgetId, 0);
    const budgetChange = [...changes].reverse().find((change) => change.table === "budgets" && change.op === "upsert");
    const pulledPreferences = budgetChange?.op === "upsert" ? (budgetChange.row as { preferences?: unknown }).preferences : undefined;
    const pullCarriesCompletePreferences = JSON.stringify(pulledPreferences) === JSON.stringify(after.budgets[0]!.preferences);

    const accountId = crypto.randomUUID();
    await applyPushOp(budgetId, "source-ref-client", {
      opId: crypto.randomUUID(),
      kind: "account.create",
      payload: { id: accountId, name: "Import account" },
    });
    const transactionId = crypto.randomUUID();
    const createTxn = await applyPushOp(budgetId, "source-ref-client", {
      opId: crypto.randomUUID(),
      kind: "txn.create",
      payload: {
        id: transactionId,
        type: "expense",
        accountId,
        amount: 1234,
        date: "2026-08-14",
        sourceRef: "RAW BANK CREATE",
      },
    });
    const updateTxn = await applyPushOp(budgetId, "source-ref-client", {
      opId: crypto.randomUUID(),
      kind: "txn.update",
      payload: {
        id: transactionId,
        type: "expense",
        accountId,
        amount: 1234,
        date: "2026-08-14",
        sourceRef: "RAW BANK UPDATED",
      },
    });
    const sourceSnapshot = await loadClientLedger(db, budgetId);
    const snapshotPreserved = sourceSnapshot.transactions[0]?.sourceRef === "RAW BANK UPDATED";
    const sourceChanges = await pullChanges(db, budgetId, 0);
    const transactionChange = [...sourceChanges]
      .reverse()
      .find((change) => change.table === "transactions" && change.op === "upsert" && (change.row as { id?: string }).id === transactionId);
    const pullPreserved = transactionChange?.op === "upsert" && (transactionChange.row as { sourceRef?: string }).sourceRef === "RAW BANK UPDATED";

    const current = structuredClone(sourceSnapshot);
    current.budgets[0]!.preferences = {
      ...current.budgets[0]!.preferences,
      aiProvider: "openai",
      customProfiles: [{ id: crypto.randomUUID(), name: "Buffer", prompt: "Keep one month" }],
    };
    await db.transaction((tx) => restoreLedger(tx, budgetId, clientLedgerSchema.parse(current)));
    const restored = await loadClientLedger(db, budgetId);
    const currentRoundTrips = JSON.stringify(restored.budgets[0]!.preferences) === JSON.stringify(current.budgets[0]!.preferences);
    const restorePreserved = restored.transactions[0]?.sourceRef === "RAW BANK UPDATED";

    const oldBackup = clientLedgerSchema.parse({ accounts: [], groups: [], envelopes: [], categories: [], places: [], allocations: [], transactions: [] });
    await db.transaction((tx) => restoreLedger(tx, budgetId, oldBackup));
    const afterOld = await loadClientLedger(db, budgetId);

    await emitChildResult(SENTINEL, {
      sync: { nullMappedToDefaults, firstApplied: first.status === "applied", secondApplied: second.status === "applied", bothFieldsPreserved },
      guards: {
        replayDuplicate: replay.status === "duplicate",
        emptyRejected: empty.status === "rejected",
        foreignRejected: foreign.status === "rejected",
        rejectedDidNotMutate: JSON.stringify(afterRejected.budgets[0]!.preferences) === beforeRejected,
      },
      pullCarriesCompletePreferences,
      restore: { currentRoundTrips, oldBackupGetsDefaults: JSON.stringify(afterOld.budgets[0]!.preferences) === JSON.stringify(defaults) },
      sourceRef: {
        createApplied: createTxn.status === "applied",
        updateApplied: updateTxn.status === "applied",
        snapshotPreserved,
        pullPreserved,
        restorePreserved,
      },
    } satisfies SyncPreferencesOutput);
  } finally {
    await db.delete(s.users).where((await import("drizzle-orm")).eq(s.users.id, user!.id));
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
