import { describe, expect, it } from "bun:test";
import { type AccountPreferences, type BudgetPreferences, createDefaultAccountPreferences, createDefaultBudgetPreferences } from "@enveo/shared";
import { type LegacyMigrationAck, type LegacySettingsMigrationDeps, runLegacySettingsMigration } from "./legacySettingsMigration";
import type { LegacySettings, LegacySettingsRecord } from "./settingsPersist";

const RAW = "legacy-raw-bytes";

function fixture(legacy: LegacySettings | null) {
  let record: LegacySettingsRecord | null = legacy ? { raw: RAW, value: legacy } : null;
  let ack: LegacyMigrationAck = { schemaVersion: 1 };
  let account = createDefaultAccountPreferences();
  let budget = createDefaultBudgetPreferences();
  let device = { schemaVersion: 1 as const, discreet: false };
  let accountRevision = 0;
  let accountDirty = false;
  let budgetPending = false;
  let credentialConfigured = false;
  let tier: "plain" | "e2ee" = "plain";
  const calls = {
    account: [] as unknown[],
    budget: [] as unknown[],
    device: [] as unknown[],
    credentialSave: [] as string[],
    removed: [] as string[],
    ack: [] as LegacyMigrationAck[],
    clearAck: 0,
  };
  const deps: LegacySettingsMigrationDeps = {
    readLegacy: () => record,
    removeLegacy: async (expectedRaw) => {
      calls.removed.push(expectedRaw);
      if (record?.raw !== expectedRaw) return false;
      record = null;
      return true;
    },
    loadAck: async () => ack,
    saveAck: async (next) => {
      ack = structuredClone(next);
      calls.ack.push(ack);
    },
    clearAck: async () => {
      calls.clearAck += 1;
      ack = { schemaVersion: 1 };
    },
    context: () => ({ userId: "user-a", budgetId: "budget-a", tier }),
    accountState: () => ({ value: account, revision: accountRevision, dirty: accountDirty ? { lang: true } : {} }),
    updateAccount: async (patch) => {
      calls.account.push(patch);
      account = { ...account, ...patch };
      accountDirty = true;
    },
    budgetState: () => budget,
    updateBudget: async (patch) => {
      calls.budget.push(patch);
      budget = { ...budget, ...patch };
      budgetPending = true;
    },
    budgetPreferencePending: () => budgetPending,
    deviceState: () => ({ value: device, present: false }),
    updateDevice: async (patch) => {
      calls.device.push(patch);
      device = { ...device, ...patch };
    },
    credentialStatus: async () => ({ configured: credentialConfigured, available: true }),
    saveCredential: async (_budgetId, _model, key) => {
      calls.credentialSave.push(key);
      credentialConfigured = true;
    },
  };
  return {
    deps,
    calls,
    ack: () => ack,
    record: () => record,
    acknowledgeAccount() {
      accountDirty = false;
      accountRevision += 1;
    },
    acknowledgeBudget() {
      budgetPending = false;
    },
    setAccount(value: AccountPreferences, revision: number) {
      account = value;
      accountRevision = revision;
    },
    setBudget(value: BudgetPreferences) {
      budget = value;
    },
    setTier(value: "plain" | "e2ee") {
      tier = value;
    },
    setCredentialConfigured(value: boolean) {
      credentialConfigured = value;
    },
  };
}

const legacy: LegacySettings = {
  themeMode: "dark",
  accentTheme: "duet",
  lang: "pl",
  discreet: true,
  aiMode: "byok",
  openaiKey: "sk-never-copy-this",
  openaiModel: "gpt-5.6-sol",
  customProfiles: [],
  startWidgets: createDefaultBudgetPreferences().startWidgets,
};

async function finish(f: ReturnType<typeof fixture>) {
  await runLegacySettingsMigration(f.deps); // account intent
  f.acknowledgeAccount();
  await runLegacySettingsMigration(f.deps); // account ack + budget intent
  f.acknowledgeBudget();
  await runLegacySettingsMigration(f.deps); // credential + provider intent
  f.acknowledgeBudget();
  await runLegacySettingsMigration(f.deps); // provider ack + cleanup
}

