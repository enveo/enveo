import { readdirSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { assertThrowawayDb, emitChildResult } from "../api.test-support";
import * as schema from "../db/schema";
import type { VaultMasterKeyProvider } from "./keyProvider";
import { createCredentialRepository } from "./repository";

export const SENTINEL = "__AI_CREDENTIAL_REPOSITORY_CHILD__";
export interface CredentialRepositoryOutput {
  lifecycle: {
    initiallyConfigured: boolean;
    createdConfigured: boolean;
    createdOpened: boolean;
    rollbackKeptPrevious: boolean;
    deletedConfigured: boolean;
  };
  concurrent: { finalIsOneWinner: boolean; recordVersion: number | null };
  rotation: { opened: boolean; masterKeyId: string | null; ciphertextUnchanged: boolean; recordVersionUnchanged: boolean };
  cascadeDeleted: boolean;
}

const keys = (active: string, values: Record<string, number>): VaultMasterKeyProvider => ({
  active: () => ({ id: active, key: new Uint8Array(32).fill(values[active]!) }),
  byId: (id) => (values[id] === undefined ? null : new Uint8Array(32).fill(values[id])),
});

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
  const dbName = `enveo_ai_repository_${crypto.randomUUID().replaceAll("-", "")}`;
  const derived = new URL(testUrl);
  derived.pathname = `/${dbName}`;
  let isolated: ReturnType<typeof postgres> | undefined;

  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    isolated = postgres(derived.toString(), { max: 8, onnotice: () => {} });
    const migrationsDir = new URL("../../drizzle", import.meta.url).pathname;
    for (const name of readdirSync(migrationsDir)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort()) {
      await applyMigration(isolated, `${migrationsDir}/${name}`);
    }
    const db = drizzle(isolated, { schema });
    const repository = createCredentialRepository(keys("master-old", { "master-old": 1 }));
    const userId = crypto.randomUUID();
    const budgetId = crypto.randomUUID();
    await isolated`insert into users (id, email) values (${userId}, ${`repo-${userId}@test.local`})`;
    await isolated`insert into budgets (id, user_id, name, currency) values (${budgetId}, ${userId}, 'Vault test', 'EUR')`;
    const owner = { userId };

    const initiallyConfigured = (await db.transaction((tx) => repository.credentialStatus(tx, owner, budgetId))).configured;
    await db.transaction((tx) => repository.replaceServerCredential(tx, owner, budgetId, "sk-original"));
    const createdConfigured = (await db.transaction((tx) => repository.credentialStatus(tx, owner, budgetId))).configured;
    const createdOpened = await db.transaction((tx) =>
      repository.withServerCredential(tx, owner, budgetId, async (credential) => credential === "sk-original"),
    );

    try {
      await db.transaction(async (tx) => {
        await repository.replaceServerCredential(tx, owner, budgetId, "sk-must-rollback");
        throw new Error("forced_rollback");
      });
    } catch {
      // expected
    }
    const rollbackKeptPrevious = await db.transaction((tx) =>
      repository.withServerCredential(tx, owner, budgetId, async (credential) => credential === "sk-original"),
    );

    await Promise.all([
      db.transaction((tx) => repository.replaceServerCredential(tx, owner, budgetId, "sk-concurrent-a")),
      db.transaction((tx) => repository.replaceServerCredential(tx, owner, budgetId, "sk-concurrent-b")),
    ]);
    const finalCredential = await db.transaction((tx) => repository.withServerCredential(tx, owner, budgetId, async (credential) => credential));
    const [afterConcurrent] = await isolated<{ record_version: string }[]>`
      select record_version::text from budget_ai_credentials where budget_id = ${budgetId}`;

    const [beforeRotation] = await isolated<{ ciphertext: string; record_version: string }[]>`
      select ciphertext, record_version::text from budget_ai_credentials where budget_id = ${budgetId}`;
    const rotatedRepository = createCredentialRepository(keys("master-new", { "master-new": 2, "master-old": 1 }));
    const rotationOpened = await db.transaction((tx) =>
      rotatedRepository.withServerCredential(tx, owner, budgetId, async (credential) => credential === finalCredential),
    );
    const [afterRotation] = await isolated<{ ciphertext: string; record_version: string; master_key_id: string }[]>`
      select ciphertext, record_version::text, master_key_id from budget_ai_credentials where budget_id = ${budgetId}`;

    await db.transaction((tx) => repository.deleteCredential(tx, owner, budgetId));
    const deletedConfigured = (await db.transaction((tx) => repository.credentialStatus(tx, owner, budgetId))).configured;
    await db.transaction((tx) => repository.replaceServerCredential(tx, owner, budgetId, "sk-cascade"));
    await isolated`delete from budgets where id = ${budgetId}`;
    const [afterCascade] = await isolated<{ count: number }[]>`select count(*)::int as count from budget_ai_credentials where budget_id = ${budgetId}`;

    await emitChildResult(SENTINEL, {
      lifecycle: { initiallyConfigured, createdConfigured, createdOpened, rollbackKeptPrevious, deletedConfigured },
      concurrent: {
        finalIsOneWinner: finalCredential === "sk-concurrent-a" || finalCredential === "sk-concurrent-b",
        recordVersion: Number(afterConcurrent?.record_version ?? NaN),
      },
      rotation: {
        opened: rotationOpened,
        masterKeyId: afterRotation?.master_key_id ?? null,
        ciphertextUnchanged: beforeRotation?.ciphertext === afterRotation?.ciphertext,
        recordVersionUnchanged: beforeRotation?.record_version === afterRotation?.record_version,
      },
      cascadeDeleted: afterCascade?.count === 0,
    } satisfies CredentialRepositoryOutput);
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
