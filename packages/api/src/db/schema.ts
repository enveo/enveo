import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Amounts in MINOR UNITS / grosz (BIGINT, mode number — safe for a household budget). */
const money = (name: string) => bigint(name, { mode: "number" });

export const txnTypeEnum = pgEnum("txn_type", ["expense", "income", "transfer"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/** better-auth sessions (model `session`). */
export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/** better-auth OAuth identities/passwords (model `account`) — do NOT confuse with the domain `accounts`. */
export const authAccounts = pgTable("auth_accounts", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: "date" }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: "date" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/** better-auth verification entries (model `verification`). */
export const authVerifications = pgTable("auth_verifications", {
  id: uuid("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Display currency (ISO 4217). The default only ever shows on a lazily created budget until
     *  onboarding writes the user's pick (preselected from the browser locale) — see 0016. */
    currency: text("currency").notNull().default("EUR"),
    /** Sync tier: 'plain' (v1, server sees the data) or 'e2ee' (sync2, ciphertexts only). */
    tier: text("tier").notNull().default("plain"),
    /** DEK wrapped with the KEK (client-side) — the server never sees the key in plaintext. */
    wrappedDek: text("wrapped_dek"),
    /** KDF params (JSON: argon2id m/t/p + salt) to re-derive the KEK on a new device. */
    kdfParams: text("kdf_params"),
    /** Encryption epoch — bumped on enable/disable/upgrade; guards sync-channel compatibility. */
    epoch: integer("epoch").notNull().default(0),
    /** E2EE ciphertext wire format (meaningful only on tier 'e2ee'): 1 = legacy pre-AAD "v1."
     *  ciphertext — every normal sync2 route refuses it (409 e2ee_upgrade_required) until the
     *  explicit upgrade ceremony (fresh DEK, epoch bump, new checkpoint) has run; 2 = the
     *  authenticated-context format. NEVER flip this with SQL alone: that would label
     *  unauthenticated ciphertext as v2 without rotating the DEK or rebuilding the snapshot
     *  (migration 0021 marks pre-existing e2ee rows as 1 exactly once). */
    cipherVersion: integer("cipher_version").notNull().default(2),
  },
  (t) => ({
    cipherVersionValid: check("budgets_cipher_version_valid", sql`${t.cipherVersion} IN (1, 2)`),
  }),
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    budgetId: uuid("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#54c6bd"),
    icon: text("icon").notNull().default("wallet"),
    type: text("type").notNull().default("checking"),
    onBudget: boolean("on_budget").notNull().default(true),
    initialBalance: money("initial_balance").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    sort: integer("sort").notNull().default(0),
  },
  (t) => ({ byBudget: index("accounts_budget_idx").on(t.budgetId) }),
);

export const envelopeGroups = pgTable(
  "envelope_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    budgetId: uuid("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sort: integer("sort").notNull().default(0),
  },
  (t) => ({ byBudget: index("groups_budget_idx").on(t.budgetId) }),
);

export const envelopes = pgTable(
  "envelopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    budgetId: uuid("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => envelopeGroups.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#f1dca0"),
    icon: text("icon").notNull().default("tag"),
    note: text("note"),
    monthlyTarget: money("monthly_target"),
    isSavings: boolean("is_savings").notNull().default(false),
    sort: integer("sort").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
  },
  (t) => ({ byBudget: index("envelopes_budget_idx").on(t.budgetId) }),
);

export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  budgetId: uuid("budget_id")
    .notNull()
    .references(() => budgets.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
});

