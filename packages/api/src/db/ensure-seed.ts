/** On an empty database creates ONLY a user + an empty budget (onboarding does the rest in the UI). */
import { sql } from "./client";
import { db } from "./client";
import * as s from "./schema";

const rows = await db.select({ id: s.budgets.id }).from(s.budgets).limit(1);
if (rows.length === 0) {
  console.log("Database empty — creating an empty budget (onboarding happens in the app).");
  const [user] = await db.insert(s.users).values({ email: "owner@example.com" }).returning();
  await db.insert(s.budgets).values({ userId: user!.id, name: "Budżet" });
} else {
  console.log("Database contains data — skipping seed.");
}
await sql.end();
