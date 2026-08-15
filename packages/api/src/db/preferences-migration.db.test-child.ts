import { readdirSync, readFileSync } from "node:fs";
import type postgres from "postgres";
import { assertThrowawayDb, emitChildResult } from "../api.test-support";

export const SENTINEL = "__PREFERENCES_MIGRATION_CHILD__";

export interface PreferencesMigrationOutput {
  preservation: { plainSurvived: boolean; e2eeSurvived: boolean; bothPreferencesNull: boolean };
  constraints: { invalidLangRejected: boolean; invalidThemeRejected: boolean; invalidAccentRejected: boolean; negativeRevisionRejected: boolean };
  cascade: { accountPreferencesDeleted: boolean; budgetsDeleted: boolean };
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
  const dbName = `enveo_preferences_${crypto.randomUUID().replaceAll("-", "")}`;
  const derived = new URL(testUrl);
  derived.pathname = `/${dbName}`;
  let isolated: ReturnType<typeof postgres> | undefined;

  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    isolated = postgres(derived.toString(), { max: 1, onnotice: () => {} });
    const migrationsDir = new URL("../../drizzle", import.meta.url).pathname;
    const previous = readdirSync(migrationsDir)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0022_")
      .sort();
    for (const name of previous) await applyMigration(isolated, `${migrationsDir}/${name}`);

    const userId = crypto.randomUUID();
    const plainId = crypto.randomUUID();
    const e2eeId = crypto.randomUUID();
    await isolated`insert into users (id, email) values (${userId}, ${`prefs-${userId}@test.local`})`;
    await isolated`insert into budgets (id, user_id, name, currency, tier, wrapped_dek, kdf_params, epoch, cipher_version)
      values (${plainId}, ${userId}, 'Plain before migration', 'PLN', 'plain', null, null, 0, 2),
             (${e2eeId}, ${userId}, 'E2EE before migration', 'EUR', 'e2ee', 'v2.wrapped', '{}', 3, 2)`;

    await applyMigration(isolated, `${migrationsDir}/0022_account_budget_preferences.sql`);

    const budgets = await isolated<{ id: string; name: string; tier: string; preferences: unknown }[]>`
      select id, name, tier, preferences from budgets where user_id = ${userId} order by name`;
    const plain = budgets.find((budget) => budget.id === plainId);
    const e2ee = budgets.find((budget) => budget.id === e2eeId);

    await isolated`insert into account_preferences (user_id, lang, theme_mode, accent_theme, revision)
      values (${userId}, 'pl', 'dark', 'duet', 2)`;
    const invalidLangRejected = await rejected(() => isolated!`update account_preferences set lang = 'xx' where user_id = ${userId}`);
    const invalidThemeRejected = await rejected(() => isolated!`update account_preferences set theme_mode = 'night' where user_id = ${userId}`);
    const invalidAccentRejected = await rejected(() => isolated!`update account_preferences set accent_theme = 'red' where user_id = ${userId}`);
    const negativeRevisionRejected = await rejected(() => isolated!`update account_preferences set revision = -1 where user_id = ${userId}`);

    await isolated`delete from users where id = ${userId}`;
    const accountRows = await isolated<{ count: number }[]>`select count(*)::int as count from account_preferences where user_id = ${userId}`;
    const budgetRows = await isolated<{ count: number }[]>`select count(*)::int as count from budgets where user_id = ${userId}`;

    await emitChildResult(SENTINEL, {
      preservation: {
        plainSurvived: plain?.name === "Plain before migration" && plain.tier === "plain",
        e2eeSurvived: e2ee?.name === "E2EE before migration" && e2ee.tier === "e2ee",
        bothPreferencesNull: budgets.every((budget) => budget.preferences === null),
      },
      constraints: { invalidLangRejected, invalidThemeRejected, invalidAccentRejected, negativeRevisionRejected },
      cascade: { accountPreferencesDeleted: accountRows[0]?.count === 0, budgetsDeleted: budgetRows[0]?.count === 0 },
    } satisfies PreferencesMigrationOutput);
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
