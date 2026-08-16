/**
 * DB-backed child scenario for automatic-envelope validation. The real app, REST error
 * handler, sync push transaction and restore route all share one throwaway database pool.
 * Imports stay lazy so sync.test.ts can import only the output contract safely.
 */

export const SENTINEL = "__SYNC_AUTOMATIC_ENVELOPE__";

type Result = { status: number; error: string | null };

export type AutomaticEnvelopeOutput = {
  rest: {
    validCreateStatus: number;
    foreignLink: Result;
    missingLink: Result;
    archivedLink: Result;
    offBudgetLink: Result;
    updateForeignLink: Result;
    updateMissingLink: Result;
    updateArchivedLink: Result;
    updateActiveLinkStatus: number;
    keepLinkOffBudget: Result;
    clearLinkOffBudgetStatus: number;
    failedPatchPreservedState: boolean;
    archiveLinked: Result;
    savingsChangeStatus: number;
    savingsChanged: boolean;
  };
  sync: {
    archivedLinkError: string | null;
    archivedLinkRowAbsent: boolean;
    archivedLinkClaimAbsent: boolean;
    archiveLinkedError: string | null;
    archiveLinkedPreserved: boolean;
    archiveLinkedClaimAbsent: boolean;
    historicalAllocationStatus: string | null;
  };
  restore: {
    offBudgetLink: Result;
    archivedLink: Result;
    originalAccountSurvived: boolean;
  };
};

