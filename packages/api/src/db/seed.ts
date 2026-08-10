/**
 * Seed with SAMPLE data (anonymized — a dev tool, not prod).
 * Idempotent: wipes all budgets and recreates the demo budget from scratch.
 * Users and auth rows survive: the demo attaches to the FIRST-REGISTERED user
 * (dev/E2E flow: register → seed → the account sees the demo data); a stub
 * owner is created only on an empty database.
 * Run: bun run db:seed
 *
 * SERIALIZED against lazy initial-budget creation (backlog §0b): this is the SECOND path that
 * turns "zero budgets" into the owner's first budget, and the documented dev flow runs it while
 * the stack is up — an open tab's sync cycle can ensure an empty budget in the exact window
 * between the wipe and the demo insert, leaving TWO budgets whose `ORDER BY id` winner is a
 * coin flip ("the seed didn't take"). Wipe + rebuild therefore run inside ONE transaction
 * holding the owner's `budget.ensure-initial` lock, exactly as the operation-lock module
 * demands of every first/default-budget path. (The wipe still clears OTHER users' budgets too —
 * unchanged dev-tool behavior; the lock is per-user and cannot serialize those.)
 */
import { asc } from "drizzle-orm";
import { db, sql, type DbTransaction } from "./client";
import { OPERATION_LOCK, operationLockKey, withOperationLock } from "./operationLock";
import * as s from "./schema";

const PLN = (z: number) => Math.round(z * 100); // złoty → grosz (major → minor units)

function isoShift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const ACCOUNTS = [
  { name: "Konto główne", bal: 2500, color: "#4f86bd", icon: "card", type: "checking" },
  { name: "Oszczędnościowe", bal: 8000, color: "#54c6bd", icon: "safe", type: "savings" },
  { name: "Gotówka", bal: 150, color: "#a86b40", icon: "wallet", type: "cash" },
  { name: "Inwestycje", bal: 12000, color: "#7ca968", icon: "receipt", type: "investment" },
];

const GROUPS = ["Rachunki", "Życie", "Oszczędności"];

// name, group, color, icon, allocation (add) for the current month, isSavings
const ENVELOPES: Array<[string, string, string, string, number, boolean?]> = [
  ["Mieszkanie", "Rachunki", "#ccd9b6", "house", 1800],
  ["Media", "Rachunki", "#8f84a8", "receipt", 250],
  ["Subskrypcje", "Rachunki", "#f0c84f", "play", 60],
  ["Jedzenie", "Życie", "#f1dca0", "food", 1200],
  ["Transport", "Życie", "#e7e1d4", "car", 300],
  ["Zdrowie", "Życie", "#f0d6cc", "heart", 150],
  ["Rozrywka", "Życie", "#aed6ea", "gift", 200],
  ["Oszczędności", "Oszczędności", "#f3c45f", "moneybag", 500, true],
  ["Nieprzewidziane", "Oszczędności", "#e6e6ea", "tag", 100, true],
];

const CATEGORIES = ["Zakupy", "Dom", "Auto"];
const PLACES = ["Supermarket", "Stacja paliw", "Sklep osiedlowy"];

export async function seed() {
  console.log("Wiping budgets and seeding the database…");

  // Ordered by REGISTRATION TIME, not by id: users.id is defaultRandom(), so ordering by it
  // hands the demo data to an arbitrary account as soon as a second one exists (the owner who
  // just registered would see an empty budget, and a stranger's account would get the demo).
  // Resolved BEFORE the lock — the lock key is that owner's id.
  const existing = await db
    .select({ id: s.users.id })
    .from(s.users)
    .orderBy(asc(s.users.createdAt), asc(s.users.id)) // id = deterministic tie-break
    .limit(1);
  const owner =
    existing[0] ??
    (await db.insert(s.users).values({ email: "owner@example.com" }).returning())[0]!;

  const { accounts, envelopes, allocations } = await withOperationLock(
    operationLockKey(OPERATION_LOCK.ensureInitialBudget, owner.id),
    (tx) => seedInto(tx, owner.id),
  );

  console.log(
    `✓ seed done: ${accounts} accounts, ${envelopes} envelopes, ${allocations} allocations`,
  );
}

/** The wipe + rebuild itself — one transaction, under the owner's ensure-initial lock. */
async function seedInto(
  tx: DbTransaction,
  ownerId: string,
): Promise<{ accounts: number; envelopes: number; allocations: number }> {
  await tx.delete(s.budgets); // cascade removes all budget data; users/auth stay

  const [budget] = await tx
    .insert(s.budgets)
    .values({ userId: ownerId, name: "Household budget" })
    .returning();
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
        initialBalance: PLN(a.bal),
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

  // allocations for the current month (from the add column above)
  const month = new Date().toISOString().slice(0, 7);
  const allocs = ENVELOPES.filter(([, , , , add]) => add > 0).map(([name, , , , add]) => ({
    budgetId: bid,
    envelopeId: env(name).id,
    month,
    amount: PLN(add),
  }));
  if (allocs.length) await tx.insert(s.allocations).values(allocs);

  // a handful of sample transactions in the current month
  const cat = async (name: string) => {
    const rows = await tx.select().from(s.categories);
    return rows.find((c) => c.name === name)?.id ?? null;
  };
  const place = async (name: string) => {
    const rows = await tx.select().from(s.places);
    return rows.find((p) => p.name === name)?.id ?? null;
  };
  const shoppingCat = await cat("Zakupy");
  const supermarket = await place("Supermarket");

  await tx.insert(s.transactions).values([
    {
      budgetId: bid,
      type: "expense" as const,
      accountId: acc("Konto główne").id,
      amount: PLN(326.21),
      date: isoShift(0),
      envelopeId: env("Jedzenie").id,
      categoryId: shoppingCat,
      placeId: supermarket,
      note: "Sklep spożywczy",
    },
    {
      budgetId: bid,
      type: "expense" as const,
      accountId: acc("Konto główne").id,
      amount: PLN(60.89),
      date: isoShift(0),
      envelopeId: env("Jedzenie").id,
      categoryId: shoppingCat,
    },
    {
      budgetId: bid,
      type: "expense" as const,
      accountId: acc("Konto główne").id,
      amount: PLN(1800),
      date: isoShift(-1),
      envelopeId: env("Mieszkanie").id,
      note: "Czynsz",
    },
    {
      budgetId: bid,
      type: "income" as const,
      accountId: acc("Konto główne").id,
      amount: PLN(6500),
      date: isoShift(-2),
      note: "Wypłata",
    },
    {
      budgetId: bid,
      type: "transfer" as const,
      accountId: acc("Konto główne").id,
      toAccountId: acc("Gotówka").id,
      amount: PLN(200),
      date: isoShift(-1),
      note: "Wypłata gotówki",
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
