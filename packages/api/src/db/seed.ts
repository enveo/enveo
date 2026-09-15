import { and, eq } from "drizzle-orm";
import { assertSeedEnv } from "../env";
import { type DbTransaction, db, sql } from "./client";
import { OPERATION_LOCK, operationLockKey, withOperationLock } from "./operationLock";
import * as s from "./schema";

const USD = (z: number) => Math.round(z * 100);

function isoShift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const ACCOUNTS = [
  { name: "Maple Harbor Checking", bal: 1200, color: "#4f86bd", icon: "card", type: "checking" },
  { name: "Prairie Savings", bal: 3200, color: "#54c6bd", icon: "safe", type: "savings" },
  { name: "Pocket Cash", bal: 80, color: "#a86b40", icon: "wallet", type: "cash" },
  { name: "Example Investments", bal: 5000, color: "#7ca968", icon: "receipt", type: "investment" },
];

const GROUPS = ["Bills", "Everyday", "Savings"];

const ENVELOPES: Array<[string, string, string, string, number, boolean?]> = [
  ["Housing", "Bills", "#ccd9b6", "house", 1800],
  ["Utilities", "Bills", "#8f84a8", "receipt", 250],
  ["Subscriptions", "Bills", "#f0c84f", "play", 60],
  ["Food", "Everyday", "#f1dca0", "food", 1200],
  ["Transport", "Everyday", "#e7e1d4", "car", 300],
  ["Health", "Everyday", "#f0d6cc", "heart", 150],
  ["Fun", "Everyday", "#aed6ea", "gift", 200],
  ["Savings", "Savings", "#f3c45f", "moneybag", 500, true],
  ["Contingency", "Savings", "#e6e6ea", "tag", 100, true],
];

const CATEGORIES = ["Shopping", "Home", "Car"];
const PLACES = ["Example Market", "Example Fuel", "Example Corner Store"];

export async function seed() {
  assertSeedEnv();
  const { auth } = await import("../auth");
  const ctx = await auth.$context;
  const password = await ctx.password.hash("Example-Demo-2026!");

  await db.insert(s.users).values({ email: "demo@example.test", name: "Demo User" }).onConflictDoNothing();
  const [owner] = await db.select({ id: s.users.id }).from(s.users).where(eq(s.users.email, "demo@example.test"));
  if (!owner) throw new Error("Could not create the demo account.");

  const { accounts, envelopes, allocations } = await withOperationLock(operationLockKey(OPERATION_LOCK.ensureInitialBudget, owner.id), async (tx) => {
    const credential = and(eq(s.authAccounts.userId, owner.id), eq(s.authAccounts.providerId, "credential"));
    const [existing] = await tx.select({ id: s.authAccounts.id }).from(s.authAccounts).where(credential).limit(1);
    if (existing) {
      await tx.update(s.authAccounts).set({ password, updatedAt: new Date() }).where(credential);
    } else {
      await tx.insert(s.authAccounts).values({ id: crypto.randomUUID(), userId: owner.id, accountId: owner.id, providerId: "credential", password });
    }
    await tx.delete(s.authSessions).where(eq(s.authSessions.userId, owner.id));
    return seedInto(tx, owner.id);
  });

  console.log(`✓ seed done: ${accounts} accounts, ${envelopes} envelopes, ${allocations} allocations`);
}

async function seedInto(tx: DbTransaction, ownerId: string): Promise<{ accounts: number; envelopes: number; allocations: number }> {
  await tx.delete(s.budgets).where(eq(s.budgets.userId, ownerId)); // cascade removes only demo budget data

  const [budget] = await tx.insert(s.budgets).values({ userId: ownerId, name: "Sample household", currency: "USD" }).returning();
  const bid = budget!.id;

  const accRows = await tx
    .insert(s.accounts)
    .values(
      ACCOUNTS.map((a, i) => ({
        budgetId: bid,
        name: a.name,
        color: a.color,
        icon: a.icon,
        type: a.type,
        onBudget: true,
        initialBalance: USD(a.bal),
        sort: i,
      })),
    )
    .returning();
  const acc = (name: string) => accRows.find((a) => a.name === name)!;

  const groupRows = await tx
    .insert(s.envelopeGroups)
    .values(GROUPS.map((name, i) => ({ budgetId: bid, name, sort: i })))
    .returning();
  const grp = (name: string) => groupRows.find((g) => g.name === name)!;

  const envRows = await tx
    .insert(s.envelopes)
    .values(
      ENVELOPES.map(([name, group, color, icon, , isSavings], i) => ({
        budgetId: bid,
        groupId: grp(group).id,
        name,
        color,
        icon,
        sort: i,
        ...(isSavings ? { isSavings: true } : {}),
      })),
    )
    .returning();
  const env = (name: string) => envRows.find((e) => e.name === name)!;

  await tx.insert(s.categories).values(CATEGORIES.map((name) => ({ budgetId: bid, name })));
  await tx.insert(s.places).values(PLACES.map((name) => ({ budgetId: bid, name })));

  const month = new Date().toISOString().slice(0, 7);
  const allocs = ENVELOPES.filter(([, , , , add]) => add > 0).map(([name, , , , add]) => ({
    budgetId: bid,
    envelopeId: env(name).id,
    month,
    amount: USD(add),
  }));
  if (allocs.length) await tx.insert(s.allocations).values(allocs);

  const cat = async (name: string) => {
    const rows = await tx.select().from(s.categories).where(eq(s.categories.budgetId, bid));
    return rows.find((c) => c.name === name)?.id ?? null;
  };
  const place = async (name: string) => {
    const rows = await tx.select().from(s.places).where(eq(s.places.budgetId, bid));
    return rows.find((p) => p.name === name)?.id ?? null;
  };
  const shoppingCat = await cat("Shopping");
  const supermarket = await place("Example Market");

  await tx.insert(s.transactions).values([
    {
      budgetId: bid,
      type: "expense" as const,
      accountId: acc("Maple Harbor Checking").id,
      amount: USD(47.25),
      date: isoShift(0),
      envelopeId: env("Food").id,
      categoryId: shoppingCat,
      placeId: supermarket,
      note: "Weekly groceries",
    },
    {
      budgetId: bid,
      type: "expense" as const,
      accountId: acc("Maple Harbor Checking").id,
      amount: USD(12.8),
      date: isoShift(0),
      envelopeId: env("Food").id,
      categoryId: shoppingCat,
    },
    {
      budgetId: bid,
      type: "expense" as const,
      accountId: acc("Maple Harbor Checking").id,
      amount: USD(900),
      date: isoShift(-1),
      envelopeId: env("Housing").id,
      note: "Rent",
    },
    {
      budgetId: bid,
      type: "income" as const,
      accountId: acc("Maple Harbor Checking").id,
      amount: USD(4200),
      date: isoShift(-2),
      note: "Example Payroll",
    },
    {
      budgetId: bid,
      type: "transfer" as const,
      accountId: acc("Maple Harbor Checking").id,
      toAccountId: acc("Pocket Cash").id,
      amount: USD(75),
      date: isoShift(-1),
      note: "Cash withdrawal",
    },
  ]);

  return { accounts: accRows.length, envelopes: envRows.length, allocations: allocs.length };
}

if (import.meta.main) {
  seed()
    .then(() => sql.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
