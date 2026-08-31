import { and, sql as dsql, eq } from "drizzle-orm";
import { TierMismatch } from "../context";
import type { DB, DbTransaction } from "../db/client";
import { budgetAiCredentials, budgets } from "../db/schema";
import type { VaultMasterKeyProvider } from "./keyProvider";
import { openCredential, type SealedCredential, sealCredential } from "./vaultCrypto";

export interface CredentialOwner {
  userId: string;
}

export interface CredentialStatus {
  configured: boolean;
  storageKind?: "server_vault" | "e2ee_ciphertext";
}

export interface E2eeCredentialRecord {
  configured: boolean;
  budgetId: string;
  epoch: number;
  ciphertext?: string;
}

export class CredentialBudgetMismatch extends Error {
  readonly code = "budget_mismatch" as const;

  constructor() {
    super("budget_mismatch");
    this.name = "CredentialBudgetMismatch";
  }
}

export class CredentialNotConfigured extends Error {
  readonly code = "credential_not_configured" as const;

  constructor() {
    super("credential_not_configured");
    this.name = "CredentialNotConfigured";
  }
}

export class CredentialVaultUnavailable extends Error {
  readonly code = "vault_unavailable" as const;

  constructor() {
    super("vault_unavailable");
    this.name = "CredentialVaultUnavailable";
  }
}

export class CredentialE2eeUpgradeRequired extends Error {
  readonly code = "e2ee_upgrade_required" as const;

  constructor(readonly meta: { id: string; tier: "e2ee"; epoch: number; cipherVersion: 1 }) {
    super("e2ee_upgrade_required");
    this.name = "CredentialE2eeUpgradeRequired";
  }
}

async function lockPlainBudget(tx: DbTransaction, owner: CredentialOwner, budgetId: string): Promise<void> {
  const [row] = await tx
    .select({ userId: budgets.userId, tier: budgets.tier, epoch: budgets.epoch, cipherVersion: budgets.cipherVersion })
    .from(budgets)
    .where(eq(budgets.id, budgetId))
    .for("update");
  if (!row || row.userId !== owner.userId) throw new CredentialBudgetMismatch();
  if (row.tier !== "plain") {
    throw new TierMismatch({ id: budgetId, tier: "e2ee", epoch: row.epoch, cipherVersion: row.cipherVersion === 1 ? 1 : 2 });
  }
}

async function lockE2eeBudget(tx: DbTransaction, owner: CredentialOwner, budgetId: string, expectedEpoch?: number): Promise<number> {
  const [row] = await tx
    .select({ userId: budgets.userId, tier: budgets.tier, epoch: budgets.epoch, cipherVersion: budgets.cipherVersion })
    .from(budgets)
    .where(eq(budgets.id, budgetId))
    .for("update");
  if (!row || row.userId !== owner.userId) throw new CredentialBudgetMismatch();
  const cipherVersion = row.cipherVersion === 1 ? 1 : 2;
  if (row.tier !== "e2ee") throw new TierMismatch({ id: budgetId, tier: "plain", epoch: row.epoch, cipherVersion });
  if (cipherVersion !== 2) throw new CredentialE2eeUpgradeRequired({ id: budgetId, tier: "e2ee", epoch: row.epoch, cipherVersion: 1 });
  if (expectedEpoch !== undefined && row.epoch !== expectedEpoch) {
    throw new TierMismatch({ id: budgetId, tier: "e2ee", epoch: row.epoch, cipherVersion: 2 });
  }
  return row.epoch;
}

function sealedFromRow(row: {
  framingVersion: number;
  ciphertext: string;
  wrappedRecordDek: string | null;
  masterKeyId: string | null;
  recordVersion: number;
}): SealedCredential {
  if (row.framingVersion !== 1 || !row.wrappedRecordDek || !row.masterKeyId) throw new Error("ai_vault_bad_ciphertext");
  return {
    framingVersion: 1,
    ciphertext: row.ciphertext,
    wrappedRecordDek: row.wrappedRecordDek,
    masterKeyId: row.masterKeyId,
    recordVersion: row.recordVersion,
  };
}

