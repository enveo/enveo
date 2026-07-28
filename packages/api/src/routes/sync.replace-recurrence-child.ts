


















import { eq } from "drizzle-orm";
import { Hono } from "hono";

export const SENTINEL = "__SYNC_REPLACE_RECURRENCE__";

export type ReplaceRecurrenceOutput = {
  status: number;
  budgetId: string;
  responseBudgetId: string | undefined;
  recurrencesCount: number;
  transactionRows: Array<{ amount: number; accountId: string }>;
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

  const recRows = await db.select().from(s.recurrences).where(eq(s.recurrences.budgetId, budgetId));
  const txnRows = await db
    .select({ amount: s.transactions.amount, accountId: s.transactions.accountId })
    .from(s.transactions)
    .where(eq(s.transactions.budgetId, budgetId));

  const out: ReplaceRecurrenceOutput = {
    status,
    budgetId,
    responseBudgetId: body.budgetId,
    recurrencesCount: recRows.length,
    transactionRows: txnRows,
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