export const places = pgTable("places", {
  id: uuid("id").primaryKey().defaultRandom(),
  budgetId: uuid("budget_id")
    .notNull()
    .references(() => budgets.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
});

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    budgetId: uuid("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "cascade" }),
    type: txnTypeEnum("type").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    toAccountId: uuid("to_account_id").references(() => accounts.id, { onDelete: "cascade" }),
    amount: money("amount").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    isRefund: boolean("is_refund").notNull().default(false),
    envelopeId: uuid("envelope_id").references(() => envelopes.id, { onDelete: "set null" }),
    placeId: uuid("place_id").references(() => places.id, { onDelete: "set null" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    // short transaction name (list title); the note is a separate, longer field
    name: text("name"),
    note: text("note"),
    // normalized merchant tag (e.g. "LIDL") — idempotency key of screenshot imports
    tag: text("tag"),
    // raw payee description from the bank (e.g. "PRO*PLATNOSC") — screenshot-import
    // metadata, immutable on correction; matches future imports and learns from fixes.
    // Not visible in the UI.
    sourceRef: text("source_ref"),
    // stable id from historical external imports — legacy column,
    // the app no longer uses it (data in existing databases stays)
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => ({
    byBudgetDate: index("txn_budget_date_idx").on(t.budgetId, t.date),
    byEnvelope: index("txn_envelope_idx").on(t.envelopeId),
    byExternal: index("txn_external_idx").on(t.budgetId, t.externalId),
  }),
);

export const txnItems = pgTable("txn_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  transactionId: uuid("transaction_id")
    .notNull()
    .references(() => transactions.id, { onDelete: "cascade" }),
  envelopeId: uuid("envelope_id")
    .notNull()
    .references(() => envelopes.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
  amount: money("amount").notNull(),
});

/**
 * Change log for delta-sync. Populated EXCLUSIVELY by Postgres triggers
 * (migration 0004) — also catches FK cascades that never go through handlers.
 * op ∈ ('upsert','delete') — CHECK in the migration.
 *
 * budgetId (migration 0015) is the TENANT of the changed row — the trigger takes it from
 * NEW/OLD (for `budgets` itself: the row's own id). Without it the journal was global and
 * /sync/pull handed every tenant every other tenant's DELETE rows (table + row id + seq):
 * upserts were content-filtered by budget, deletes were not. NULL only on pre-0015 rows that
 * the migration could not attribute (multi-budget databases); the pull refuses to serve a
 * delta that would silently skip them (resetRequired → snapshot).
 *
 * No FK to budgets on purpose: this is an append-only log, and an ON DELETE CASCADE would
 * race the AFTER DELETE trigger that logs the budget's own removal.
 */
export const changes = pgTable(
  "changes",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    tableName: text("table_name").notNull(),
    rowId: uuid("row_id").notNull(),
    op: text("op").notNull(),
    budgetId: uuid("budget_id"),
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => ({
    byBudget: index("changes_budget_seq_idx").on(t.budgetId, t.seq),
    legacy: uniqueIndex("changes_legacy_seq_idx").on(t.seq).where(sql`"budget_id" is null`),
  }),
);

/**
 * Push idempotency — per-budget (budgetId, opId) guard (mirrors e2eeOps);
 * rejected does NOT leave a row (rollback). budgetId is nullable ONLY for
 * pre-0014 rows that migration 0014 could not backfill (multi-budget
 * databases); every row written since carries it. Because NULLs are DISTINCT
 * in a unique index, those legacy rows are deduped by the partial unique index
 * below and treated as already-applied by the push guard (sync/idempotency.ts).
 */
export const syncOps = pgTable(
  "sync_ops",
  {
    opId: uuid("op_id").notNull(),
    budgetId: uuid("budget_id"),
    clientId: text("client_id").notNull(),
    kind: text("kind").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => ({
    uniqOp: uniqueIndex("sync_ops_budget_op_uniq").on(t.budgetId, t.opId),
    uniqLegacyOp: uniqueIndex("sync_ops_legacy_op_uniq").on(t.opId).where(sql`"budget_id" is null`),
  }),
);

/** Encrypted operation log (sync2/E2EE) — the server stores ciphertexts only. */
export const e2eeOps = pgTable(
  "e2ee_ops",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    budgetId: uuid("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "cascade" }),
    opId: uuid("op_id").notNull(),
    ciphertext: text("ciphertext").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => ({
    uniqOp: unique("e2ee_ops_budget_op_uniq").on(t.budgetId, t.opId),
    byBudget: index("e2ee_ops_budget_idx").on(t.budgetId, t.seq),
  }),
);

/** Encrypted ledger checkpoint (bootstraps a new device without replaying the whole log). */
export const e2eeSnapshots = pgTable("e2ee_snapshots", {
  budgetId: uuid("budget_id")
    .primaryKey()
    .references(() => budgets.id, { onDelete: "cascade" }),
  uptoSeq: bigint("upto_seq", { mode: "number" }).notNull().default(0),
  blob: text("blob").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

/**
 * Cloud operator-key AI spend budget (backlog §1): ONE aggregate row per (policy, user, UTC
 * calendar month) — no reservations, no per-request billing events. `spent_nano_usd` is integer
 * nano-USD (bigint end to end; 1 USD = 1e9) and only grows by atomic upsert-increments of actual
 * usage-derived cost (may overshoot the threshold — accepted). Period key 'YYYY-MM' is derived
 * from POSTGRES time; start/end pin the half-open UTC month. Written EXCLUSIVELY by
 * aiSpend/counter.ts; deliberately no retention job.
 */
export const aiUserMonthlySpend = pgTable(
  "ai_user_monthly_spend",
  {
    policy: text("policy").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    periodKey: text("period_key").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true, mode: "date" }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true, mode: "date" }).notNull(),
    /** Non-negative (CHECK below/migration 0020) — a rollback can lose an increment, never invent one. */
    spentNanoUsd: bigint("spent_nano_usd", { mode: "bigint" }).notNull().default(sql`0`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.policy, t.userId, t.periodKey] }),
    nonNegative: check("ai_user_monthly_spend_nonneg", sql`${t.spentNanoUsd} >= 0`),
  }),
);

export const allocations = pgTable(
  "allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    budgetId: uuid("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "cascade" }),
    envelopeId: uuid("envelope_id")
      .notNull()
      .references(() => envelopes.id, { onDelete: "cascade" }),
    month: text("month").notNull(), // YYYY-MM
    amount: money("amount").notNull().default(0),
  },
  (t) => ({
    uniq: unique("alloc_env_month_uniq").on(t.envelopeId, t.month),
    byBudget: index("alloc_budget_idx").on(t.budgetId, t.month),
  }),
);
