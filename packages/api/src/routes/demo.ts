/**
 * Onboarding: neutral demo dataset + budget reset.
 *
 * POST /demo/seed   — fills an EMPTY budget with sample data (PL/EN);
 *                     guard: any account or transaction ⇒ 409.
 * POST /budget/reset — wipes ALL budget data (confirm: "RESET");
 *                     the `budgets` row stays (stable id + currency).
 */
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireTier, sessionUserId } from "../context";
import { db } from "../db/client";
import * as s from "../db/schema";
import { wipeBudgetData } from "../sync/apply";
import { ownerAssertionFails } from "./sync";

export const demoRoutes = new Hono();

/* Both writes below resolve the target budget from the session cookie alone, and the cookie
 * can be swapped between the client's ownership check and the request — so, like
 * /sync/replace, the body names the USER the client just verified and a mismatch is refused
 * before anything is written (409 budget_mismatch). Absent userId = pre-3.7 client. */

/** Body of /demo/seed. */
export const seedInput = z.object({
  locale: z.enum(["pl", "en"]).optional(),
  userId: z.string().min(1).optional(),
});

/** Body of /budget/reset. */
export const resetInput = z.object({
  confirm: z.literal("RESET"),
  userId: z.string().min(1).optional(),
});

/** Złoty → grosz, major → minor units (int). */
const zl = (x: number) => Math.round(x * 100);

type Locale = "pl" | "en";

