import { and, sql as dsql, eq } from "drizzle-orm";
import { TierMismatch } from "../context";
import type { DbTransaction } from "../db/client";
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

    async withServerCredential<T>(tx: DbTransaction, owner: CredentialOwner, budgetId: string, use: (credential: string) => Promise<T>): Promise<T> {
      if (!masterKeys) throw new CredentialVaultUnavailable();
      await lockPlainBudget(tx, owner, budgetId);
      const [row] = await tx.select().from(budgetAiCredentials).where(eq(budgetAiCredentials.budgetId, budgetId));
      if (row?.storageKind !== "server_vault") throw new CredentialNotConfigured();
      const opened = openCredential(sealedFromRow(row), { provider: "openai", userId: owner.userId, budgetId, recordVersion: row.recordVersion }, masterKeys);
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
      try {
        return await use(opened.plaintext);
      } finally {
        opened.plaintext = "";
      }
    },
  };
}

export type CredentialRepository = ReturnType<typeof createCredentialRepository>;