async function main(): Promise<void> {
  const { assertThrowawayDb, emitChildResult } = await import("../api.test-support");
  const { env } = await import("../env");
  assertThrowawayDb(env.DATABASE_URL);

  const { and, eq } = await import("drizzle-orm");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { db, sql } = await import("../db/client");
  const s = await import("../db/schema");
  await migrate(drizzle(sql, { schema: s }), { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });

  const server = (await import("../index")).default;
  const base = env.BETTER_AUTH_URL;
  const request = (path: string, init: RequestInit = {}, cookie = "") => {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (cookie) headers.set("cookie", cookie);
    return server.fetch(new Request(`${base}${path}`, { ...init, headers }));
  };
  const jsonRequest = (path: string, method: string, body: unknown, cookie: string) => request(path, { method, body: JSON.stringify(body) }, cookie);
  const bodyOf = async (response: Response): Promise<Record<string, unknown>> => (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const resultOf = async (response: Response): Promise<Result> => {
    const body = await bodyOf(response);
    return { status: response.status, error: typeof body.error === "string" ? body.error : null };
  };

  const signUp = async (label: string) => {
    const response = await jsonRequest(
      "/api/auth/sign-up/email",
      "POST",
      { name: label, email: `${label}-${crypto.randomUUID()}@example.test`, password: "correct-horse-battery-staple" },
      "",
    );
    if (response.status !== 200) throw new Error(`signup ${label} failed: ${response.status} ${await response.text()}`);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    if (!cookie) throw new Error(`signup ${label} returned no session cookie`);
    return cookie;
  };

  const cookieA = await signUp("automatic-envelope-a");
  const cookieB = await signUp("automatic-envelope-b");

  const createGroup = async (cookie: string, name: string) => {
    const response = await jsonRequest("/api/groups", "POST", { name }, cookie);
    if (response.status !== 201) throw new Error(`group create failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as { id: string; budgetId: string };
  };
  const createEnvelope = async (cookie: string, groupId: string, name: string, archived = false) => {
    const response = await jsonRequest("/api/envelopes", "POST", { groupId, name, archived }, cookie);
    if (response.status !== 201) throw new Error(`envelope create failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as { id: string; budgetId: string };
  };

  const groupA = await createGroup(cookieA, "A group");
  const activeEnvelope = await createEnvelope(cookieA, groupA.id, "Active");
  const archivedEnvelope = await createEnvelope(cookieA, groupA.id, "Archived", true);
  const groupB = await createGroup(cookieB, "B group");
  const foreignEnvelope = await createEnvelope(cookieB, groupB.id, "Foreign");

  const validCreate = await jsonRequest("/api/accounts", "POST", { name: "Linked", onBudget: true, automaticEnvelopeId: activeEnvelope.id }, cookieA);
  const linkedAccount = (await bodyOf(validCreate)) as { id: string };
  if (typeof linkedAccount.id !== "string") throw new Error(`linked account was not created: ${validCreate.status}`);

  const foreignLink = await resultOf(
    await jsonRequest("/api/accounts", "POST", { name: "Foreign link", onBudget: true, automaticEnvelopeId: foreignEnvelope.id }, cookieA),
  );
  const missingLink = await resultOf(
    await jsonRequest("/api/accounts", "POST", { name: "Missing link", onBudget: true, automaticEnvelopeId: crypto.randomUUID() }, cookieA),
  );
  const archivedLink = await resultOf(
    await jsonRequest("/api/accounts", "POST", { name: "Archived link", onBudget: true, automaticEnvelopeId: archivedEnvelope.id }, cookieA),
  );
  const offBudgetLink = await resultOf(
    await jsonRequest("/api/accounts", "POST", { name: "Off-budget link", onBudget: false, automaticEnvelopeId: activeEnvelope.id }, cookieA),
  );

  const keepLinkOffBudget = await resultOf(await jsonRequest(`/api/accounts/${linkedAccount.id}`, "PATCH", { onBudget: false }, cookieA));
  const [afterFailedPatch] = await db
    .select({ onBudget: s.accounts.onBudget, automaticEnvelopeId: s.accounts.automaticEnvelopeId })
    .from(s.accounts)
    .where(eq(s.accounts.id, linkedAccount.id));
  const failedPatchPreservedState = afterFailedPatch?.onBudget === true && afterFailedPatch.automaticEnvelopeId === activeEnvelope.id;

  const clearLinkOffBudget = await jsonRequest(`/api/accounts/${linkedAccount.id}`, "PATCH", { onBudget: false, automaticEnvelopeId: null }, cookieA);
  const updateForeignLink = await resultOf(
    await jsonRequest(`/api/accounts/${linkedAccount.id}`, "PATCH", { onBudget: true, automaticEnvelopeId: foreignEnvelope.id }, cookieA),
  );
  const updateMissingLink = await resultOf(
    await jsonRequest(`/api/accounts/${linkedAccount.id}`, "PATCH", { onBudget: true, automaticEnvelopeId: crypto.randomUUID() }, cookieA),
  );
  const updateArchivedLink = await resultOf(
    await jsonRequest(`/api/accounts/${linkedAccount.id}`, "PATCH", { onBudget: true, automaticEnvelopeId: archivedEnvelope.id }, cookieA),
  );
  const relink = await jsonRequest(`/api/accounts/${linkedAccount.id}`, "PATCH", { onBudget: true, automaticEnvelopeId: activeEnvelope.id }, cookieA);
  if (relink.status !== 200) throw new Error(`relink failed: ${relink.status} ${await relink.text()}`);

  const archiveLinked = await resultOf(await jsonRequest(`/api/envelopes/${activeEnvelope.id}`, "PATCH", { archived: true }, cookieA));
  const savingsChange = await jsonRequest(`/api/envelopes/${activeEnvelope.id}`, "PATCH", { isSavings: true }, cookieA);
  const savingsBody = await bodyOf(savingsChange);

  const archivedCreateOpId = crypto.randomUUID();
  const archivedCreateAccountId = crypto.randomUUID();
  const archivedCreatePush = await jsonRequest(
    "/api/sync/push",
    "POST",
    {
      clientId: "automatic-envelope-test",
      budgetId: groupA.budgetId,
      ops: [
        {
          opId: archivedCreateOpId,
          kind: "account.create",
          payload: { id: archivedCreateAccountId, name: "Sync archived link", onBudget: true, automaticEnvelopeId: archivedEnvelope.id },
        },
      ],
    },
    cookieA,
  );
  const archivedCreatePushBody = (await bodyOf(archivedCreatePush)) as { results?: Array<{ status?: string; error?: string }> };
  const [archivedCreateRow] = await db.select({ id: s.accounts.id }).from(s.accounts).where(eq(s.accounts.id, archivedCreateAccountId));
  const [archivedCreateClaim] = await db.select({ opId: s.syncOps.opId }).from(s.syncOps).where(eq(s.syncOps.opId, archivedCreateOpId));

  const archiveOpId = crypto.randomUUID();
  const archivePush = await jsonRequest(
    "/api/sync/push",
    "POST",
    {
      clientId: "automatic-envelope-test",
      budgetId: groupA.budgetId,
      ops: [{ opId: archiveOpId, kind: "envelope.update", payload: { id: activeEnvelope.id, archived: true } }],
    },
    cookieA,
  );
  const archivePushBody = (await bodyOf(archivePush)) as { results?: Array<{ status?: string; error?: string }> };
  const [activeAfterRejectedArchive] = await db.select({ archived: s.envelopes.archived }).from(s.envelopes).where(eq(s.envelopes.id, activeEnvelope.id));
  const [archiveClaim] = await db.select({ opId: s.syncOps.opId }).from(s.syncOps).where(eq(s.syncOps.opId, archiveOpId));

  await jsonRequest(`/api/accounts/${linkedAccount.id}`, "PATCH", { automaticEnvelopeId: null }, cookieA);
  const archiveAfterUnlink = await jsonRequest(`/api/envelopes/${activeEnvelope.id}`, "PATCH", { archived: true }, cookieA);
  if (archiveAfterUnlink.status !== 200) throw new Error(`archive after unlink failed: ${archiveAfterUnlink.status}`);
  const allocationOpId = crypto.randomUUID();
  const allocationPush = await jsonRequest(
    "/api/sync/push",
    "POST",
    {
      clientId: "automatic-envelope-test",
      budgetId: groupA.budgetId,
      ops: [
        {
          opId: allocationOpId,
          kind: "txn.create",
          payload: {
            id: crypto.randomUUID(),
            type: "income",
            accountId: linkedAccount.id,
            amount: 100,
            date: "2026-08-16",
            allocationToEnvelopeId: activeEnvelope.id,
          },
        },
      ],
    },
    cookieA,
  );
  const allocationPushBody = (await bodyOf(allocationPush)) as { results?: Array<{ status?: string; error?: string }> };

  const restoreLedger = (accountOnBudget: boolean, envelopeArchived: boolean) => {
    const accountId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    const envelopeId = crypto.randomUUID();
    return {
      accounts: [
        {
          id: accountId,
          name: "Restore account",
          color: "#fff",
          icon: "wallet",
          type: "checking",
          onBudget: accountOnBudget,
          initialBalance: 0,
          archived: false,
          sort: 0,
          automaticEnvelopeId: envelopeId,
        },
      ],
      groups: [{ id: groupId, name: "Restore group", sort: 0 }],
      envelopes: [
        {
          id: envelopeId,
          groupId,
          name: "Restore envelope",
          color: "#fff",
          icon: "tag",
          note: null,
          monthlyTarget: null,
          isSavings: false,
          sort: 0,
          archived: envelopeArchived,
        },
      ],
      categories: [],
      places: [],
      allocations: [],
      transactions: [],
    };
  };
  const restoreOffBudget = await resultOf(await jsonRequest("/api/sync/replace", "POST", { ledger: restoreLedger(false, false) }, cookieA));
  const restoreArchived = await resultOf(await jsonRequest("/api/sync/replace", "POST", { ledger: restoreLedger(true, true) }, cookieA));
  const [originalAccount] = await db
    .select({ id: s.accounts.id })
    .from(s.accounts)
    .where(and(eq(s.accounts.id, linkedAccount.id), eq(s.accounts.budgetId, groupA.budgetId)));

  const out: AutomaticEnvelopeOutput = {
    rest: {
      validCreateStatus: validCreate.status,
      foreignLink,
      missingLink,
      archivedLink,
      offBudgetLink,
      updateForeignLink,
      updateMissingLink,
      updateArchivedLink,
      updateActiveLinkStatus: relink.status,
      keepLinkOffBudget,
      clearLinkOffBudgetStatus: clearLinkOffBudget.status,
      failedPatchPreservedState,
      archiveLinked,
      savingsChangeStatus: savingsChange.status,
      savingsChanged: savingsBody.isSavings === true,
    },
    sync: {
      archivedLinkError: archivedCreatePushBody.results?.[0]?.error ?? null,
      archivedLinkRowAbsent: !archivedCreateRow,
      archivedLinkClaimAbsent: !archivedCreateClaim,
      archiveLinkedError: archivePushBody.results?.[0]?.error ?? null,
      archiveLinkedPreserved: activeAfterRejectedArchive?.archived === false,
      archiveLinkedClaimAbsent: !archiveClaim,
      historicalAllocationStatus: allocationPushBody.results?.[0]?.status ?? null,
    },
    restore: {
      offBudgetLink: restoreOffBudget,
      archivedLink: restoreArchived,
      originalAccountSurvived: Boolean(originalAccount),
    },
  };

  await sql.end({ timeout: 5 });
  await emitChildResult(SENTINEL, out);
  process.exit(0);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
