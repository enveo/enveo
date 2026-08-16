import { readdirSync, readFileSync } from "node:fs";
import type postgres from "postgres";
import { assertThrowawayDb, emitChildResult } from "../api.test-support";

export const SENTINEL = "__AUTOMATIC_ENVELOPE_MIGRATION_CHILD__";

export interface AutomaticEnvelopeMigrationOutput {
  preserved: { accounts: boolean; transactions: boolean; allNewColumnsNull: boolean };
  foreignKeys: {
    foreignAccountLinkRejected: boolean;
    foreignFlowRejected: boolean;
    envelopeDeleteClearedAllThreeReferences: boolean;
  };
}

const rejected = async (run: () => Promise<unknown>): Promise<boolean> => {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
};

async function applyMigration(sql: ReturnType<typeof postgres>, path: string): Promise<void> {
  const source = readFileSync(path, "utf8");
  for (const statement of source
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await sql.unsafe(statement);
  }
}

async function main() {
  const testUrl = process.env.DATABASE_URL ?? "";
  assertThrowawayDb(testUrl);
  const postgres = (await import("postgres")).default;
  const admin = postgres(testUrl, { max: 1, onnotice: () => {} });
  const dbName = `enveo_automatic_envelopes_${crypto.randomUUID().replaceAll("-", "")}`;
  const derived = new URL(testUrl);
  derived.pathname = `/${dbName}`;
  let isolated: ReturnType<typeof postgres> | undefined;

  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    isolated = postgres(derived.toString(), { max: 1, onnotice: () => {} });
    const migrationsDir = new URL("../../drizzle", import.meta.url).pathname;
    const previous = readdirSync(migrationsDir)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0024_")
      .sort();
    for (const name of previous) await applyMigration(isolated, `${migrationsDir}/${name}`);

    const userId = crypto.randomUUID();
    const firstBudgetId = crypto.randomUUID();
    const secondBudgetId = crypto.randomUUID();
    const firstGroupId = crypto.randomUUID();
    const firstEnvelopeId = crypto.randomUUID();
    const firstAccountId = crypto.randomUUID();
    const firstTransactionId = crypto.randomUUID();
    const secondGroupId = crypto.randomUUID();
    const secondEnvelopeId = crypto.randomUUID();
    const secondAccountId = crypto.randomUUID();
    await isolated`insert into users (id, email) values (${userId}, ${`automatic-${userId}@test.local`})`;
    await isolated`insert into budgets (id, user_id, name, currency, tier, wrapped_dek, kdf_params, epoch, cipher_version)
      values (${firstBudgetId}, ${userId}, 'First', 'PLN', 'plain', null, null, 0, 2),
             (${secondBudgetId}, ${userId}, 'Second', 'EUR', 'plain', null, null, 0, 2)`;
    await isolated`insert into envelope_groups (id, budget_id, name, sort)
      values (${firstGroupId}, ${firstBudgetId}, 'First group', 0),
             (${secondGroupId}, ${secondBudgetId}, 'Second group', 0)`;
    await isolated`insert into envelopes (id, budget_id, group_id, name, color, icon, sort, archived)
      values (${firstEnvelopeId}, ${firstBudgetId}, ${firstGroupId}, 'First envelope', '#fff', 'tag', 0, false),
             (${secondEnvelopeId}, ${secondBudgetId}, ${secondGroupId}, 'Second envelope', '#fff', 'tag', 0, false)`;
    await isolated`insert into accounts (id, budget_id, name, color, icon, type, on_budget, initial_balance, archived, sort)
      values (${firstAccountId}, ${firstBudgetId}, 'First account', '#fff', 'wallet', 'checking', true, 0, false, 0),
             (${secondAccountId}, ${secondBudgetId}, 'Second account', '#fff', 'wallet', 'checking', true, 0, false, 0)`;
    await isolated`insert into transactions (id, budget_id, type, account_id, amount, date, is_refund)
      values (${firstTransactionId}, ${firstBudgetId}, 'transfer', ${firstAccountId}, 100, '2026-08-16', false)`;

    await applyMigration(isolated, `${migrationsDir}/0024_automatic_envelopes.sql`);

    const accountBefore = await isolated<{ id: string; automaticEnvelopeId: string | null }[]>`
      select id, automatic_envelope_id as "automaticEnvelopeId" from accounts where id = ${firstAccountId}`;
    const transactionBefore = await isolated<
      {
        id: string;
        allocationFromEnvelopeId: string | null;
        allocationToEnvelopeId: string | null;
      }[]
    >`
      select id, allocation_from_envelope_id as "allocationFromEnvelopeId", allocation_to_envelope_id as "allocationToEnvelopeId"
        from transactions where id = ${firstTransactionId}`;

    const foreignId = crypto.randomUUID();
    const foreignAccountLinkRejected = await rejected(() => isolated!`update accounts set automatic_envelope_id = ${foreignId} where id = ${firstAccountId}`);
    const foreignFlowRejected = await rejected(
      () => isolated!`update transactions set allocation_from_envelope_id = ${foreignId} where id = ${firstTransactionId}`,
    );

    await isolated`update accounts set automatic_envelope_id = ${firstEnvelopeId} where id = ${firstAccountId}`;
    await isolated`update transactions set allocation_from_envelope_id = ${firstEnvelopeId}, allocation_to_envelope_id = ${firstEnvelopeId} where id = ${firstTransactionId}`;
    await isolated`delete from envelopes where id = ${firstEnvelopeId}`;
    const accountAfter = await isolated<{ automaticEnvelopeId: string | null }[]>`
      select automatic_envelope_id as "automaticEnvelopeId" from accounts where id = ${firstAccountId}`;
    const transactionAfter = await isolated<
      {
        allocationFromEnvelopeId: string | null;
        allocationToEnvelopeId: string | null;
      }[]
    >`
      select allocation_from_envelope_id as "allocationFromEnvelopeId", allocation_to_envelope_id as "allocationToEnvelopeId"
        from transactions where id = ${firstTransactionId}`;

    await emitChildResult(SENTINEL, {
      preserved: {
        accounts: accountBefore[0]?.id === firstAccountId,
        transactions: transactionBefore[0]?.id === firstTransactionId,
        allNewColumnsNull:
          accountBefore[0]?.automaticEnvelopeId === null &&
          transactionBefore[0]?.allocationFromEnvelopeId === null &&
          transactionBefore[0]?.allocationToEnvelopeId === null,
      },
      foreignKeys: {
        foreignAccountLinkRejected,
        foreignFlowRejected,
        envelopeDeleteClearedAllThreeReferences:
          accountAfter[0]?.automaticEnvelopeId === null &&
          transactionAfter[0]?.allocationFromEnvelopeId === null &&
          transactionAfter[0]?.allocationToEnvelopeId === null,
      },
    } satisfies AutomaticEnvelopeMigrationOutput);
  } finally {
    if (isolated) await isolated.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
