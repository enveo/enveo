/**
 * Sync op catalog + zod schemas for REST payloads.
 *
 * Single source of truth for both sides:
 * - the API validates REST bodies and op payloads in POST /api/sync/push with them,
 * - the client validates ops with them at outbox enqueue (loud fail on write).
 *
 * Payload schemas carried over VERBATIM from packages/api/src/routes/*.
 */
import { z } from "zod";

/* ── Transactions (from routes/transactions.ts) ─────────────────────── */

export const txnItemPayload = z.object({
  envelopeId: z.string().uuid(),
  categoryId: z.string().uuid().nullable().optional(),
  amount: z.number().int().nonnegative(),
});

const txnBase = z.object({
  type: z.enum(["expense", "income", "transfer"]),
  accountId: z.string().uuid(),
  toAccountId: z.string().uuid().nullable().optional(),
  amount: z.number().int().nonnegative(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  isRefund: z.boolean().optional(),
  envelopeId: z.string().uuid().nullable().optional(),
  placeId: z.string().uuid().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  name: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  tag: z.string().nullable().optional(),
  items: z.array(txnItemPayload).optional(),
  // the client sets it at create (stable list order within a day); REST may omit it
  createdAt: z.string().datetime().optional(),
});

const txnRules = (v: z.infer<typeof txnBase>, ctx: z.RefinementCtx) => {
  if (v.type === "transfer" && !v.toAccountId) {
    ctx.addIssue({ code: "custom", message: "transfer requires toAccountId", path: ["toAccountId"] });
  }
  if (v.items && v.items.length > 0) {
    const sum = v.items.reduce((x, i) => x + i.amount, 0);
    if (sum !== v.amount) {
      ctx.addIssue({ code: "custom", message: "Σ items ≠ transaction amount", path: ["items"] });
    }
  }
};

export const txnPayload = txnBase.superRefine(txnRules);
export type TxnPayload = z.infer<typeof txnPayload>;

/* ── Allocations (from routes/transactions.ts) ──────────────────────── */

export const allocPayload = z.object({
  envelopeId: z.string().uuid(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  amount: z.number().int(),
});
export type AllocPayload = z.infer<typeof allocPayload>;

/* ── Accounts / groups / envelopes (from routes/crud.ts) ────────────── */

export const accountPayload = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
  icon: z.string().optional(),
  type: z.string().optional(),
  onBudget: z.boolean().optional(),
  initialBalance: z.number().int().optional(),
  archived: z.boolean().optional(),
  sort: z.number().int().optional(),
});
export type AccountPayload = z.infer<typeof accountPayload>;

export const groupPayload = z.object({ name: z.string().min(1), sort: z.number().int().optional() });
export type GroupPayload = z.infer<typeof groupPayload>;

export const envelopePayload = z.object({
  groupId: z.string().uuid(),
  name: z.string().min(1),
  color: z.string().optional(),
  icon: z.string().optional(),
  note: z.string().nullable().optional(),
  monthlyTarget: z.number().int().nullable().optional(),
  isSavings: z.boolean().optional(),
  sort: z.number().int().optional(),
  archived: z.boolean().optional(),
});
export type EnvelopePayload = z.infer<typeof envelopePayload>;

/* ── Sync op catalog ────────────────────────────────────────────────── */

const withId = { id: z.string().uuid() };
const idOnly = z.object(withId);

export const opSchemas = {
  "txn.create": txnBase.extend(withId).superRefine(txnRules),
  // update = full field replacement (LWW); items delete+reinsert
  "txn.update": txnBase.extend(withId).superRefine(txnRules),
  "txn.delete": idOnly,
  // natural key (envelopeId, month) — upsert
  "alloc.set": allocPayload,
  "account.create": accountPayload.extend(withId),
  "account.update": accountPayload.partial().extend(withId),
  "account.delete": idOnly,
  "group.create": groupPayload.extend(withId),
  "group.update": groupPayload.partial().extend(withId),
  "group.delete": idOnly,
  "envelope.create": envelopePayload.extend(withId),
  "envelope.update": envelopePayload.partial().extend(withId),
  "envelope.delete": idOnly,
  // plain insert — dedupe by name is done by the CLIENT (local lookup in the mirror)
  "category.create": z.object({ ...withId, name: z.string().min(1) }),
  "place.create": z.object({ ...withId, name: z.string().min(1) }),
  // budget metadata (single-row entity) — for now only the display currency
  "budget.update": z.object({ id: z.string().uuid(), currency: z.string().regex(/^[A-Z]{3}$/) }),
} as const;

export type OpKind = keyof typeof opSchemas;
export type OpPayload<K extends OpKind = OpKind> = z.infer<(typeof opSchemas)[K]>;

export const OP_KINDS = Object.keys(opSchemas) as [OpKind, ...OpKind[]];

/** Sync op: idempotent push unit (opId = client-assigned uuid). */
export interface SyncOp<K extends OpKind = OpKind> {
  opId: string;
  kind: K;
  payload: OpPayload<K>;
}

/** Full op validation (opId + kind + payload per catalog) — e.g. at enqueue. */
export const syncOpSchema = z
  .object({
    opId: z.string().uuid(),
    kind: z.enum(OP_KINDS),
    payload: z.unknown(),
  })
  .superRefine((v, ctx) => {
    const res = opSchemas[v.kind].safeParse(v.payload);
    if (!res.success) {
      for (const issue of res.error.issues) {
        ctx.addIssue({ code: "custom", message: issue.message, path: ["payload", ...issue.path] });
      }
    }
  });