export function createCredentialRepository(masterKeys: VaultMasterKeyProvider | null) {
  const openServerCredential = async (tx: DbTransaction, owner: CredentialOwner, budgetId: string) => {
    if (!masterKeys) throw new CredentialVaultUnavailable();
    await lockPlainBudget(tx, owner, budgetId);
    const [row] = await tx.select().from(budgetAiCredentials).where(eq(budgetAiCredentials.budgetId, budgetId));
    if (row?.storageKind !== "server_vault") throw new CredentialNotConfigured();
    const opened = openCredential(sealedFromRow(row), { provider: "openai", userId: owner.userId, budgetId, recordVersion: row.recordVersion }, masterKeys);
    try {
      if (opened.rewrappedDek) {
        await tx
          .update(budgetAiCredentials)
          .set({ ...opened.rewrappedDek, updatedAt: dsql`now()` })
          .where(
            and(
              eq(budgetAiCredentials.budgetId, budgetId),
              eq(budgetAiCredentials.recordVersion, row.recordVersion),
              eq(budgetAiCredentials.storageKind, "server_vault"),
            ),
          );
      }
      return opened;
    } catch (error) {
      opened.plaintext = "";
      throw error;
    }
  };

  return {
    async credentialStatus(tx: DbTransaction, owner: CredentialOwner, budgetId: string): Promise<CredentialStatus> {
      await lockPlainBudget(tx, owner, budgetId);
      const [row] = await tx
        .select({ storageKind: budgetAiCredentials.storageKind })
        .from(budgetAiCredentials)
        .where(eq(budgetAiCredentials.budgetId, budgetId));
      if (!row) return { configured: false };
      return { configured: true, storageKind: row.storageKind === "e2ee_ciphertext" ? "e2ee_ciphertext" : "server_vault" };
    },

    async replaceServerCredential(tx: DbTransaction, owner: CredentialOwner, budgetId: string, plaintext: string): Promise<void> {
      if (!masterKeys) throw new CredentialVaultUnavailable();
      await lockPlainBudget(tx, owner, budgetId);
      const [current] = await tx
        .select({ recordVersion: budgetAiCredentials.recordVersion })
        .from(budgetAiCredentials)
        .where(eq(budgetAiCredentials.budgetId, budgetId));
      const recordVersion = (current?.recordVersion ?? 0) + 1;
      if (!Number.isSafeInteger(recordVersion)) throw new Error("ai_vault_record_version_exhausted");
      const sealed = sealCredential(plaintext, { provider: "openai", userId: owner.userId, budgetId, recordVersion }, masterKeys);
      await tx
        .insert(budgetAiCredentials)
        .values({
          budgetId,
          provider: "openai",
          storageKind: "server_vault",
          framingVersion: sealed.framingVersion,
          ciphertext: sealed.ciphertext,
          wrappedRecordDek: sealed.wrappedRecordDek,
          masterKeyId: sealed.masterKeyId,
          e2eeEpoch: null,
          recordVersion,
        })
        .onConflictDoUpdate({
          target: budgetAiCredentials.budgetId,
          set: {
            provider: "openai",
            storageKind: "server_vault",
            framingVersion: sealed.framingVersion,
            ciphertext: sealed.ciphertext,
            wrappedRecordDek: sealed.wrappedRecordDek,
            masterKeyId: sealed.masterKeyId,
            e2eeEpoch: null,
            recordVersion,
            updatedAt: dsql`now()`,
          },
        });
    },

    async deleteCredential(tx: DbTransaction, owner: CredentialOwner, budgetId: string): Promise<void> {
      await lockPlainBudget(tx, owner, budgetId);
      await tx.delete(budgetAiCredentials).where(eq(budgetAiCredentials.budgetId, budgetId));
    },

    async e2eeCredential(tx: DbTransaction, owner: CredentialOwner, budgetId: string): Promise<E2eeCredentialRecord> {
      const epoch = await lockE2eeBudget(tx, owner, budgetId);
      const [row] = await tx
        .select({ storageKind: budgetAiCredentials.storageKind, ciphertext: budgetAiCredentials.ciphertext, e2eeEpoch: budgetAiCredentials.e2eeEpoch })
        .from(budgetAiCredentials)
        .where(eq(budgetAiCredentials.budgetId, budgetId));
      if (row?.storageKind !== "e2ee_ciphertext" || row.e2eeEpoch !== epoch) return { configured: false, budgetId, epoch };
      return { configured: true, budgetId, epoch, ciphertext: row.ciphertext };
    },

    async replaceE2eeCredential(tx: DbTransaction, owner: CredentialOwner, budgetId: string, expectedEpoch: number, ciphertext: string): Promise<number> {
      const epoch = await lockE2eeBudget(tx, owner, budgetId, expectedEpoch);
      const [current] = await tx
        .select({ recordVersion: budgetAiCredentials.recordVersion })
        .from(budgetAiCredentials)
        .where(eq(budgetAiCredentials.budgetId, budgetId));
      const recordVersion = (current?.recordVersion ?? 0) + 1;
      if (!Number.isSafeInteger(recordVersion)) throw new Error("ai_vault_record_version_exhausted");
      await tx
        .insert(budgetAiCredentials)
        .values({
          budgetId,
          provider: "openai",
          storageKind: "e2ee_ciphertext",
          framingVersion: 2,
          ciphertext,
          wrappedRecordDek: null,
          masterKeyId: null,
          e2eeEpoch: epoch,
          recordVersion,
        })
        .onConflictDoUpdate({
          target: budgetAiCredentials.budgetId,
          set: {
            provider: "openai",
            storageKind: "e2ee_ciphertext",
            framingVersion: 2,
            ciphertext,
            wrappedRecordDek: null,
            masterKeyId: null,
            e2eeEpoch: epoch,
            recordVersion,
            updatedAt: dsql`now()`,
          },
        });
      return epoch;
    },

    async deleteE2eeCredential(tx: DbTransaction, owner: CredentialOwner, budgetId: string, expectedEpoch: number): Promise<number> {
      const epoch = await lockE2eeBudget(tx, owner, budgetId, expectedEpoch);
      await tx.delete(budgetAiCredentials).where(and(eq(budgetAiCredentials.budgetId, budgetId), eq(budgetAiCredentials.storageKind, "e2ee_ciphertext")));
      return epoch;
    },

    async withServerCredential<T>(tx: DbTransaction, owner: CredentialOwner, budgetId: string, use: (credential: string) => Promise<T>): Promise<T> {
      const opened = await openServerCredential(tx, owner, budgetId);
      try {
        return await use(opened.plaintext);
      } finally {
        opened.plaintext = "";
      }
    },

    /** Open and opportunistically rewrap under a short transaction; the slow model request
     * runs after the row lock and transaction have both been released. */
    async withServerCredentialForWorker<T>(database: DB, owner: CredentialOwner, budgetId: string, use: (credential: string) => Promise<T>): Promise<T> {
      let opened: Awaited<ReturnType<typeof openServerCredential>> | undefined;
      try {
        opened = await database.transaction(async (tx) => {
          const value = await openServerCredential(tx, owner, budgetId);
          opened = value;
          return value;
        });
        return await use(opened.plaintext);
      } finally {
        if (opened) opened.plaintext = "";
      }
    },
  };
}

export type CredentialRepository = ReturnType<typeof createCredentialRepository>;
