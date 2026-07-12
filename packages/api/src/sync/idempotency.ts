/**
 * Push idempotency guard — the `sync_ops` claim.
 *
 * Lives in its own module (no `db/client` import at runtime) so it can be
 * exercised against a THROWAWAY Postgres in tests without pulling in the app's
 * connection pool.
 */
import { sql } from "drizzle-orm";
import type { Executor } from "./apply";

export type OpClaim = {
  opId: string;
  budgetId: string;
  clientId: string;
  kind: string;
};

/**
 * Claim `(budgetId, opId)` in `sync_ops`. Returns true when the op is FRESH
 * (the caller must apply it), false when it was already applied (duplicate —
 * no-op). Run it in the SAME transaction as the op application, so a rollback
 * takes the claim with it.
 *
 * Two guards in ONE statement:
 *  - `on conflict (budget_id, op_id)` — the per-budget replay guard (migration
 *    0014; a global op_id PK would let one tenant block another tenant's op).
 *  - `not exists (… budget_id is null)` — pre-0014 rows that migration 0014
 *    could NOT backfill (multi-budget databases: the budget of a legacy op is
 *    unknowable). NULLs are DISTINCT in a unique index, so such a row does not
 *    conflict on the composite target: without this check a client re-pushing
 *    an op it had already pushed before the upgrade (routine — the outbox
 *    re-pushes the whole batch after a 5xx or a lost response, e.g. across the
 *    upgrade restart) would have it APPLIED A SECOND TIME — resurrecting an
 *    entity deleted meanwhile by another device, or dead-lettering a 23505.
 *    opIds are random uuids, so matching on op_id alone cannot collide across
 *    tenants. The lookup rides the partial unique index sync_ops_legacy_op_uniq
 *    (empty on every install created after 0014).
 */
export async function claimOp(x: Executor, v: OpClaim): Promise<boolean> {
  const rows = (await x.execute(sql`
    insert into "sync_ops" ("op_id", "budget_id", "client_id", "kind")
    select ${v.opId}::uuid, ${v.budgetId}::uuid, ${v.clientId}, ${v.kind}
    where not exists (
      select 1 from "sync_ops" where "op_id" = ${v.opId}::uuid and "budget_id" is null
    )
    on conflict ("budget_id", "op_id") do nothing
    returning "op_id"
  `)) as unknown as { op_id: string }[];
  return rows.length > 0;
}
