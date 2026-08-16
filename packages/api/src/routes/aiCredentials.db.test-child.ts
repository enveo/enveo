import { assertThrowawayDb, emitChildResult } from "../api.test-support";

export const SENTINEL = "__AI_CREDENTIAL_ROUTES_CHILD__";
export interface AiCredentialsRoutesOutput {
  lifecycle: { saveStatus: number; configured: boolean; testStatus: number; probeSawKey: boolean; responseLeaked: boolean; databaseLeaked: boolean };
  mismatch: { status: number; error: string | null; rowUnchanged: boolean; probeCallsUnchanged: boolean };
  unavailable: { statusAvailable: boolean; statusReason: string | null; saveStatus: number; deleteStatus: number };
  tierStatus: number;
  workloads: { chatStatus: number; chatContent: string | null; importStatus: number; importItems: number; sentVaultKey: boolean; sentChosenModel: boolean };
  e2eeLifecycle: {
    saveStatus: number;
    getStatus: number;
    configured: boolean;
    returnedCiphertext: boolean;
    responseExposedVaultFields: boolean;
    storageShapeValid: boolean;
    replaceStatus: number;
    deleteStatus: number;
    deleted: boolean;
    cascadeDeleted: boolean;
  };
  e2eeGuards: {
    staleStatus: number;
    staleUnchanged: boolean;
    concurrentStaleStatus: number;
    concurrentStaleUnchanged: boolean;
    swappedStatus: number;
    swappedError: string | null;
    swappedUnchanged: boolean;
    legacyStatus: number;
    legacyError: string | null;
    plainTierStatus: number;
    malformedStatus: number;
    oversizedStatus: number;
  };
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
  const { byokTransportDeps } = await import("../aiCredentials/transport");

  await migrate(drizzle(sql, { schema: s }), { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  const users = await db
    .insert(s.users)
    .values([{ email: `vault-route-a-${crypto.randomUUID()}@test.local` }, { email: `vault-route-b-${crypto.randomUUID()}@test.local` }])
    .returning({ id: s.users.id });
  const userA = users[0]!.id;
  const userB = users[1]!.id;
  const [budgetA] = await db.insert(s.budgets).values({ userId: userA, name: "A" }).returning({ id: s.budgets.id });
  const [budgetB] = await db.insert(s.budgets).values({ userId: userB, name: "B" }).returning({ id: s.budgets.id });
  const [accountA] = await db.insert(s.accounts).values({ budgetId: budgetA!.id, name: "Checking" }).returning({ id: s.accounts.id });
  const marker = "sk-SENTINEL_ROUTE_SECRET";
  let sessionUser = userA;
  let probeCalls = 0;
  let probeSawKey = false;
  let sentVaultKey = false;
  let sentChosenModel = false;
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

    byokTransportDeps.fetchChat = async (payload, options) => {
      sentVaultKey ||= options.apiKey === marker;
      sentChosenModel ||= (payload as { model?: string }).model === "gpt-5.6-luna";
      const messages = (payload as { messages?: Array<{ content?: unknown }> }).messages;
      const vision = Array.isArray(messages?.[1]?.content);
      return Response.json({ choices: [{ message: { content: vision ? '{"rows":[]}' : "byok-answer" } }], model: "gpt-5.6-luna" });
    };
    const chatResponse = await app.request("/api/ai/byok/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetId: budgetA!.id, model: "gpt-5.6-luna", messages: [{ role: "user", content: "hello" }] }),
    });
    const chatBody = (await chatResponse.json()) as { content?: string };
    const importResponse = await app.request("/api/ai/byok/import/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetId: budgetA!.id, accountId: accountA!.id, model: "gpt-5.6-luna", images: ["data:image/png;base64,AA=="], locale: "pl" }),
    });
    const importBody = (await importResponse.json()) as { rows?: unknown[]; proposals?: unknown[] };

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

