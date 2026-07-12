import { eq } from "drizzle-orm";
import { db } from "./db/client";
import { budgets } from "./db/schema";
import { env } from "./env";
import type { Executor } from "./sync/apply";

/** Minimal Hono context needed to resolve the user (null = call outside HTTP). */
type UserCtx = { get: (k: "userId") => string | undefined } | null;

/**
 * AUTH_MODE=none (default; perimeter = private network, e.g. VPN): we operate
 * on the single seeded budget — behavior identical to before auth was introduced.
 * AUTH_MODE=multi: budget per user from the session (middleware in index.ts);
 * no budget ⇒ lazy-create an empty one (synergy with the onboarding wizard).
 *
 * DELIBERATELY no in-process cache: `budgets.id` is the replica epoch marker —
 * wipe+reseed (`bun run db:seed`) assigns a NEW id without restarting the API.
 * A cached stale id would hide the reset from clients (no fullResync) and filter
 * data by a nonexistent budget (empty responses until the process restarts).
 * Cost: one select from a single-row table per request.
 *
 * Accepts an optional executor — snapshot/pull read the id in the SAME
 * transaction as the data (consistent budgetId+ledger pair even during a
 * background reseed).
 */
export async function getBudgetId(c: UserCtx, x: Executor = db): Promise<string> {
  if (env.AUTH_MODE !== "multi" || c === null) {
    const rows = await x.select({ id: budgets.id }).from(budgets).limit(1);
    if (!rows[0]) throw new Error("No budget found — run `bun run db:seed`.");
    return rows[0].id;
  }
  const userId = c.get("userId");
  if (!userId) throw new Error("No user in context — session middleware did not set userId.");
  const rows = await x
    .select({ id: budgets.id })
    .from(budgets)
    .where(eq(budgets.userId, userId))
    .orderBy(budgets.id)
    .limit(1);
  if (rows[0]) return rows[0].id;
  const [created] = await x
    .insert(budgets)
    .values({ userId, name: "Budżet" })
    .returning({ id: budgets.id });
  if (!created) throw new Error("Failed to create the user's budget.");
  return created.id;
}

/* ── E2EE tier (stage 1) ────────────────────────────────────────────────
   A budget has tier 'plain' (v1 — server sees the data) or 'e2ee' (sync2 —
   ciphertexts only). `epoch` grows on every enable/disable and guards
   sync-channel compatibility on the client side. */

export interface BudgetMeta {
  id: string;
  tier: "plain" | "e2ee";
  epoch: number;
}

/** Budget id + tier + epoch in one read (same executor as the data). */
export async function getBudgetMeta(c: UserCtx, x: Executor = db): Promise<BudgetMeta> {
  const id = await getBudgetId(c, x);
  const [row] = await x
    .select({ tier: budgets.tier, epoch: budgets.epoch })
    .from(budgets)
    .where(eq(budgets.id, id));
  return { id, tier: (row?.tier ?? "plain") as "plain" | "e2ee", epoch: row?.epoch ?? 0 };
}

/** Wrong tier for the route — mapped in app.onError to 409 { error: "tier_mismatch" }. */
export class TierMismatch extends Error {
  constructor(public meta: BudgetMeta) {
    super("tier_mismatch");
  }
}

/**
 * Tier guard: v1 data routes require "plain", sync2 requires "e2ee".
 * For a budget in the default 'plain' tier the v1 routes pass with no
 * behavior change (zero impact on existing flows).
 */
export async function requireTier(
  c: UserCtx,
  want: "plain" | "e2ee",
  x: Executor = db,
): Promise<BudgetMeta> {
  const meta = await getBudgetMeta(c, x);
  if (meta.tier !== want) throw new TierMismatch(meta);
  return meta;
}