/* ── Full replica (backup / server replace) ──────────────────────────────
   Schema of the whole ClientLedger — validated at POST /api/sync/replace (server)
   AND when loading a JSON backup (client). Built from entity shapes in types.ts;
   parity guaranteed by this same file. Conventions: entity ids are uuid; amounts
   are int (minor units); dates YYYY-MM-DD; month YYYY-MM; Σ split items = amount.

   Uuid exceptions: allocation and split-item ids MAY be synthetic (offline —
   see applyOp.ts: `alloc-local:…`, `item-local:…`), since nothing references
   them; the server assigns fresh uuids on write, and the client reconciles by
   natural key. Hence they are plain strings here. `createdAt` is validated
   loosely (string) — we preserve the dump/server format fidelity on restore. */
const zUuid = z.string().uuid();
const zYmd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected a YYYY-MM-DD date");
const zYm = z.string().regex(/^\d{4}-\d{2}$/, "expected a YYYY-MM month");
const zMoney = z.number().int();
const zMoneyNonNeg = z.number().int().nonnegative();

const accountEntity = z.object({
  id: zUuid,
  name: z.string(),
  color: z.string(),
  icon: z.string(),
  type: z.string(),
  onBudget: z.boolean(),
  initialBalance: zMoney,
  archived: z.boolean(),
  sort: z.number().int(),
});
const groupEntity = z.object({ id: zUuid, name: z.string(), sort: z.number().int() });
const envelopeEntity = z.object({
  id: zUuid,
  groupId: zUuid,
  name: z.string(),
  color: z.string(),
  icon: z.string(),
  note: z.string().nullable(),
  monthlyTarget: zMoney.nullable().optional(),
  isSavings: z.boolean().optional(),
  sort: z.number().int(),
  archived: z.boolean(),
});
const categoryEntity = z.object({ id: zUuid, name: z.string() });
const placeEntity = z.object({ id: zUuid, name: z.string() });
const allocationEntity = z.object({
  id: z.string(), // may be synthetic (alloc-local:…) — the server will assign a uuid
  envelopeId: zUuid,
  month: zYm,
  amount: zMoney,
});
const txnItemEntity = z.object({
  id: z.string(), // may be synthetic (item-local:…) — the server will assign a uuid
  envelopeId: zUuid,
  categoryId: zUuid.nullable(),
  amount: zMoneyNonNeg,
});
const transactionEntity = z
  .object({
    id: zUuid,
    type: z.enum(["expense", "income", "transfer"]),
    accountId: zUuid,
    toAccountId: zUuid.nullable(),
    amount: zMoneyNonNeg,
    date: zYmd,
    isRefund: z.boolean(),
    envelopeId: zUuid.nullable(),
    placeId: zUuid.nullable(),
    categoryId: zUuid.nullable(),
    name: z.string().nullable(),
    note: z.string().nullable(),
    tag: z.string().nullable(),
    items: z.array(txnItemEntity),
    createdAt: z.string(),
  })
  .superRefine((t, ctx) => {
    if (t.items.length > 0) {
      const sum = t.items.reduce((x, i) => x + i.amount, 0);
      if (sum !== t.amount) {
        ctx.addIssue({ code: "custom", message: "Σ items ≠ transaction amount", path: ["items"] });
      }
    }
  });

const budgetEntity = z.object({ id: zUuid, name: z.string(), currency: z.string() });

/**
 * Pre-3.2 backups/replicas carry per-transaction `planned: true` template rows (the recurring-
 * payments feature). `planned` was removed from `transactionEntity` above in 3.2, so without this
 * preprocess zod would SILENTLY STRIP the flag and let the row through as an ordinary transaction
 * — a template installed as real money on restore. Those rows were always excluded from every
 * ledger computation (budget math, reports); they must not materialize here either. Drop them
 * from the raw array BEFORE the per-item schema runs, so every consumer of clientLedgerSchema
 * (web `importBackup`, `/api/sync/replace`) is covered from one place.
 */
const droppingLegacyPlannedRows = z.preprocess((v) => {
  if (!Array.isArray(v)) return v;
  return v.filter((item) => !(item && typeof item === "object" && (item as { planned?: unknown }).planned === true));
}, z.array(transactionEntity));

/** Full client replica (ClientLedger) — backup / server replace validation.
    `budgets` optional — old JSON backups (pre-currency) must still load. */
export const clientLedgerSchema = z.object({
  budgets: z.array(budgetEntity).optional(),
  accounts: z.array(accountEntity),
  groups: z.array(groupEntity),
  envelopes: z.array(envelopeEntity),
  categories: z.array(categoryEntity),
  places: z.array(placeEntity),
  allocations: z.array(allocationEntity),
  transactions: droppingLegacyPlannedRows,
});
export type ClientLedgerInput = z.infer<typeof clientLedgerSchema>;

/**
 * The confirmation literal POSTed to /api/e2ee/disable (server: `z.literal`).
 *
 * WIRE constant — stable, locale-independent ASCII, NEVER shown to the user. The word the user
 * actually TYPES is localized (i18n `e2ee.disableWord`) and compared on the device; only this
 * constant travels. Keep it ASCII: pinning a localized literal on the wire once made the disable
 * flow untypeable for anyone without a Polish keyboard (Ł/Ą).
 */
export const E2EE_DISABLE_CONFIRM = "DISABLE-E2EE";

/** Tables replicated to the client (DB names; the client maps envelope_groups → groups). */
export const REPLICATED_TABLES = [
  "accounts",
  "envelope_groups",
  "envelopes",
  "categories",
  "places",
  "transactions",
  "allocations",
  "budgets",
] as const;
export type ReplicatedTable = (typeof REPLICATED_TABLES)[number];
