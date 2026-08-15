import { readdirSync, readFileSync } from "node:fs";
import type postgres from "postgres";
import { assertThrowawayDb, emitChildResult } from "../api.test-support";

export const SENTINEL = "__AI_CREDENTIALS_MIGRATION_CHILD__";

export interface AiCredentialsMigrationOutput {
  preservation: { budgetSurvived: boolean; serverVaultAccepted: boolean; e2eeCiphertextAccepted: boolean };
  constraints: {
    mixedServerRowRejected: boolean;
    mixedE2eeRowRejected: boolean;
    unsupportedProviderRejected: boolean;
    unsupportedFramingRejected: boolean;
    emptyCiphertextRejected: boolean;
    invalidRecordVersionRejected: boolean;
  };
  cascadeDeleted: boolean;
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
  const dbName = `enveo_ai_credential_migration_${crypto.randomUUID().replaceAll("-", "")}`;
  const derived = new URL(testUrl);
  derived.pathname = `/${dbName}`;
  let isolated: ReturnType<typeof postgres> | undefined;

  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    isolated = postgres(derived.toString(), { max: 1, onnotice: () => {} });
    const migrationsDir = new URL("../../drizzle", import.meta.url).pathname;
    const previous = readdirSync(migrationsDir)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0023_")
      .sort();
    for (const name of previous) await applyMigration(isolated, `${migrationsDir}/${name}`);

    const userId = crypto.randomUUID();
    const serverBudgetId = crypto.randomUUID();
    const e2eeBudgetId = crypto.randomUUID();
    await isolated`insert into users (id, email) values (${userId}, ${`vault-${userId}@test.local`})`;
    await isolated`insert into budgets (id, user_id, name, currency, tier, wrapped_dek, kdf_params, epoch, cipher_version)
      values (${serverBudgetId}, ${userId}, 'Existing plain', 'PLN', 'plain', null, null, 0, 2),
             (${e2eeBudgetId}, ${userId}, 'Existing E2EE', 'EUR', 'e2ee', 'v2.wrapped', '{}', 7, 2)`;

    await applyMigration(isolated, `${migrationsDir}/0023_budget_ai_credentials.sql`);

    const budgetRows = await isolated<{ count: number }[]>`select count(*)::int as count from budgets where user_id = ${userId}`;
    await isolated`insert into budget_ai_credentials
      (budget_id, provider, storage_kind, framing_version, ciphertext, wrapped_record_dek, master_key_id, e2ee_epoch, record_version)
      values (${serverBudgetId}, 'openai', 'server_vault', 1, 'vault.ciphertext', 'vault.wrapped', '2026-08', null, 1)`;
    const serverVaultAccepted =
      (await isolated<{ count: number }[]>`select count(*)::int as count from budget_ai_credentials where budget_id = ${serverBudgetId}`)[0]?.count === 1;
    await isolated`insert into budget_ai_credentials
      (budget_id, provider, storage_kind, framing_version, ciphertext, wrapped_record_dek, master_key_id, e2ee_epoch, record_version)
      values (${e2eeBudgetId}, 'openai', 'e2ee_ciphertext', 2, 'v2.ciphertext', null, null, 7, 1)`;
    const e2eeCiphertextAccepted =
      (await isolated<{ count: number }[]>`select count(*)::int as count from budget_ai_credentials where budget_id = ${e2eeBudgetId}`)[0]?.count === 1;

    const invalidBudgetId = async () => {
      const id = crypto.randomUUID();
      await isolated!`insert into budgets (id, user_id, name, currency) values (${id}, ${userId}, 'Invalid row holder', 'EUR')`;
      return id;
    };
    const mixedServerRowRejected = await rejected(async () => {
      const id = await invalidBudgetId();
      await isolated!`insert into budget_ai_credentials
        (budget_id, provider, storage_kind, framing_version, ciphertext, wrapped_record_dek, master_key_id, e2ee_epoch, record_version)
        values (${id}, 'openai', 'server_vault', 1, 'x', 'y', 'active', 1, 1)`;
    });
    const mixedE2eeRowRejected = await rejected(async () => {
      const id = await invalidBudgetId();
      await isolated!`insert into budget_ai_credentials
        (budget_id, provider, storage_kind, framing_version, ciphertext, wrapped_record_dek, master_key_id, e2ee_epoch, record_version)
        values (${id}, 'openai', 'e2ee_ciphertext', 2, 'v2.x', 'wrapped', null, 1, 1)`;
    });
    const unsupportedProviderRejected = await rejected(async () => {
      const id = await invalidBudgetId();
      await isolated!`insert into budget_ai_credentials
        (budget_id, provider, storage_kind, framing_version, ciphertext, wrapped_record_dek, master_key_id, e2ee_epoch, record_version)
        values (${id}, 'anthropic', 'server_vault', 1, 'x', 'y', 'active', null, 1)`;
    });
    const unsupportedFramingRejected = await rejected(async () => {
      const id = await invalidBudgetId();
      await isolated!`insert into budget_ai_credentials
        (budget_id, provider, storage_kind, framing_version, ciphertext, wrapped_record_dek, master_key_id, e2ee_epoch, record_version)
        values (${id}, 'openai', 'server_vault', 9, 'x', 'y', 'active', null, 1)`;
    });
    const emptyCiphertextRejected = await rejected(async () => {
      const id = await invalidBudgetId();
      await isolated!`insert into budget_ai_credentials
        (budget_id, provider, storage_kind, framing_version, ciphertext, wrapped_record_dek, master_key_id, e2ee_epoch, record_version)
        values (${id}, 'openai', 'server_vault', 1, '', 'y', 'active', null, 1)`;
    });
    const invalidRecordVersionRejected = await rejected(async () => {
      const id = await invalidBudgetId();
      await isolated!`insert into budget_ai_credentials
        (budget_id, provider, storage_kind, framing_version, ciphertext, wrapped_record_dek, master_key_id, e2ee_epoch, record_version)
        values (${id}, 'openai', 'server_vault', 1, 'x', 'y', 'active', null, 0)`;
    });

    await isolated`delete from budgets where id = ${serverBudgetId}`;
    const afterCascade = await isolated<{ count: number }[]>`select count(*)::int as count from budget_ai_credentials where budget_id = ${serverBudgetId}`;

    await emitChildResult(SENTINEL, {
      preservation: { budgetSurvived: budgetRows[0]?.count === 2, serverVaultAccepted, e2eeCiphertextAccepted },
      constraints: {
        mixedServerRowRejected,
        mixedE2eeRowRejected,
        unsupportedProviderRejected,
        unsupportedFramingRejected,
        emptyCiphertextRejected,
        invalidRecordVersionRejected,
      },
      cascadeDeleted: afterCascade[0]?.count === 0,
    } satisfies AiCredentialsMigrationOutput);
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