describe("legacy settings migration", () => {
  it("does nothing until identity and the active budget are available", async () => {
    const f = fixture(legacy);
    f.deps.context = () => null;
    await runLegacySettingsMigration(f.deps);
    expect(f.calls.account).toEqual([]);
    expect(f.record()?.raw).toBe(RAW);
  });

  it("waits for server acknowledgement of non-secret preferences before moving the key", async () => {
    const f = fixture(legacy);
    await runLegacySettingsMigration(f.deps);
    expect(f.calls.account).toHaveLength(1);
    expect(f.calls.credentialSave).toEqual([]);
    expect(f.ack().account).toBe("pending");

    await runLegacySettingsMigration(f.deps);
    expect(f.calls.account).toHaveLength(1);
    expect(f.calls.budget).toEqual([]);

    f.acknowledgeAccount();
    await runLegacySettingsMigration(f.deps);
    expect(f.calls.budget).toEqual([{ openaiModel: "gpt-5.6-sol", customProfiles: [], startWidgets: legacy.startWidgets }]);
    expect(f.ack().budget).toBe("pending");
    expect(f.calls.credentialSave).toEqual([]);
  });

  it("stores plain BYOK, confirms status, then acknowledges provider=openai before deleting localStorage", async () => {
    const f = fixture(legacy);
    await finish(f);

    expect(f.calls.credentialSave).toEqual(["sk-never-copy-this"]);
    expect(f.calls.budget.at(-1)).toEqual({ aiProvider: "openai" });
    expect(f.calls.removed).toEqual([RAW]);
    expect(f.record()).toBeNull();
    expect(f.calls.clearAck).toBe(1);
    expect(JSON.stringify({ ...f.calls, credentialSave: [] })).not.toContain("sk-never-copy-this");
  });

  it("a lost response after the vault commit retries via status and never leaves zero copies", async () => {
    const f = fixture(legacy);
    let loseResponse = true;
    const save = f.deps.saveCredential;
    f.deps.saveCredential = async (...args) => {
      await save(...args);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response_lost");
      }
    };

    await runLegacySettingsMigration(f.deps);
    f.acknowledgeAccount();
    await runLegacySettingsMigration(f.deps);
    f.acknowledgeBudget();
    await expect(runLegacySettingsMigration(f.deps)).rejects.toThrow("response_lost");
    expect(f.record()?.value.openaiKey).toBe("sk-never-copy-this");

    await runLegacySettingsMigration(f.deps);
    expect(f.calls.credentialSave).toHaveLength(1);
    expect(f.record()?.value.openaiKey).toBe("sk-never-copy-this");
    f.acknowledgeBudget();
    await runLegacySettingsMigration(f.deps);
    expect(f.record()).toBeNull();
  });

  it("an acknowledgement write failing after a preference update cannot skip the server acknowledgement", async () => {
    const f = fixture(legacy);
    const saveAck = f.deps.saveAck;
    let failAccountAck = true;
    f.deps.saveAck = async (next) => {
      if (next.account === "pending" && failAccountAck) {
        failAccountAck = false;
        throw new Error("ack_write_failed");
      }
      await saveAck(next);
    };

    await expect(runLegacySettingsMigration(f.deps)).rejects.toThrow("ack_write_failed");
    expect(f.calls.account).toHaveLength(1);
    expect(f.ack().account).toBeUndefined();
    await runLegacySettingsMigration(f.deps);
    expect(f.ack().account).toBe("pending");
    expect(f.calls.credentialSave).toEqual([]);
    expect(f.record()?.value.openaiKey).toBe("sk-never-copy-this");
  });

  it("a provider-ack failure never deletes localStorage while its outbox op is pending", async () => {
    const f = fixture(legacy);
    await runLegacySettingsMigration(f.deps);
    f.acknowledgeAccount();
    await runLegacySettingsMigration(f.deps);
    f.acknowledgeBudget();
    const saveAck = f.deps.saveAck;
    let failProviderAck = true;
    f.deps.saveAck = async (next) => {
      if (next.provider === "pending" && failProviderAck) {
        failProviderAck = false;
        throw new Error("provider_ack_write_failed");
      }
      await saveAck(next);
    };

    await expect(runLegacySettingsMigration(f.deps)).rejects.toThrow("provider_ack_write_failed");
    await runLegacySettingsMigration(f.deps);
    expect(f.ack().provider).toBe("pending");
    expect(f.record()?.value.openaiKey).toBe("sk-never-copy-this");
    expect(f.calls.removed).toEqual([]);
  });

  it("keeps an E2EE key byte-for-byte and records pending-stage-4", async () => {
    const f = fixture(legacy);
    f.setTier("e2ee");
    await runLegacySettingsMigration(f.deps);
    f.acknowledgeAccount();
    await runLegacySettingsMigration(f.deps);
    f.acknowledgeBudget();
    await runLegacySettingsMigration(f.deps);

    expect(f.ack().credential).toBe("pending-stage-4");
    expect(f.calls.credentialSave).toEqual([]);
    expect(f.record()).toEqual({ raw: RAW, value: legacy });
  });

  it("does not overwrite canonical preferences and removes a no-key record only after acknowledgements", async () => {
    const f = fixture({ ...legacy, openaiKey: undefined, aiMode: "server" });
    f.setAccount({ ...createDefaultAccountPreferences(), lang: "de" }, 3);
    f.setBudget({ ...createDefaultBudgetPreferences(), aiProvider: "openai", openaiModel: "gpt-5.6-terra" });
    await runLegacySettingsMigration(f.deps);

    expect(f.calls.account).toEqual([]);
    expect(f.calls.budget).toEqual([]);
    expect(f.record()).toBeNull();
    expect(f.calls.removed).toEqual([RAW]);
  });

  it("does not move the key while the budget preference op is still pending", async () => {
    const f = fixture(legacy);
    await runLegacySettingsMigration(f.deps);
    f.acknowledgeAccount();
    await runLegacySettingsMigration(f.deps);
    await runLegacySettingsMigration(f.deps);

    expect(f.calls.budget).toHaveLength(1);
    expect(f.calls.credentialSave).toEqual([]);
    expect(f.record()?.value.openaiKey).toBe("sk-never-copy-this");
  });
});
