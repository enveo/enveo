/**
 * Child process for the DB-backed sync2 / E2EE-v2 suite (sync2.db.test.ts) — NOT a test file
 * itself (bun's runner only picks up *.test.ts).
 *
 * WHAT IT PROVES (backlog §2, test group 5), against real Postgres through the REAL route
 * handlers and the real `db.transaction`:
 *  1. enable writes ciphertext format 2 (tier e2ee, cipher_version 2, epoch bump, checkpoint
 *     at 0, plaintext wiped) and refuses a stale nextEpoch expectation;
 *  2. normal v2 push/pull work and land in `e2ee_ops`;
 *  3. a LEGACY (cipher_version 1) budget gets 409 e2ee_upgrade_required from EVERY normal
 *     sync2 route — read and write alike — with nothing written;
 *  4. an old client's "v1." push body is a 400 at the schema boundary;
 *  5. the upgrade ceremony is atomic: epoch +1 exactly once, envelope rotated, the ENTIRE
 *     legacy journal deleted, checkpoint replaced at upto_seq 0;
 *  6. a retry of the SAME committed attempt is idempotent (200, no second epoch bump);
 *     a different attempt against the upgraded budget is a stale-epoch 409;
 *  7. a FORCED mid-transaction failure (test-only trigger raising on a marker blob) rolls
 *     back all effects — envelope, version, epoch and journal are untouched;
 *  8. two genuinely CONCURRENT upgrades of one budget produce one winner, one 409 and ONE
 *     generation (the stored envelope is the winner's);
 *  9. a cookie-swapped tenant (session ≠ body.userId) and a foreign budgetId write NOTHING;
 * 10. disable still restores the plaintext and clears all ciphertext state.
 *
 * WHY A SEPARATE PROCESS: the route handlers run on the POOLED `db` (db/client.ts), pinned to
 * `env.DATABASE_URL` at import time. The EXPECT_DATABASE_URL fuse refuses anything but the
 * throwaway Postgres.
 *
 * The legacy budget is a SYNTHETIC pre-upgrade fixture: rows written the way a pre-v2 server
 * left them (tier e2ee + "v1." ciphertexts) with cipher_version=1 — exactly the state
 * migration 0021 marks. This is test-fixture construction on a THROWAWAY database; production
 * must never flip cipher_version by SQL (see the migration header).
 *
 * Contract (all app imports are lazy):
 *   in  — EXPECT_DATABASE_URL (+ DATABASE_URL, both set to the same throwaway Postgres)
 *   out — one SENTINEL-prefixed JSON line on stdout: Sync2DbOutput
 */
import { assertThrowawayDb, emitChildResult } from "../api.test-support";

export const SENTINEL = "__SYNC2_DB_V2__";

export type Sync2DbOutput = {
  /* 1 — enable */
  enableStaleEpochStatus: number; // nextEpoch expectation off by one → 409, nothing flips
  enableStatus: number;
  enabledRow: { tier: string; cipherVersion: number; epoch: number; wrappedDek: string | null } | null;
  enableSnapshotUptoSeq: number | null;
  enablePlaintextWiped: boolean;
  enablePreferencesCleared: boolean;
  /* 2 — normal v2 push/pull */
  pushStatus: number;
  pulledOpIds: string[];
  pulledCiphertexts: string[];
  resetPreferencesCleared: boolean;
  /* 3 — legacy budget: every normal route refuses */
  legacyStatuses: Record<string, { status: number; error: string | null; budgetId: string | null; epoch: number | null; cipherVersion: number | null }>;
  legacyJournalIntactAfterRefusals: boolean;
  /* 4 — old client */
  v1PushStatus: number;
  /* 5..7 — upgrade ceremony */
  upgradeStatus: number;
  upgradeBody: { budgetId: string; epoch: number; cipherVersion: number; uptoSeq: number } | null;
  upgradedRow: { tier: string; cipherVersion: number; epoch: number; wrappedDek: string | null; kdfParams: string | null } | null;
  upgradeJournalRowCount: number; // must be 0 — the legacy journal is gone
  upgradeSnapshot: { uptoSeq: number; blob: string } | null;
  upgradePreferencesCleared: boolean;
  retryStatus: number; // idempotent same-attempt retry
  retryEpoch: number | null;
  epochAfterRetry: number | null; // still expectedEpoch+1 — never two bumps
  staleAttemptStatus: number; // different attempt after the upgrade
  staleAttemptEpochInBody: number | null;
  staleAttemptCipherVersionInBody: number | null; // round 3 (R2): the refusal re-teaches the format
  rowAfterStaleAttempt: { epoch: number; wrappedDek: string | null } | null;
  /* 7 — forced failure */
  forcedFailureStatus: number;
  rowAfterForcedFailure: { cipherVersion: number; epoch: number; wrappedDek: string | null } | null;
  journalIntactAfterForcedFailure: boolean;
  forcedFailurePreferencesPreserved: boolean;
  /* 8 — concurrency */
  concurrentStatuses: number[]; // sorted: [200, 409]
  concurrentEpoch: number | null; // exactly expectedEpoch+1
  concurrentEnvelopeIsAWinner: boolean; // stored wrapped_dek equals the 200 response's request
  /* 9 — tenant assertions */
  cookieSwapStatus: number;
  cookieSwapError: string | null;
  cookieSwapWroteNothing: boolean;
  foreignBudgetIdStatus: number;
  foreignBudgetIdError: string | null;
  /* 10 — disable */
  disableStatus: number;
  disabledRow: { tier: string; wrappedDek: string | null } | null;
  disableCipherStateCleared: boolean;
  disablePlaintextRestored: boolean;
  disablePreferencesRestored: boolean;
};