    const ciphertextA = "v2.AAAA";
    const ciphertextB = "v2.BBBB";
    const e2eeSave = await app.request("/api/ai/credentials/openai/e2ee", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetId: budgetB!.id, expectedEpoch: 1, ciphertext: ciphertextA }),
    });
    const e2eeGet = await app.request(`/api/ai/credentials/openai/e2ee?budgetId=${budgetB!.id}`);
    const e2eeGetText = await e2eeGet.text();
    const e2eeGetBody = JSON.parse(e2eeGetText) as { configured?: boolean; ciphertext?: string };
    const [e2eeStored] = await db.select().from(s.budgetAiCredentials).where(eq(s.budgetAiCredentials.budgetId, budgetB!.id));
    const e2eeReplace = await app.request("/api/ai/credentials/openai/e2ee", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetId: budgetB!.id, expectedEpoch: 1, ciphertext: ciphertextB }),
    });
    const [afterReplace] = await db.select().from(s.budgetAiCredentials).where(eq(s.budgetAiCredentials.budgetId, budgetB!.id));

    const staleBefore = JSON.stringify(afterReplace);
    const stale = await app.request("/api/ai/credentials/openai/e2ee", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetId: budgetB!.id, expectedEpoch: 0, ciphertext: "v2.CCCC" }),
    });
    const [afterStale] = await db.select().from(s.budgetAiCredentials).where(eq(s.budgetAiCredentials.budgetId, budgetB!.id));

    let releaseEpochRotation = () => {};
    let announceBudgetLock = () => {};
    const budgetLocked = new Promise<void>((resolve) => {
      announceBudgetLock = resolve;
    });
    const rotationMayCommit = new Promise<void>((resolve) => {
      releaseEpochRotation = resolve;
    });
    const rotateEpoch = db.transaction(async (tx) => {
      await tx.select({ id: s.budgets.id }).from(s.budgets).where(eq(s.budgets.id, budgetB!.id)).for("update");
      announceBudgetLock();
      await rotationMayCommit;
      await tx.update(s.budgets).set({ epoch: 2 }).where(eq(s.budgets.id, budgetB!.id));
    });
    await budgetLocked;
    const concurrentStalePromise = app.request("/api/ai/credentials/openai/e2ee", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetId: budgetB!.id, expectedEpoch: 1, ciphertext: "v2.CCCC" }),
    });
    await Bun.sleep(25);
    releaseEpochRotation();
    await rotateEpoch;
    const concurrentStale = await concurrentStalePromise;
    const [afterConcurrentStale] = await db.select().from(s.budgetAiCredentials).where(eq(s.budgetAiCredentials.budgetId, budgetB!.id));

    sessionUser = userA;
    const swapped = await app.request("/api/ai/credentials/openai/e2ee", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetId: budgetB!.id, expectedEpoch: 2, ciphertext: "v2.DDDD" }),
    });
    const swappedBody = (await swapped.json()) as { error?: string };
    const [afterSwapped] = await db.select().from(s.budgetAiCredentials).where(eq(s.budgetAiCredentials.budgetId, budgetB!.id));
    sessionUser = userB;

    await db.update(s.budgets).set({ cipherVersion: 1 }).where(eq(s.budgets.id, budgetB!.id));
    const legacy = await app.request(`/api/ai/credentials/openai/e2ee?budgetId=${budgetB!.id}`);
    const legacyBody = (await legacy.json()) as { error?: string };
    await db.update(s.budgets).set({ cipherVersion: 2, tier: "plain" }).where(eq(s.budgets.id, budgetB!.id));
    const plainTier = await app.request(`/api/ai/credentials/openai/e2ee?budgetId=${budgetB!.id}`);
    await db.update(s.budgets).set({ tier: "e2ee" }).where(eq(s.budgets.id, budgetB!.id));

    const malformed = await app.request("/api/ai/credentials/openai/e2ee", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetId: budgetB!.id, expectedEpoch: 1, ciphertext: "v1.AAAA" }),
    });
    const oversized = await app.request("/api/ai/credentials/openai/e2ee", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetId: budgetB!.id, expectedEpoch: 1, ciphertext: `v2.${"A".repeat(8190)}` }),
    });

    const e2eeDelete = await app.request("/api/ai/credentials/openai/e2ee", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetId: budgetB!.id, expectedEpoch: 2 }),
    });
    const [afterDelete] = await db.select().from(s.budgetAiCredentials).where(eq(s.budgetAiCredentials.budgetId, budgetB!.id));

    const [cascadeBudget] = await db
      .insert(s.budgets)
      .values({ userId: userB, name: "cascade", tier: "e2ee", cipherVersion: 2, epoch: 3, wrappedDek: "v2.x", kdfParams: "{}" })
      .returning({ id: s.budgets.id });
    await app.request("/api/ai/credentials/openai/e2ee", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetId: cascadeBudget!.id, expectedEpoch: 3, ciphertext: ciphertextA }),
    });
    await db.delete(s.budgets).where(eq(s.budgets.id, cascadeBudget!.id));
    const [afterCascade] = await db.select().from(s.budgetAiCredentials).where(eq(s.budgetAiCredentials.budgetId, cascadeBudget!.id));

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
      workloads: {
        chatStatus: chatResponse.status,
        chatContent: chatBody.content ?? null,
        importStatus: importResponse.status,
        importItems: importBody.proposals?.length ?? -1,
        sentVaultKey,
        sentChosenModel,
      },
      e2eeLifecycle: {
        saveStatus: e2eeSave.status,
        getStatus: e2eeGet.status,
        configured: e2eeGetBody.configured === true,
        returnedCiphertext: e2eeGetBody.ciphertext === ciphertextA,
        responseExposedVaultFields: /wrappedRecordDek|masterKeyId|recordVersion|storageKind/i.test(e2eeGetText),
        storageShapeValid:
          e2eeStored?.storageKind === "e2ee_ciphertext" &&
          e2eeStored.framingVersion === 2 &&
          e2eeStored.wrappedRecordDek === null &&
          e2eeStored.masterKeyId === null &&
          e2eeStored.e2eeEpoch === 1,
        replaceStatus: e2eeReplace.status,
        deleteStatus: e2eeDelete.status,
        deleted: !afterDelete,
        cascadeDeleted: !afterCascade,
      },
      e2eeGuards: {
        staleStatus: stale.status,
        staleUnchanged: staleBefore === JSON.stringify(afterStale),
        concurrentStaleStatus: concurrentStale.status,
        concurrentStaleUnchanged: staleBefore === JSON.stringify(afterConcurrentStale),
        swappedStatus: swapped.status,
        swappedError: swappedBody.error ?? null,
        swappedUnchanged: staleBefore === JSON.stringify(afterSwapped),
        legacyStatus: legacy.status,
        legacyError: legacyBody.error ?? null,
        plainTierStatus: plainTier.status,
        malformedStatus: malformed.status,
        oversizedStatus: oversized.status,
      },
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
