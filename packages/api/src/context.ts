import { eq } from "drizzle-orm";
import { db, type DbExecutor, type DbTransaction } from "./db/client";
import { budgets } from "./db/schema";
import {
  OPERATION_LOCK,
  operationLockKey,
  withOperationLock,
  withOperationLockInTx,
} from "./db/operationLock";

/** Minimal Hono context needed to resolve the user (null = call outside HTTP). */
type UserCtx = { get: (k: "userId") => string | undefined } | null;

/**
 * The user THIS request authenticated as (the session middleware in index.ts sets it on the
 * context; undefined only outside HTTP). The per-request OWNER assertion on the full-budget
 * overwrite routes compares it with the user the client says it verified — see
 * ownerAssertionFails in routes/sync.ts.
 */
export function sessionUserId(c: UserCtx): string | undefined {
  return c?.get("userId");
}

/**
 * Accounts are mandatory: the budget belongs to the session user (userId set by
 * the session middleware in index.ts); no budget ⇒ lazy-create an empty one
 * (synergy with the onboarding wizard). Its name is a neutral English placeholder
 * — the server has no locale for a lazily-created budget, and the user renames it
 * in Settings (existing names are DATA: no migration ever rewrites them).
 *
 * DELIBERATELY no in-process cache: `budgets.id` is the replica epoch marker —
 * wipe+reseed (`bun run db:seed`) assigns a NEW id without restarting the API.
 * A cached stale id would hide the reset from clients (no fullResync) and filter
 * data by a nonexistent budget (empty responses until the process restarts).
 * Cost: one select from a small table per request.
 *
 * Accepts an optional executor — snapshot/pull read the id in the SAME
 * transaction as the data (consistent budgetId+ledger pair even during a
 * background reseed).
 *
 * LAZY CREATION IS SERIALIZED (backlog §0b): two concurrent FIRST requests used
 * to both observe "no budget" and both insert one — accidental initialization
 * (routes select the first row, so one request could write into a budget the
 * other no longer selects). Only the EMPTY case enters the critical section,
 * keyed `budget.ensure-initial` per user on the generic operation lock; there
 * it re-checks under the lock and inserts at most one neutral budget. This is
 * deliberately NOT `UNIQUE(budgets.user_id)`/`ON CONFLICT` — multiple budgets
 * per user stay valid domain capacity; only initialization is serialized, and
 * any future "first/default budget" path must reuse the same operation key.
 *
 * ⚠ Callers holding the EXCLUSIVE changes-cursor lock (snapshot/pull/replace)
 * must NOT reach the lazy branch: creating a budget fires `log_change()` (the
 * SHARED changes lock), so lazy creation under the exclusive lock would invert
 * the operation-lock → changes-lock order and deadlock against a concurrent
 * initializer. Those routes ensure the budget BEFORE their barrier transaction
 * and resolve with `requireExistingTier` inside it (see routes/sync.ts).
 */
export async function getBudgetId(c: UserCtx, x: DbExecutor = db): Promise<string> {
  if (c === null) {
    // non-HTTP callers (scripts/tests): single-budget convenience — first budget row
    const rows = await x.select({ id: budgets.id }).from(budgets).limit(1);
    if (!rows[0]) throw new Error("No budget found.");
    return rows[0].id;
  }
  const userId = c.get("userId");
  if (!userId) throw new Error("No user in context — session middleware did not set userId.");
  // Fast path — no lock when a budget exists (the overwhelmingly common case).
  const existing = await firstBudgetIdOf(x, userId);
  if (existing) return existing;

  const key = operationLockKey(OPERATION_LOCK.ensureInitialBudget, userId);
  const ensure = async (tx: DbTransaction): Promise<string> => {
    // Re-check under the lock (read committed): a concurrent initializer may have won.
    const winner = await firstBudgetIdOf(tx, userId);
    if (winner) return winner;
    const [created] = await tx
      .insert(budgets)
      .values({ userId, name: "Budget" })
      .returning({ id: budgets.id });
    if (!created) throw new Error("Failed to create the user's budget.");
    return created.id;
  };
  // A transaction owned by the caller (structurally: only transactions have `rollback`) locks
  // in place — the lock then lives until the OUTER commit; the pooled db gets its own
  // transaction whose commit/rollback releases the lock.
  return isTransaction(x)
    ? withOperationLockInTx(x, key, ensure)
    : withOperationLock(key, ensure);
}

const isTransaction = (x: DbExecutor): x is DbTransaction => "rollback" in x;

/** The session user's currently-selected budget: deterministic ORDER BY id, first row. */
async function firstBudgetIdOf(x: DbExecutor, userId: string): Promise<string | null> {
  const rows = await x
    .select({ id: budgets.id })
    .from(budgets)
    .where(eq(budgets.userId, userId))
    .orderBy(budgets.id)
    .limit(1);
  return rows[0]?.id ?? null;
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
export async function getBudgetMeta(c: UserCtx, x: DbExecutor = db): Promise<BudgetMeta> {
  const id = await getBudgetId(c, x);
  return readBudgetMeta(x, id);
}

async function readBudgetMeta(x: DbExecutor, id: string): Promise<BudgetMeta> {
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
  x: DbExecutor = db,
): Promise<BudgetMeta> {
  const meta = await getBudgetMeta(c, x);
  if (meta.tier !== want) throw new TierMismatch(meta);
  return meta;
}

/**
 * Retryable marker: the session user's budget disappeared between the standalone ensure phase
 * and the barrier transaction (a concurrent destructive dev reseed). The caller rolls back and
 * retries the whole ensure → barrier sequence a bounded number of times (routes/sync.ts).
 */
export class BudgetVanished extends Error {
  constructor() {
    super("budget_vanished");
  }
}

/**
 * `requireTier` WITHOUT lazy creation — for transactions that hold the EXCLUSIVE changes-cursor
 * lock (snapshot/pull/replace): creating a budget fires `log_change()` (SHARED changes lock),
 * so the lazy branch under the exclusive lock would invert the operation-lock → changes-lock
 * order and deadlock against a concurrent initializer. Resolves an EXISTING budget only; when
 * none exists it throws `BudgetVanished` (see above) instead of creating one.
 */
export async function requireExistingTier(
  c: UserCtx,
  want: "plain" | "e2ee",
  x: DbExecutor = db,
): Promise<BudgetMeta> {
  const userId = sessionUserId(c);
  if (!userId) throw new Error("No user in context — session middleware did not set userId.");
  const rows = await x
    .select({ id: budgets.id, tier: budgets.tier, epoch: budgets.epoch })
    .from(budgets)
    .where(eq(budgets.userId, userId))
    .orderBy(budgets.id)
    .limit(1);
  const row = rows[0];
  if (!row) throw new BudgetVanished();
  const meta: BudgetMeta = {
    id: row.id,
    tier: (row.tier ?? "plain") as "plain" | "e2ee",
    epoch: row.epoch ?? 0,
  };
  if (meta.tier !== want) throw new TierMismatch(meta);
  return meta;
}
