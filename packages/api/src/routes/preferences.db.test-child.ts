import { assertThrowawayDb, emitChildResult } from "../api.test-support";

export const SENTINEL = "__ACCOUNT_PREFERENCES_CHILD__";

export interface PreferencesDbOutput {
  defaults: { responseIsDefault: boolean; rowWasNotCreated: boolean };
  concurrent: { lang: string; themeMode: string; accentTheme: string; revision: number };
  mismatch: { status: number; error: string | null; claimedUserUnchanged: boolean; sessionUserRowAbsent: boolean };
}

async function main() {
  const { env } = await import("../env");
  assertThrowawayDb(env.DATABASE_URL);
  const { eq } = await import("drizzle-orm");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { Hono } = await import("hono");
  const { ZodError } = await import("zod");
  const { db, sql } = await import("../db/client");
  const s = await import("../db/schema");
  const { patchAccountPreferences, preferencesRoutes, readAccountPreferences } = await import("./preferences");

  await migrate(drizzle(sql, { schema: s }), { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  const users = await db
    .insert(s.users)
    .values([{ email: `prefs-a-${crypto.randomUUID()}@test.local` }, { email: `prefs-b-${crypto.randomUUID()}@test.local` }])
    .returning({ id: s.users.id });
  const userA = users[0]!.id;
  const userB = users[1]!.id;

  try {
    const defaults = await readAccountPreferences(db, userA);
    const initialRows = await db.select({ id: s.accountPreferences.userId }).from(s.accountPreferences).where(eq(s.accountPreferences.userId, userA));
    await patchAccountPreferences(db, userA, { accentTheme: "duet" });
    await Promise.all([patchAccountPreferences(db, userA, { lang: "pl" }), patchAccountPreferences(db, userA, { themeMode: "dark" })]);
    const concurrent = await readAccountPreferences(db, userA);

    let sessionUser = userB;
    const app = new Hono<{ Variables: { userId?: string } }>();
    app.use("*", async (c, next) => {
      c.set("userId", sessionUser);
      await next();
    });
    app.route("/api", preferencesRoutes);
    app.onError((error, c) => (error instanceof ZodError ? c.json({ error: "validation" }, 400) : c.json({ error: "internal" }, 500)));
    const beforeMismatch = await readAccountPreferences(db, userA);
    const mismatchResponse = await app.request("/api/preferences/account", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: userA, patch: { lang: "de" } }),
    });
    const mismatchBody = (await mismatchResponse.json()) as { error?: string };
    const afterMismatch = await readAccountPreferences(db, userA);
    const userBRows = await db.select({ id: s.accountPreferences.userId }).from(s.accountPreferences).where(eq(s.accountPreferences.userId, userB));
    sessionUser = "";

    await emitChildResult(SENTINEL, {
      defaults: {
        responseIsDefault: JSON.stringify(defaults) === JSON.stringify({ schemaVersion: 1, lang: "en", themeMode: "light", accentTheme: "teal", revision: 0 }),
        rowWasNotCreated: initialRows.length === 0,
      },
      concurrent: { lang: concurrent.lang, themeMode: concurrent.themeMode, accentTheme: concurrent.accentTheme, revision: concurrent.revision },
      mismatch: {
        status: mismatchResponse.status,
        error: mismatchBody.error ?? null,
        claimedUserUnchanged: JSON.stringify(beforeMismatch) === JSON.stringify(afterMismatch),
        sessionUserRowAbsent: userBRows.length === 0,
      },
    } satisfies PreferencesDbOutput);
  } finally {
    await db.delete(s.users).where(eq(s.users.id, userA));
    await db.delete(s.users).where(eq(s.users.id, userB));
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