/** 'YYYY-MM' plus a 'YYYY-MM-DD' date factory for the month current−offset. */
function monthAt(offset: number): { ym: string; day: (d: number) => string } {
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const ym = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}`;
  return { ym, day: (d: number) => `${ym}-${String(d).padStart(2, "0")}` };
}

/* ── Demo names (PL/EN) — data, not UI, so they don't go through web i18n ── */

const NAMES: Record<Locale, {
  accounts: [string, string, string];
  groups: [string, string, string];
  env: Record<
    "housing" | "utilities" | "subs" | "groceries" | "transport" | "health" | "fun" | "savings" | "rainy",
    string
  >;
  categories: [string, string, string]; // Shopping, Home, Car
  places: [string, string]; // Supermarket, Gas station
  tx: { salary: string; rent: string; utilities: string; subs: string; groceries: string; fuel: string; fun: string; health: string };
}> = {
  pl: {
    accounts: ["Konto osobiste", "Oszczędnościowe", "Gotówka"],
    groups: ["Rachunki", "Życie", "Oszczędności"],
    env: {
      housing: "Mieszkanie",
      utilities: "Media",
      subs: "Subskrypcje",
      groceries: "Jedzenie",
      transport: "Transport",
      health: "Zdrowie",
      fun: "Rozrywka",
      savings: "Oszczędności",
      rainy: "Nieprzewidziane",
    },
    categories: ["Zakupy", "Dom", "Auto"],
    places: ["Supermarket", "Stacja paliw"],
    tx: {
      salary: "Wypłata",
      rent: "Czynsz",
      utilities: "Prąd i gaz",
      subs: "Subskrypcje",
      groceries: "Zakupy spożywcze",
      fuel: "Paliwo",
      fun: "Kino i kolacja",
      health: "Apteka",
    },
  },
  en: {
    accounts: ["Personal checking", "Savings", "Cash"],
    groups: ["Bills", "Living", "Savings"],
    env: {
      housing: "Housing",
      utilities: "Utilities",
      subs: "Subscriptions",
      groceries: "Groceries",
      transport: "Transport",
      health: "Health",
      fun: "Fun",
      savings: "Savings",
      rainy: "Rainy day",
    },
    categories: ["Shopping", "Home", "Car"],
    places: ["Supermarket", "Gas station"],
    tx: {
      salary: "Salary",
      rent: "Rent",
      utilities: "Power & gas",
      subs: "Subscriptions",
      groceries: "Groceries",
      fuel: "Fuel",
      fun: "Movies & dinner",
      health: "Pharmacy",
    },
  },
};

/** Monthly allocations (PLN) per envelope. */
const ALLOC: Record<keyof (typeof NAMES)["pl"]["env"], number> = {
  housing: 1800,
  utilities: 250,
  subs: 60,
  groceries: 1200,
  transport: 300,
  health: 150,
  fun: 200,
  savings: 500,
  rainy: 100,
};

/** Grocery amounts (PLN) — 4 per month, row = month offset. */
const GROCERY_AMOUNTS: number[][] = [
  [286.4, 312.15, 295.3, 304.5],
  [281.9, 318.6, 302.45, 289.7],
  [297.2, 284.35, 315.8, 308.1],
];

demoRoutes.post("/demo/seed", async (c) => {
  const { locale, userId } = seedInput.parse(await c.req.json().catch(() => ({})));
  if (ownerAssertionFails(userId, sessionUserId(c))) return c.json({ error: "budget_mismatch" }, 409);
  const n = NAMES[(locale ?? "pl") as Locale];

  const seeded = await db.transaction(async (tx) => {
    const budgetId = (await requireTier(c, "plain", tx)).id;

    // Empty-budget guard: any account OR transaction ⇒ refuse.
    const [anyAccount] = await tx
      .select({ id: s.accounts.id })
      .from(s.accounts)
      .where(eq(s.accounts.budgetId, budgetId))
      .limit(1);
    const [anyTxn] = await tx
      .select({ id: s.transactions.id })
      .from(s.transactions)
      .where(eq(s.transactions.budgetId, budgetId))
      .limit(1);
    if (anyAccount || anyTxn) return false;

    /* Accounts */
    const accRows = await tx
      .insert(s.accounts)
      .values([
        { budgetId, name: n.accounts[0], type: "checking", initialBalance: zl(2500), color: "#4f86bd", icon: "card", sort: 0 },
        { budgetId, name: n.accounts[1], type: "savings", initialBalance: zl(8000), color: "#54c6bd", icon: "safe", sort: 1 },
        { budgetId, name: n.accounts[2], type: "cash", initialBalance: zl(150), color: "#a86b40", icon: "wallet", sort: 2 },
      ])
      .returning();
    const checking = accRows[0]!;

    /* Envelope groups */
    const groupRows = await tx
      .insert(s.envelopeGroups)
      .values(n.groups.map((name, i) => ({ budgetId, name, sort: i })))
      .returning();
    const [bills, living, savingsGrp] = [groupRows[0]!, groupRows[1]!, groupRows[2]!];

    /* Envelopes */
    const envDefs: Array<{
      key: keyof typeof n.env;
      groupId: string;
      color: string;
      icon: string;
      monthlyTarget?: number;
      isSavings?: boolean;
    }> = [
      { key: "housing", groupId: bills.id, color: "#ccd9b6", icon: "house", monthlyTarget: zl(1800) },
      { key: "utilities", groupId: bills.id, color: "#8f84a8", icon: "receipt" },
      { key: "subs", groupId: bills.id, color: "#f0c84f", icon: "play" },
      { key: "groceries", groupId: living.id, color: "#f1dca0", icon: "food" },
      { key: "transport", groupId: living.id, color: "#e7e1d4", icon: "car" },
      { key: "health", groupId: living.id, color: "#f0d6cc", icon: "heart" },
      { key: "fun", groupId: living.id, color: "#aed6ea", icon: "gift" },
      { key: "savings", groupId: savingsGrp.id, color: "#f3c45f", icon: "moneybag", isSavings: true },
      { key: "rainy", groupId: savingsGrp.id, color: "#e6e6ea", icon: "tag" },
    ];
    const envRows = await tx
      .insert(s.envelopes)
      .values(
        envDefs.map((e, i) => ({
          budgetId,
          groupId: e.groupId,
          name: n.env[e.key],
          color: e.color,
          icon: e.icon,
          sort: i,
          ...(e.monthlyTarget !== undefined ? { monthlyTarget: e.monthlyTarget } : {}),
          ...(e.isSavings ? { isSavings: true } : {}),
        })),
      )
      .returning();
    const env = (key: keyof typeof n.env) => envRows[envDefs.findIndex((e) => e.key === key)]!;

    /* Categories and places */
    const catRows = await tx
      .insert(s.categories)
      .values(n.categories.map((name) => ({ budgetId, name })))
      .returning();
    const [catShopping, catHome, catCar] = [catRows[0]!, catRows[1]!, catRows[2]!];
    const placeRows = await tx
      .insert(s.places)
      .values(n.places.map((name) => ({ budgetId, name })))
      .returning();
    const [supermarket, gasStation] = [placeRows[0]!, placeRows[1]!];

    /* Allocations: current month + 2 back */
    const months = [monthAt(0), monthAt(1), monthAt(2)];
    await tx.insert(s.allocations).values(
      months.flatMap((m) =>
        (Object.keys(ALLOC) as Array<keyof typeof ALLOC>).map((key) => ({
          budgetId,
          envelopeId: env(key).id,
          month: m.ym,
          amount: zl(ALLOC[key]),
        })),
      ),
    );

    /* Transactions per month */
    type TxnRow = typeof s.transactions.$inferInsert;
    const txns: TxnRow[] = [];
    months.forEach((m, off) => {
      // income: salary on day 1, no envelope
      txns.push({
        budgetId,
        type: "income",
        accountId: checking.id,
        amount: zl(6500),
        date: m.day(1),
        name: n.tx.salary,
      });
      // fixed expenses
      txns.push({
        budgetId,
        type: "expense",
        accountId: checking.id,
        amount: zl(1800),
        date: m.day(2),
        envelopeId: env("housing").id,
        name: n.tx.rent,
      });
      txns.push({
        budgetId,
        type: "expense",
        accountId: checking.id,
        amount: zl(59.99),
        date: m.day(3),
        envelopeId: env("subs").id,
        name: n.tx.subs,
      });
      txns.push({
        budgetId,
        type: "expense",
        accountId: checking.id,
        amount: zl(230),
        date: m.day(5),
        envelopeId: env("utilities").id,
        categoryId: catHome.id,
        name: n.tx.utilities,
      });
      // groceries 4× (d4/11/18/25)
      const groceryDays = [4, 11, 18, 25];
      groceryDays.forEach((d, i) => {
        txns.push({
          budgetId,
          type: "expense",
          accountId: checking.id,
          amount: zl(GROCERY_AMOUNTS[off]![i]!),
          date: m.day(d),
          envelopeId: env("groceries").id,
          categoryId: catShopping.id,
          ...(i % 2 === 0 ? { placeId: supermarket.id } : {}),
          name: n.tx.groceries,
        });
      });
      // transport 2× (d7/21)
      txns.push({
        budgetId,
        type: "expense",
        accountId: checking.id,
        amount: zl(148.6),
        date: m.day(7),
        envelopeId: env("transport").id,
        categoryId: catCar.id,
        placeId: gasStation.id,
        name: n.tx.fuel,
      });
      txns.push({
        budgetId,
        type: "expense",
        accountId: checking.id,
        amount: zl(152.3),
        date: m.day(21),
        envelopeId: env("transport").id,
        categoryId: catCar.id,
        name: n.tx.fuel,
      });
      // rozrywka 1× (d15)
      txns.push({
        budgetId,
        type: "expense",
        accountId: checking.id,
        amount: zl(180),
        date: m.day(15),
        envelopeId: env("fun").id,
        name: n.tx.fun,
      });
      // health every other month (d10)
      if (off % 2 === 0) {
        txns.push({
          budgetId,
          type: "expense",
          accountId: checking.id,
          amount: zl(120),
          date: m.day(10),
          envelopeId: env("health").id,
          name: n.tx.health,
        });
      }
    });
    await tx.insert(s.transactions).values(txns);
    return true;
  });

  if (!seeded) return c.json({ error: "budget_not_empty" }, 409);
  return c.json({ seeded: true });
});

demoRoutes.post("/budget/reset", async (c) => {
  const { userId } = resetInput.parse(await c.req.json().catch(() => ({})));
  if (ownerAssertionFails(userId, sessionUserId(c))) return c.json({ error: "budget_mismatch" }, 409);
  await db.transaction(async (tx) => {
    const budgetId = (await requireTier(c, "plain", tx)).id;
    await wipeBudgetData(tx, budgetId);
  });
  return c.json({ reset: true });
});
