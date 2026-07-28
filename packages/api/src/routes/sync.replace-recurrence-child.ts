


















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