async function main(): Promise<void> {
  const { env } = await import("../env");
  // The fuse: this process writes users/budgets/e2ee rows and wipes budgets. Throwaway DB only.
  assertThrowawayDb(env.DATABASE_URL);

  const { eq } = await import("drizzle-orm");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const postgres = (await import("postgres")).default;
  const { Hono } = await import("hono");
  const { db } = await import("../db/client");
  const s = await import("../db/schema");
  const { sync2Routes } = await import("./sync2");
  const { TierMismatch } = await import("../context");
  const { ZodError } = await import("zod");

  // Migrations run on an independent connection (same folder the production migrator uses).
  const migrClient = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  await migrate(drizzle(migrClient), { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  await migrClient.end();

  const raw = postgres(env.DATABASE_URL, { max: 2, onnotice: () => {} });

  /* Minimal stand-in for index.ts's session middleware + error mapping (same contract). */
  let sessionUser = "";
  const app = new Hono<{ Variables: { userId?: string } }>();
  app.use("*", async (c, next) => {
    c.set("userId", sessionUser);
    await next();
  });
  app.route("/api", sync2Routes);
  app.onError((err, c) => {
    if (err instanceof TierMismatch) return c.json({ error: "tier_mismatch", tier: err.meta.tier, epoch: err.meta.epoch }, 409);
    if (err instanceof ZodError) return c.json({ error: "invalid_body" }, 400);
    return c.json({ error: "internal" }, 500);
  });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const jsonOf = async (res: Response): Promise<Record<string, unknown>> => (await res.json().catch(() => ({}))) as Record<string, unknown>;

  const uuid = () => crypto.randomUUID();
  const EMPTY_LEDGER = {
    accounts: [],
    groups: [],
    envelopes: [],
    categories: [],
    places: [],
    allocations: [],
    transactions: [],
  };

  const mkUser = async (tag: string): Promise<string> => {
    const [u] = await db
      .insert(s.users)
      .values({ email: `sync2-db-${tag}-${uuid()}@example.test` })
      .returning({ id: s.users.id });
    return u!.id;
  };
  const budgetRow = async (id: string) => {
    const [row] = await db
      .select({
        tier: s.budgets.tier,
        cipherVersion: s.budgets.cipherVersion,
        epoch: s.budgets.epoch,
        wrappedDek: s.budgets.wrappedDek,
        kdfParams: s.budgets.kdfParams,
        preferences: s.budgets.preferences,
      })
      .from(s.budgets)
      .where(eq(s.budgets.id, id));
    return row ?? null;
  };
  const journalCount = async (id: string): Promise<number> => {
    const rows = await db.select({ seq: s.e2eeOps.seq }).from(s.e2eeOps).where(eq(s.e2eeOps.budgetId, id));
    return rows.length;
  };

  /* ── 1. Enable → format 2 ─────────────────────────────────────────── */

  const userA = await mkUser("a");
  sessionUser = userA;
  const [bA] = await db
    .insert(s.budgets)
    .values({ userId: userA, name: "A", preferences: { schemaVersion: 1, aiProvider: "openai" } })
    .returning({ id: s.budgets.id });
  const budgetA = bA!.id;
  await db.insert(s.accounts).values({ budgetId: budgetA, name: "plain acc" }); // plaintext to wipe

  // a STALE epoch expectation must not install ciphertext bound to the wrong generation
  const enableStale = await call("POST", "/budget/e2ee/enable", {
    userId: userA,
    budgetId: budgetA,
    nextEpoch: 2, // actual is 0 → next is 1
    wrappedDek: "v2.wrapAAAA",
    kdfParams: "{}",
    snapshotBlob: "v2.snapAAAA",
  });
  const enableRes = await call("POST", "/budget/e2ee/enable", {
    userId: userA,
    budgetId: budgetA,
    nextEpoch: 1,
    wrappedDek: "v2.wrapAAAA",
    kdfParams: "{}",
    snapshotBlob: "v2.snapAAAA",
  });
  const enabledRow = await budgetRow(budgetA);
  const [enSnap] = await db.select({ uptoSeq: s.e2eeSnapshots.uptoSeq }).from(s.e2eeSnapshots).where(eq(s.e2eeSnapshots.budgetId, budgetA));
  const plainAfter = await db.select({ id: s.accounts.id }).from(s.accounts).where(eq(s.accounts.budgetId, budgetA));

  /* ── 2. Normal v2 push/pull ───────────────────────────────────────── */

  const op1 = uuid();
  const op2 = uuid();
  const pushRes = await call("POST", "/sync2/push", {
    epoch: 1,
    budgetId: budgetA,
    ops: [
      { opId: op1, ciphertext: "v2.op1AAAA" },
      { opId: op2, ciphertext: "v2.op2AAAA" },
    ],
  });
  const pullRes = await call("GET", "/sync2/pull?since=0&epoch=1");
  const pullBody = (await jsonOf(pullRes)) as unknown as { ops: Array<{ opId: string; ciphertext: string }> };

  await db
    .update(s.budgets)
    .set({ preferences: { leaked: true } })
    .where(eq(s.budgets.id, budgetA));
  await call("POST", "/sync2/reset", { userId: userA, epoch: 1, snapshotBlob: "v2.resetAAAA" });
  const afterReset = await budgetRow(budgetA);

  // an OLD CLIENT (pre-v2 build) pushing v1 ciphertext against a v2 budget: rejected at the
  // schema boundary (400), never stored. (Against a LEGACY budget the same push meets the
  // cipher-version guard first and 409s — asserted with the other legacy refusals below.)
  const v1Push = await call("POST", "/sync2/push", { epoch: 1, ops: [{ opId: uuid(), ciphertext: "v1.oldClient" }] });

  /* ── 3+4. The LEGACY budget (synthetic pre-upgrade fixture) ───────── */

  const userL = await mkUser("legacy");
  sessionUser = userL;
  const [bL] = await db
    .insert(s.budgets)
    .values({
      userId: userL,
      name: "L",
      tier: "e2ee",
      epoch: 1,
      wrappedDek: "v1.legacyWrap",
      kdfParams: "{}",
      cipherVersion: 1,
      preferences: { legacyLeak: true },
    })
    .returning({ id: s.budgets.id });
  const budgetL = bL!.id;
  const legacyOps = [uuid(), uuid(), uuid()];
  await db.insert(s.e2eeOps).values(legacyOps.map((opId) => ({ budgetId: budgetL, opId, ciphertext: "v1.legacyOp" })));
  await db.insert(s.e2eeSnapshots).values({ budgetId: budgetL, uptoSeq: 2, blob: "v1.legacyBlob" });

  const legacyCalls: Record<string, Response> = {
    pushV2: await call("POST", "/sync2/push", { epoch: 1, budgetId: budgetL, ops: [{ opId: uuid(), ciphertext: "v2.freshAAAA" }] }),
    pull: await call("GET", "/sync2/pull?since=0&epoch=1"),
    snapshotGet: await call("GET", "/sync2/snapshot"),
    snapshotPost: await call("POST", "/sync2/snapshot", { userId: userL, epoch: 1, uptoSeq: 3, blob: "v2.freshBlob" }),
    rekey: await call("POST", "/sync2/rekey", { userId: userL, wrappedDek: "v2.freshWrap", kdfParams: "{}" }),
    reset: await call("POST", "/sync2/reset", { userId: userL, epoch: 1, snapshotBlob: "v2.freshBlob" }),
    disable: await call("POST", "/budget/e2ee/disable", { userId: userL, confirm: "DISABLE-E2EE", ledger: EMPTY_LEDGER }),
  };
  const legacyStatuses: Sync2DbOutput["legacyStatuses"] = {};
  for (const [name, res] of Object.entries(legacyCalls)) {
    const body = await jsonOf(res);
    legacyStatuses[name] = {
      status: res.status,
      error: (body.error as string) ?? null,
      budgetId: (body.budgetId as string) ?? null,
      epoch: (body.epoch as number) ?? null,
      cipherVersion: (body.cipherVersion as number) ?? null,
    };
  }
  const legacyRowAfter = await budgetRow(budgetL);
  const legacyJournalIntactAfterRefusals =
    (await journalCount(budgetL)) === 3 && legacyRowAfter?.cipherVersion === 1 && legacyRowAfter.epoch === 1 && legacyRowAfter.wrappedDek === "v1.legacyWrap";

  /* ── 9a. Tenant assertions on the upgrade route (BEFORE the real upgrade) ── */

  // userB gets an E2EE v2 budget of their OWN — a userB session must reach the OWNER assertion
  // and fail exactly there (409 budget_mismatch). Without it, requireTier would lazily create
  // a PLAIN budget for B and throw TierMismatch, and the test would pass with the assertion
  // deleted (the 409 would come from the tier guard — a vacuous scenario).
  const userB = await mkUser("b");
  const [bB] = await db
    .insert(s.budgets)
    .values({ userId: userB, name: "B", tier: "e2ee", epoch: 1, wrappedDek: "v2.wrapB", kdfParams: "{}", cipherVersion: 2 })
    .returning({ id: s.budgets.id });
  const budgetB = bB!.id;
  const upgradeBodyOf = (wrappedDek: string) => ({
    budgetId: budgetL,
    userId: userL,
    expectedEpoch: 1,
    cipherVersion: 2,
    wrappedDek,
    kdfParams: JSON.stringify({ algo: "argon2id", m: 65536, t: 3, p: 1, saltB64: "AAAA" }),
    snapshotBlob: "v2.newCheckpointAAAA",
  });
  // the shared cookie was swapped to B mid-ceremony: session ≠ the userId the client verified.
  // The body still names L's budget and L's user; B's session resolves B's own e2ee budget, so
  // the request must die on the per-request assertions — with the budget_mismatch CODE.
  sessionUser = userB;
  const cookieSwap = await call("POST", "/budget/e2ee/upgrade-v2", upgradeBodyOf("v2.newWrapSWAP"));
  const cookieSwapBody = await jsonOf(cookieSwap);
  sessionUser = userL;
  const rowAfterSwap = await budgetRow(budgetL);
  const rowBAfterSwap = await budgetRow(budgetB);
  const cookieSwapWroteNothing =
    rowAfterSwap?.cipherVersion === 1 &&
    rowAfterSwap.wrappedDek === "v1.legacyWrap" &&
    (await journalCount(budgetL)) === 3 &&
    // …and B's own budget was not touched either (no stray epoch bump / envelope swap)
    rowBAfterSwap?.epoch === 1 &&
    rowBAfterSwap.wrappedDek === "v2.wrapB";
  // a body naming ANOTHER budget than the session's (same session as the target's owner)
  const foreignBudgetId = await call("POST", "/budget/e2ee/upgrade-v2", { ...upgradeBodyOf("v2.newWrapFOREIGN"), budgetId: budgetA });
  const foreignBudgetIdBody = await jsonOf(foreignBudgetId);

  /* ── 7. Forced mid-transaction failure → full rollback ────────────── */

  // Test-only trigger on the THROWAWAY database: raise when the checkpoint upsert carries the
  // marker blob. The snapshot upsert is the LAST write of the upgrade transaction, so an error
  // there proves the earlier envelope UPDATE and journal DELETE roll back with it.
  await raw`
    CREATE OR REPLACE FUNCTION test_fail_snapshot() RETURNS trigger AS $$
    BEGIN
      IF NEW.blob LIKE 'v2.FAIL%' THEN RAISE EXCEPTION 'forced test failure'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`;
  await raw`
    CREATE TRIGGER test_fail_snapshot BEFORE INSERT OR UPDATE ON e2ee_snapshots
    FOR EACH ROW EXECUTE FUNCTION test_fail_snapshot()`;
  const forcedFailure = await call("POST", "/budget/e2ee/upgrade-v2", { ...upgradeBodyOf("v2.newWrapFAIL"), snapshotBlob: "v2.FAILxxxx" });
  await raw`DROP TRIGGER test_fail_snapshot ON e2ee_snapshots`;
  await raw`DROP FUNCTION test_fail_snapshot()`;
  const rowAfterForcedFailure = await budgetRow(budgetL);
  const journalIntactAfterForcedFailure = (await journalCount(budgetL)) === 3;

  /* ── 5. The upgrade ceremony succeeds ─────────────────────────────── */

  const upgradeRes = await call("POST", "/budget/e2ee/upgrade-v2", upgradeBodyOf("v2.newWrapWINNER"));
  const upgradeBody = (await jsonOf(upgradeRes)) as unknown as Sync2DbOutput["upgradeBody"];
  const upgradedRow = await budgetRow(budgetL);
  const upgradeJournalRowCount = await journalCount(budgetL);
  const [upSnap] = await db
    .select({ uptoSeq: s.e2eeSnapshots.uptoSeq, blob: s.e2eeSnapshots.blob })
    .from(s.e2eeSnapshots)
    .where(eq(s.e2eeSnapshots.budgetId, budgetL));

  /* ── 6. Idempotent retry vs. a different stale attempt ────────────── */

  const retryRes = await call("POST", "/budget/e2ee/upgrade-v2", upgradeBodyOf("v2.newWrapWINNER"));
  const retryBody = await jsonOf(retryRes);
  const rowAfterRetry = await budgetRow(budgetL);
  const staleRes = await call("POST", "/budget/e2ee/upgrade-v2", upgradeBodyOf("v2.newWrapLOSER"));
  const staleBody = await jsonOf(staleRes);
  const rowAfterStale = await budgetRow(budgetL);

  /* ── 8. Two CONCURRENT upgrades → one generation ──────────────────── */

  const userC = await mkUser("c");
  sessionUser = userC;
  const [bC] = await db
    .insert(s.budgets)
    .values({ userId: userC, name: "C", tier: "e2ee", epoch: 4, wrappedDek: "v1.legacyWrapC", kdfParams: "{}", cipherVersion: 1 })
    .returning({ id: s.budgets.id });
  const budgetC = bC!.id;
  await db.insert(s.e2eeOps).values({ budgetId: budgetC, opId: uuid(), ciphertext: "v1.legacyOpC" });
  const attempt = (wrappedDek: string) =>
    call("POST", "/budget/e2ee/upgrade-v2", {
      budgetId: budgetC,
      userId: userC,
      expectedEpoch: 4,
      cipherVersion: 2,
      wrappedDek,
      kdfParams: "{}",
      snapshotBlob: "v2.checkpointC",
    });
  const [c1, c2] = await Promise.all([attempt("v2.wrapDeviceONE"), attempt("v2.wrapDeviceTWO")]);
  const rowC = await budgetRow(budgetC);
  const winner = c1.status === 200 ? "v2.wrapDeviceONE" : "v2.wrapDeviceTWO";

  /* ── 10. Disable restores plaintext (on the upgraded v2 budget L) ─── */

  sessionUser = userL;
  const disableRes = await call("POST", "/budget/e2ee/disable", {
    userId: userL,
    confirm: "DISABLE-E2EE",
    ledger: {
      ...EMPTY_LEDGER,
      budgets: [
        {
          id: budgetL,
          name: "L",
          currency: "EUR",
          preferences: {
            schemaVersion: 1,
            aiProvider: "openai",
            openaiModel: "gpt-5.6-sol",
            customProfiles: [],
            startWidgets: [],
          },
        },
      ],
      accounts: [
        { id: uuid(), name: "restored", color: "#fff", icon: "wallet", type: "checking", onBudget: true, initialBalance: 0, archived: false, sort: 0 },
      ],
    },
  });
  const disabledRow = await budgetRow(budgetL);
  const disableOps = await journalCount(budgetL);
  const [disableSnap] = await db.select({ uptoSeq: s.e2eeSnapshots.uptoSeq }).from(s.e2eeSnapshots).where(eq(s.e2eeSnapshots.budgetId, budgetL));
  const restored = await db.select({ name: s.accounts.name }).from(s.accounts).where(eq(s.accounts.budgetId, budgetL));

  const out: Sync2DbOutput = {
    enableStaleEpochStatus: enableStale.status,
    enableStatus: enableRes.status,
    enabledRow: enabledRow && { tier: enabledRow.tier, cipherVersion: enabledRow.cipherVersion, epoch: enabledRow.epoch, wrappedDek: enabledRow.wrappedDek },
    enableSnapshotUptoSeq: enSnap?.uptoSeq ?? null,
    enablePlaintextWiped: plainAfter.length === 0,
    enablePreferencesCleared: enabledRow?.preferences === null,
    pushStatus: pushRes.status,
    pulledOpIds: pullBody.ops?.map((o) => o.opId) ?? [],
    pulledCiphertexts: pullBody.ops?.map((o) => o.ciphertext) ?? [],
    resetPreferencesCleared: afterReset?.preferences === null,
    legacyStatuses,
    legacyJournalIntactAfterRefusals,
    v1PushStatus: v1Push.status,
    upgradeStatus: upgradeRes.status,
    upgradeBody,
    upgradedRow: upgradedRow && {
      tier: upgradedRow.tier,
      cipherVersion: upgradedRow.cipherVersion,
      epoch: upgradedRow.epoch,
      wrappedDek: upgradedRow.wrappedDek,
      kdfParams: upgradedRow.kdfParams,
    },
    upgradeJournalRowCount,
    upgradeSnapshot: upSnap ?? null,
    upgradePreferencesCleared: upgradedRow?.preferences === null,
    retryStatus: retryRes.status,
    retryEpoch: (retryBody.epoch as number) ?? null,
    epochAfterRetry: rowAfterRetry?.epoch ?? null,
    staleAttemptStatus: staleRes.status,
    staleAttemptEpochInBody: (staleBody.epoch as number) ?? null,
    staleAttemptCipherVersionInBody: (staleBody.cipherVersion as number) ?? null,
    rowAfterStaleAttempt: rowAfterStale && { epoch: rowAfterStale.epoch, wrappedDek: rowAfterStale.wrappedDek },
    forcedFailureStatus: forcedFailure.status,
    rowAfterForcedFailure: rowAfterForcedFailure && {
      cipherVersion: rowAfterForcedFailure.cipherVersion,
      epoch: rowAfterForcedFailure.epoch,
      wrappedDek: rowAfterForcedFailure.wrappedDek,
    },
    journalIntactAfterForcedFailure,
    forcedFailurePreferencesPreserved: JSON.stringify(rowAfterForcedFailure?.preferences) === JSON.stringify({ legacyLeak: true }),
    concurrentStatuses: [c1.status, c2.status].sort((x, y) => x - y),
    concurrentEpoch: rowC?.epoch ?? null,
    concurrentEnvelopeIsAWinner: rowC?.wrappedDek === winner && (c1.status === 200) !== (c2.status === 200),
    cookieSwapStatus: cookieSwap.status,
    cookieSwapError: (cookieSwapBody.error as string) ?? null,
    cookieSwapWroteNothing,
    foreignBudgetIdStatus: foreignBudgetId.status,
    foreignBudgetIdError: (foreignBudgetIdBody.error as string) ?? null,
    disableStatus: disableRes.status,
    disabledRow: disabledRow && { tier: disabledRow.tier, wrappedDek: disabledRow.wrappedDek },
    disableCipherStateCleared: disableOps === 0 && disableSnap === undefined,
    disablePlaintextRestored: restored.length === 1 && restored[0]!.name === "restored",
    disablePreferencesRestored: (disabledRow?.preferences as { aiProvider?: string } | null)?.aiProvider === "openai",
  };

  await raw.end();
  await emitChildResult(SENTINEL, out);
  process.exit(0);
}

// Only when RUN as a process — importing this module (for SENTINEL) must have no side effects.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
