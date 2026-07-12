import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/** Amounts in MINOR UNITS / grosz (BIGINT, mode number — safe for a household budget). */
const money = (name: string) => bigint(name, { mode: "number" });

export const txnTypeEnum = pgEnum("txn_type", ["expense", "income", "transfer"]);
export const recurrenceRuleEnum = pgEnum("recurrence_rule", [
  "none",
  "weekly",
  "monthly",
  "monthEnd",
  "quarterly",
  "yearly",
]);

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
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
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
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
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

export const budgets = pgTable("budgets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  currency: text("currency").notNull().default("PLN"),
  /** Sync tier: 'plain' (v1, server sees the data) or 'e2ee' (sync2, ciphertexts only). */
  tier: text("tier").notNull().default("plain"),
  /** DEK wrapped with the KEK (client-side) — the server never sees the key in plaintext. */
  wrappedDek: text("wrapped_dek"),
  /** KDF params (JSON: argon2id m/t/p + salt) to re-derive the KEK on a new device. */
  kdfParams: text("kdf_params"),
  /** Encryption epoch — bumped on enable/disable; guards sync-channel compatibility. */
  epoch: integer("epoch").notNull().default(0),
});

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

export const recurrences = pgTable("recurrences", {
  id: uuid("id").primaryKey().defaultRandom(),
  budgetId: uuid("budget_id")
    .notNull()
    .references(() => budgets.id, { onDelete: "cascade" }),
  rule: recurrenceRuleEnum("rule").notNull().default("none"),
  startDate: date("start_date", { mode: "string" }).notNull(),
  endDate: date("end_date", { mode: "string" }),
  /** Subscription pause — materialization skips occurrences dated < paused_until. */
  pausedUntil: date("paused_until", { mode: "string" }),
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
    confirmed: boolean("confirmed").notNull().default(true),
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
    planned: boolean("planned").notNull().default(false),
    recurrenceId: uuid("recurrence_id").references(() => recurrences.id, { onDelete: "set null" }),
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
 */
export const changes = pgTable("changes", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  tableName: text("table_name").notNull(),
  rowId: uuid("row_id").notNull(),
  op: text("op").notNull(),
  at: timestamp("at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

/** Push idempotency — opId guard; rejected does NOT leave a row (rollback). */
export const syncOps = pgTable("sync_ops", {
  opId: uuid("op_id").primaryKey(),
  clientId: text("client_id").notNull(),
  kind: text("kind").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

/** Encrypted operation log (sync2/E2EE) — the server stores ciphertexts only. */
export const e2eeOps = pgTable(
  "e2ee_ops",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    budgetId: uuid("budget_id").notNull().references(() => budgets.id, { onDelete: "cascade" }),
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
  budgetId: uuid("budget_id").primaryKey().references(() => budgets.id, { onDelete: "cascade" }),
  uptoSeq: bigint("upto_seq", { mode: "number" }).notNull().default(0),
  blob: text("blob").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

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
