import { accountPreferences } from "./accountPreferences";
import { budgetPreferences } from "./budgetPreferences";
import { devicePreferences } from "./devicePreferences";
import * as e2ee from "./e2ee";
import { idbDelete, idbGet, idbPut } from "./idb";
import * as outbox from "./outbox";
import { readLegacySettings, removeLegacySettingsIfUnchanged } from "./settingsPersist";
import { store } from "./store";
import { verifiedIdentityUserId } from "./sync/identity";

let ackCleared = false;

/** Keep the one-off legacy state machine outside the initial application chunk. It is loaded
 * only after boot/identity reaches the migration checkpoint; normal post-migration sessions
 * pay no initial-JS cost for its parsers and failure-recovery branches. */
export async function migrateLegacySettings(): Promise<void> {
  // The overwhelmingly common post-migration path does not even load the legacy module. Clear
  // a possible orphan acknowledgement once, then keep normal cycles on the initial code path.
  if (!readLegacySettings()) {
    if (!ackCleared) await idbDelete("meta", "legacySettingsMigrationV1");
    ackCleared = true;
    return;
  }
  const migration = await import("./legacySettingsMigration");
  await migration.runLegacySettingsMigration({
    readLegacy: readLegacySettings,
    removeLegacy: removeLegacySettingsIfUnchanged,
    loadAck: async () => migration.parseLegacyMigrationAck(await idbGet("meta", "legacySettingsMigrationV1")),
    saveAck: async (value) => {
      await idbPut("meta", value, "legacySettingsMigrationV1");
      ackCleared = false;
    },
    clearAck: async () => {
      if (ackCleared) return;
      await idbDelete("meta", "legacySettingsMigrationV1");
      ackCleared = true;
    },
    context: () => {
      const userId = verifiedIdentityUserId();
      const budgetId = store.getBudgetId() || store.getLedger()?.budgets[0]?.id;
      return userId && budgetId ? { userId, budgetId, tier: e2ee.getTierMeta().tier } : null;
    },
    accountState: accountPreferences.migrationState,
    updateAccount: accountPreferences.update,
    budgetState: budgetPreferences.getSnapshot,
    updateBudget: async (patch) => {
      budgetPreferences.update(patch);
      await outbox.flushed();
    },
    budgetPreferencePending: () => outbox.snapshot().some(({ op }) => op.kind === "budget.preferences.update"),
    deviceState: devicePreferences.migrationState,
    updateDevice: devicePreferences.update,
    credentialStatus: async (budgetId) => {
      const { createPlainByokProvider } = await import("./aiProvider/plainByok");
      const status = await createPlainByokProvider("plain", budgetId, budgetPreferences.getSnapshot().openaiModel).status();
      return { configured: status.configured, available: status.code !== "vault-unavailable" };
    },
    saveCredential: async (budgetId, model, key) => {
      const { createPlainByokProvider } = await import("./aiProvider/plainByok");
      await createPlainByokProvider("plain", budgetId, model).saveCredential(key);
    },
  });
}
