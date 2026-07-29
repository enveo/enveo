/**
 * Child process for the "POST /api/sync/replace accepts pre-3.2 recurrence fields" test in
 * sync.test.ts — NOT a test file itself (bun's runner only picks up *.test.ts).
 *
 * WHY A SEPARATE PROCESS. `routes/sync.ts` imports `db/client.ts`, which builds its Postgres
 * pool from `env.DATABASE_URL` at IMPORT time, and bun's test runner shares ONE module registry
 * across every test file in a run: whichever suite imports `db/client` first pins that pool for
 * the whole process — and locally (and on a real deployment host) `DATABASE_URL` is the REAL
 * database (see auth.signup-race-child.ts, which hit the exact same hazard first). Exercising
 * the real `/api/sync/replace` HANDLER — not just the pure input schema — means calling code
 * that does `db.transaction(...)` for real, so it must run in a fresh process that gets the
 * `DATABASE_URL` the test hands it. The EXPECT_DATABASE_URL fuse below refuses to run if that
 * disagrees with what the test expects, so this can never write into a real database.
 *
 * Contract (all app imports are lazy, so the test can import SENTINEL from here without pulling
 * in env/db/client):
 *   in  — EXPECT_DATABASE_URL (+ DATABASE_URL, set to the same throwaway Postgres by the test)
 *   out — one SENTINEL-prefixed JSON line on stdout: ReplaceRecurrenceOutput
 */
import { eq } from "drizzle-orm";
import { Hono } from "hono";

export const SENTINEL = "__SYNC_REPLACE_RECURRENCE__";

export type ReplaceRecurrenceOutput = {
  status: number;
  budgetId: string;
  responseBudgetId: string | undefined;
  transactionRows: Array<{ amount: number; accountId: string }>;
  // information_schema ground truth — proves the recurrence objects are GONE from the database,
  // not merely unused by this code path (a future re-introduction of `recurrences` must fail
  // this loudly instead of silently importing pre-3.2 backups into a resurrected table).
  recurrencesTableExists: boolean;
  transactionsPlannedColumnExists: boolean;
  transactionsRecurrenceIdColumnExists: boolean;
};

async function main(): Promise<void> {
  const expected = process.env.EXPECT_DATABASE_URL ?? "";
  const { env } = await import("../env");
  // The fuse: this process is about to WRITE (wipe + insert) a budget's data. It may only
  // ever do that against the throwaway database the test handed it.
  if (!expected || env.DATABASE_URL !== expected) {
    throw new Error(
      `refusing to run: env.DATABASE_URL is not the throwaway database given by the test ` +
        `(EXPECT_DATABASE_URL=${expected || "<unset>"})`,
    );
  }

  const { db, sql } = await import("../db/client");
  const s = await import("../db/schema");
  const { syncRoutes } = await import("./sync");

  const [user] = await db
    .insert(s.users)
    .values({ email: `replace-compat-child-${crypto.randomUUID()}@example.test` })
    .returning({ id: s.users.id });
  const [budget] = await db
    .insert(s.budgets)
    .values({ userId: user!.id, name: "backup-compat" })
    .returning({ id: s.budgets.id });
  const budgetId = budget!.id;

  // Minimal stand-in for index.ts's session middleware: sets the same context variable
  // requireTier/getBudgetId read, without pulling in a real better-auth sign-in.
  const app = new Hono<{ Variables: { userId?: string } }>();
  app.use("*", async (c, next) => {
    c.set("userId", user!.id);
    await next();
  });
  app.route("/api", syncRoutes);

  const accId = crypto.randomUUID();
  const ledgerWithRecurrence = {
    accounts: [
      { id: accId, name: "Checking", color: "#fff", icon: "wallet", type: "checking", onBudget: true, initialBalance: 0, archived: false, sort: 0 },
    ],
    groups: [],
    envelopes: [],
    categories: [],
    places: [],
    recurrences: [
      { id: crypto.randomUUID(), rule: "monthly", startDate: "2026-01-01", endDate: null, pausedUntil: null },
    ],
    allocations: [],
    transactions: [
      {
        id: crypto.randomUUID(),
        type: "expense",
        accountId: accId,
        toAccountId: null,
        amount: 500,
        date: "2026-01-01",
        confirmed: true,
        isRefund: false,
        envelopeId: null,
        placeId: null,
        categoryId: null,
        name: null,
        note: null,
        tag: null,
        planned: false,
        recurrenceId: null,
        items: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      // A legacy `planned: true` TEMPLATE row (recurring-payments feature, pre-3.2). These were
      // always excluded from every ledger computation — clientLedgerSchema's preprocess must
      // drop it before it ever reaches `restoreLedger`/`insertLedger`, so it must NOT show up in
      // `transactionRows` below (it would otherwise materialize as real money on restore).
      {
        id: crypto.randomUUID(),
        type: "expense",
        accountId: accId,
        toAccountId: null,
        amount: 999999,
        date: "2026-01-01",
        confirmed: true,
        isRefund: false,
        envelopeId: null,
        placeId: null,
        categoryId: null,
        name: null,
        note: null,
        tag: null,
        planned: true,
        recurrenceId: null,
        items: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };

  const res = await app.fetch(
    new Request("http://x/api/sync/replace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ledger: ledgerWithRecurrence }),
    }),
  );
  const status = res.status;
  const body = (await res.json().catch(() => ({}))) as { budgetId?: string };

  const txnRows = await db
    .select({ amount: s.transactions.amount, accountId: s.transactions.accountId })
    .from(s.transactions)
    .where(eq(s.transactions.budgetId, budgetId));

  // The DB ground truth (not just "no code references it"): the `recurrences` table and the
  // `transactions.planned`/`recurrence_id` columns must actually be absent (migration 0018).
  const [tableRow] = await sql<{ exists: boolean }[]>`
    select exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'recurrences'
    ) as exists
  `;
  const columnRows = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'transactions'
      and column_name in ('planned', 'recurrence_id')
  `;

  const out: ReplaceRecurrenceOutput = {
    status,
    budgetId,
    responseBudgetId: body.budgetId,
    transactionRows: txnRows,
    recurrencesTableExists: tableRow!.exists,
    transactionsPlannedColumnExists: columnRows.some((r) => r.column_name === "planned"),
    transactionsRecurrenceIdColumnExists: columnRows.some((r) => r.column_name === "recurrence_id"),
  };

  await sql.end({ timeout: 5 });
  await Bun.write(Bun.stdout, `${SENTINEL}${JSON.stringify(out)}\n`);
  process.exit(0);
}

// Only when RUN as a process — importing this module (for SENTINEL) must have no side effects.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
