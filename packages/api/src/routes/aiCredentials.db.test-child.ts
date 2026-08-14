import { assertThrowawayDb, emitChildResult } from "../api.test-support";

export const SENTINEL = "__AI_CREDENTIAL_ROUTES_CHILD__";
export interface AiCredentialsRoutesOutput {
  lifecycle: { saveStatus: number; configured: boolean; testStatus: number; probeSawKey: boolean; responseLeaked: boolean; databaseLeaked: boolean };
  mismatch: { status: number; error: string | null; rowUnchanged: boolean; probeCallsUnchanged: boolean };
  unavailable: { statusAvailable: boolean; statusReason: string | null; saveStatus: number; deleteStatus: number };
  tierStatus: number;
}

async function main() {
  const { env } = await import("../env");
  assertThrowawayDb(env.DATABASE_URL);
  const { eq } = await import("drizzle-orm");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { Hono } = await import("hono");
  const { ZodError } = await import("zod");
  const { TierMismatch } = await import("../context");
  const { db, sql } = await import("../db/client");
  const s = await import("../db/schema");
  const { createAiCredentialRoutes } = await import("./aiCredentials");

  await migrate(drizzle(sql, { schema: s }), { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  const users = await db
    .insert(s.users)
    .values([{ email: `vault-route-a-${crypto.randomUUID()}@test.local` }, { email: `vault-route-b-${crypto.randomUUID()}@test.local` }])
    .returning({ id: s.users.id });
  const userA = users[0]!.id;
  const userB = users[1]!.id;
  const [budgetA] = await db.insert(s.budgets).values({ userId: userA, name: "A" }).returning({ id: s.budgets.id });
  const [budgetB] = await db.insert(s.budgets).values({ userId: userB, name: "B" }).returning({ id: s.budgets.id });
  const marker = "sk-SENTINEL_ROUTE_SECRET";
  let sessionUser = userA;
  let probeCalls = 0;
  let probeSawKey = false;
  const masterKeys = {
    active: () => ({ id: "test-active", key: new Uint8Array(32).fill(7) }),
    byId: (id: string) => (id === "test-active" ? new Uint8Array(32).fill(7) : null),
  };
  const makeApp = (keys: typeof masterKeys | null) => {
    const app = new Hono<{ Variables: { userId?: string } }>();
    app.use("*", async (c, next) => {
      c.set("userId", sessionUser);
      await next();
    });
    app.route(
      "/api",
      createAiCredentialRoutes({
        masterKeys: keys,
        modelProbe: async (key, model) => {
          probeCalls += 1;
          probeSawKey ||= key === marker && model === "gpt-5.6-luna";
          return { ok: true };
        },
      }),
    );
    app.onError((error, c) => {
      if (error instanceof ZodError) return c.json({ error: "validation" }, 400);
      if (error instanceof TierMismatch) return c.json({ error: "tier_mismatch" }, 409);
      return c.json({ error: "internal" }, 500);
    });
    return app;
  };

  try {
    const app = makeApp(masterKeys);
    const save = await app.request("/api/ai/credentials/openai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetId: budgetA!.id, key: marker }),
    });
    const saveText = await save.text();
    const status = await app.request(`/api/ai/credentials/openai/status?budgetId=${budgetA!.id}`);
    const statusText = await status.text();
    const statusBody = JSON.parse(statusText) as { configured?: boolean };
    const tested = await app.request("/api/ai/credentials/openai/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetId: budgetA!.id, model: "gpt-5.6-luna" }),
    });
    const testText = await tested.text();
    const [stored] = await db.select().from(s.budgetAiCredentials).where(eq(s.budgetAiCredentials.budgetId, budgetA!.id));

    const beforeMismatch = JSON.stringify(stored);
    const probeBeforeMismatch = probeCalls;
    sessionUser = userB;
    const mismatchResponse = await app.request("/api/ai/credentials/openai/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetId: budgetA!.id, model: "gpt-5.6-luna" }),
    });
    const mismatchBody = (await mismatchResponse.json()) as { error?: string };
    const [afterMismatch] = await db.select().from(s.budgetAiCredentials).where(eq(s.budgetAiCredentials.budgetId, budgetA!.id));

    sessionUser = userA;
    const unavailableApp = makeApp(null);
    const unavailableStatus = await unavailableApp.request(`/api/ai/credentials/openai/status?budgetId=${budgetA!.id}`);
    const unavailableStatusBody = (await unavailableStatus.json()) as { available?: boolean; reason?: string };
    const unavailableSave = await unavailableApp.request("/api/ai/credentials/openai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetId: budgetA!.id, key: "sk-new" }),
    });
    const unavailableDelete = await unavailableApp.request("/api/ai/credentials/openai", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetId: budgetA!.id }),
    });

    sessionUser = userB;
    await db.update(s.budgets).set({ tier: "e2ee", wrappedDek: "v2.x", kdfParams: "{}", epoch: 1 }).where(eq(s.budgets.id, budgetB!.id));
    const tierResponse = await app.request(`/api/ai/credentials/openai/status?budgetId=${budgetB!.id}`);

    const allResponses = `${saveText}${statusText}${testText}`;
    await emitChildResult(SENTINEL, {
      lifecycle: {
        saveStatus: save.status,
        configured: statusBody.configured === true,
        testStatus: tested.status,
        probeSawKey,
        responseLeaked: allResponses.includes(marker) || /ciphertext|wrapped_record|master_key|nonce/i.test(allResponses),
        databaseLeaked: JSON.stringify(stored).includes(marker),
      },
      mismatch: {
        status: mismatchResponse.status,
        error: mismatchBody.error ?? null,
        rowUnchanged: beforeMismatch === JSON.stringify(afterMismatch),
        probeCallsUnchanged: probeBeforeMismatch === probeCalls,
      },
      unavailable: {
        statusAvailable: unavailableStatusBody.available === true,
        statusReason: unavailableStatusBody.reason ?? null,
        saveStatus: unavailableSave.status,
        deleteStatus: unavailableDelete.status,
      },
      tierStatus: tierResponse.status,
    } satisfies AiCredentialsRoutesOutput);
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
