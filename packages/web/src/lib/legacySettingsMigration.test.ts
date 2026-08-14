import { describe, expect, it } from "bun:test";
import { type AccountPreferences, type BudgetPreferences, createDefaultAccountPreferences, createDefaultBudgetPreferences } from "@enveo/shared";
import { type LegacyMigrationAck, type LegacySettingsMigrationDeps, runLegacySettingsMigration } from "./legacySettingsMigration";
import type { LegacySettings } from "./settingsPersist";

function fixture(legacy: LegacySettings | null) {
  let ack: LegacyMigrationAck = { schemaVersion: 1 };
  let account = createDefaultAccountPreferences();
  let budget = createDefaultBudgetPreferences();
  let device = { schemaVersion: 1 as const, discreet: false };
  let accountRevision = 0;
  let devicePresent = false;
  const calls = { account: [] as unknown[], budget: [] as unknown[], device: [] as unknown[], ack: [] as LegacyMigrationAck[] };
  const deps: LegacySettingsMigrationDeps = {
    readLegacy: () => legacy,
    loadAck: async () => ack,
    saveAck: async (next) => {
      ack = structuredClone(next);
      calls.ack.push(ack);
    },
    accountState: () => ({ value: account, revision: accountRevision, dirty: {} }),
    updateAccount: async (patch) => {
      calls.account.push(patch);
      account = { ...account, ...patch };
      accountRevision++;
    },
    budgetState: () => budget,
    updateBudget: async (patch) => {
      calls.budget.push(patch);
      budget = { ...budget, ...patch };
    },
    deviceState: () => ({ value: device, present: devicePresent }),
    updateDevice: async (patch) => {
      calls.device.push(patch);
      device = { ...device, ...patch };
      devicePresent = true;
    },
  };
  return {
    deps,
    calls,
    ack: () => ack,
    setAccount(value: AccountPreferences, revision: number) {
      account = value;
      accountRevision = revision;
    },
    setBudget(value: BudgetPreferences) {
      budget = value;
    },
    setDevicePresent(value: boolean) {
      devicePresent = value;
    },
  };
}

const legacy: LegacySettings = {
  themeMode: "dark",
  accentTheme: "duet",
  lang: "pl",
  discreet: true,
  aiMode: "server",
  openaiKey: "sk-never-copy-this",
  openaiModel: "gpt-5.6-sol",
  customProfiles: [],
  startWidgets: createDefaultBudgetPreferences().startWidgets,
};

describe("legacy settings migration", () => {
  it("does nothing for absent or malformed legacy settings", async () => {
    const f = fixture(null);
    await runLegacySettingsMigration(f.deps);
    expect(f.calls).toEqual({ account: [], budget: [], device: [], ack: [] });
  });

  it("seeds non-secret values into their canonical scopes and never passes the BYOK", async () => {
    const f = fixture(legacy);
    await runLegacySettingsMigration(f.deps);

    expect(f.calls.account).toEqual([{ lang: "pl", themeMode: "dark", accentTheme: "duet" }]);
    expect(f.calls.budget).toEqual([{ aiProvider: "enveo", openaiModel: "gpt-5.6-sol", customProfiles: [], startWidgets: legacy.startWidgets }]);
    expect(f.calls.device).toEqual([{ discreet: true }]);
    expect(JSON.stringify(f.calls)).not.toContain("sk-never-copy-this");
    expect(f.ack()).toEqual({ schemaVersion: 1, account: true, budget: true, device: true });
  });

  it("keeps canonical values when a scope already exists", async () => {
    const f = fixture(legacy);
    f.setAccount({ ...createDefaultAccountPreferences(), lang: "de" }, 3);
    f.setBudget({ ...createDefaultBudgetPreferences(), aiProvider: "openai", openaiModel: "gpt-5.6-terra" });
    f.setDevicePresent(true);

    await runLegacySettingsMigration(f.deps);

    expect(f.calls.account).toEqual([]);
    expect(f.calls.budget).toEqual([]);
    expect(f.calls.device).toEqual([]);
    expect(f.ack()).toEqual({ schemaVersion: 1, account: true, budget: true, device: true });
  });

  it("persists scope acknowledgements so a partial failure resumes without replaying completed work", async () => {
    const f = fixture(legacy);
    let fail = true;
    const updateBudget = f.deps.updateBudget;
    f.deps.updateBudget = async (patch) => {
      if (fail) {
        fail = false;
        throw new Error("temporary");
      }
      await updateBudget(patch);
    };

    await expect(runLegacySettingsMigration(f.deps)).rejects.toThrow("temporary");
    expect(f.ack()).toEqual({ schemaVersion: 1, account: true });
    await runLegacySettingsMigration(f.deps);

    expect(f.calls.account).toHaveLength(1);
    expect(f.calls.budget).toHaveLength(1);
    expect(f.ack()).toEqual({ schemaVersion: 1, account: true, budget: true, device: true });
  });
});
