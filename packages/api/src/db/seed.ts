/**
 * Seed with SAMPLE data (anonymized — a dev tool, not prod).
 * Idempotent: wipes the budget and recreates it from scratch.
 * Run: bun run db:seed
 */
import { db, sql } from "./client";
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

// name, group, color, icon, allocation (add) for the current month
const ENVELOPES: Array<[string, string, string, string, number]> = [
  ["Mieszkanie", "Rachunki", "#ccd9b6", "house", 1800],
  ["Media", "Rachunki", "#8f84a8", "receipt", 250],
  ["Subskrypcje", "Rachunki", "#f0c84f", "play", 60],
  ["Jedzenie", "Życie", "#f1dca0", "food", 1200],
  ["Transport", "Życie", "#e7e1d4", "car", 300],
  ["Zdrowie", "Życie", "#f0d6cc", "heart", 150],
  ["Rozrywka", "Życie", "#aed6ea", "gift", 200],
  ["Oszczędności", "Oszczędności", "#f3c45f", "moneybag", 500],
  ["Nieprzewidziane", "Oszczędności", "#e6e6ea", "tag", 100],
];

const CATEGORIES = ["Zakupy", "Dom", "Auto"];
const PLACES = ["Supermarket", "Stacja paliw", "Sklep osiedlowy"];

export async function seed() {
  console.log("Wiping and seeding the database…");
  await db.delete(s.users); // cascade removes the whole budget

  const [user] = await db.insert(s.users).values({ email: "demo@example.com" }).returning();
  const [budget] = await db
    .insert(s.budgets)
    .values({ userId: user!.id, name: "Budżet domowy" })
    .returning();
  const bid = budget!.id;

  const accRows = await db
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

  const groupRows = await db
    .insert(s.envelopeGroups)
    .values(GROUPS.map((name, i) => ({ budgetId: bid, name, sort: i })))
    .returning();
  const grp = (name: string) => groupRows.find((g) => g.name === name)!;

  const envRows = await db
    .insert(s.envelopes)
    .values(
      ENVELOPES.map(([name, group, color, icon], i) => ({
        budgetId: bid,
        groupId: grp(group).id,
        name,
        color,
        icon,
        sort: i,
      })),
    )
    .returning();
  const env = (name: string) => envRows.find((e) => e.name === name)!;

  await db.insert(s.categories).values(CATEGORIES.map((name) => ({ budgetId: bid, name })));
  await db.insert(s.places).values(PLACES.map((name) => ({ budgetId: bid, name })));

  // allocations for the current month (from the add column above)
  const month = new Date().toISOString().slice(0, 7);
  const allocs = ENVELOPES.filter(([, , , , add]) => add > 0).map(([name, , , , add]) => ({
    budgetId: bid,
    envelopeId: env(name).id,
    month,
    amount: PLN(add),
  }));
  if (allocs.length) await db.insert(s.allocations).values(allocs);

  // a handful of sample transactions in the current month
  const cat = async (name: string) => {
    const rows = await db.select().from(s.categories);
    return rows.find((c) => c.name === name)?.id ?? null;
  };
  const place = async (name: string) => {
    const rows = await db.select().from(s.places);
    return rows.find((p) => p.name === name)?.id ?? null;
  };
  const shoppingCat = await cat("Zakupy");
  const supermarket = await place("Supermarket");

  await db.insert(s.transactions).values([
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

  console.log(
    `✓ seed done: ${accRows.length} accounts, ${envRows.length} envelopes, ${allocs.length} allocations`,
  );
}

if (import.meta.main) {
  seed()
    .then(() => sql.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
