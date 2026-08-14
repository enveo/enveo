import {
  type AccountPreferenceField,
  type AccountPreferences,
  type AccountPreferencesPatch,
  type BudgetPreferences,
  type BudgetPreferencesPatch,
  createDefaultBudgetPreferences,
} from "@enveo/shared";
import type { DevicePreferences, DevicePreferencesPatch } from "./devicePreferences";
import type { LegacySettings } from "./settingsPersist";

export interface LegacyMigrationAck {
  schemaVersion: 1;
  account?: true;
  budget?: true;
  device?: true;
}

export interface LegacySettingsMigrationDeps {
  readLegacy(): LegacySettings | null;
  loadAck(): Promise<LegacyMigrationAck>;
  saveAck(value: LegacyMigrationAck): Promise<void>;
  accountState(): {
    value: AccountPreferences;
    revision: number;
    dirty: Partial<Record<AccountPreferenceField, true>>;
  } | null;
  updateAccount(patch: AccountPreferencesPatch): Promise<void> | void;
  budgetState(): BudgetPreferences;
  updateBudget(patch: BudgetPreferencesPatch): Promise<void> | void;
  deviceState(): { value: DevicePreferences; present: boolean };
  updateDevice(patch: DevicePreferencesPatch): Promise<void> | void;
}

export function parseLegacyMigrationAck(raw: unknown): LegacyMigrationAck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { schemaVersion: 1 };
  const source = raw as Record<string, unknown>;
  if (source.schemaVersion !== 1) return { schemaVersion: 1 };
  return {
    schemaVersion: 1,
    ...(source.account === true ? { account: true as const } : {}),
    ...(source.budget === true ? { budget: true as const } : {}),
    ...(source.device === true ? { device: true as const } : {}),
  };
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}

function accountPatch(legacy: LegacySettings): AccountPreferencesPatch {
  const patch: AccountPreferencesPatch = {};
  if (legacy.lang) patch.lang = legacy.lang;
  if (legacy.themeMode) patch.themeMode = legacy.themeMode;
  if (legacy.accentTheme) patch.accentTheme = legacy.accentTheme === "koral" || legacy.accentTheme === "atrament" ? "teal" : legacy.accentTheme;
  return patch;
}

function budgetPatch(legacy: LegacySettings): BudgetPreferencesPatch {
  const patch: BudgetPreferencesPatch = {};
  if (legacy.aiMode) patch.aiProvider = legacy.aiMode === "server" ? "enveo" : legacy.aiMode === "byok" ? "openai" : "rules";
  if (legacy.openaiModel) patch.openaiModel = legacy.openaiModel;
  if (legacy.customProfiles) patch.customProfiles = legacy.customProfiles;
  if (legacy.startWidgets) patch.startWidgets = legacy.startWidgets;
  return patch;
}

function budgetHasCanonicalValue(value: BudgetPreferences): boolean {
  return JSON.stringify(value) !== JSON.stringify(createDefaultBudgetPreferences());
}

export async function runLegacySettingsMigration(deps: LegacySettingsMigrationDeps): Promise<void> {
  const legacy = deps.readLegacy();
  if (!legacy) return;
  let ack = await deps.loadAck();

  if (!ack.account) {
    const state = deps.accountState();
    const patch = accountPatch(legacy);
    const canonicalExists = !!state && (state.revision > 0 || Object.keys(state.dirty).length > 0);
    if (!canonicalExists && hasKeys(patch)) await deps.updateAccount(patch);
    ack = { ...ack, account: true };
    await deps.saveAck(ack);
  }

  if (!ack.budget) {
    const patch = budgetPatch(legacy);
    if (!budgetHasCanonicalValue(deps.budgetState()) && hasKeys(patch)) await deps.updateBudget(patch);
    ack = { ...ack, budget: true };
    await deps.saveAck(ack);
  }

  if (!ack.device) {
    const state = deps.deviceState();
    const patch: DevicePreferencesPatch = legacy.discreet === undefined ? {} : { discreet: legacy.discreet };
    if (!state.present && hasKeys(patch)) await deps.updateDevice(patch);
    ack = { ...ack, device: true };
    await deps.saveAck(ack);
  }
}

let configured: LegacySettingsMigrationDeps | null = null;

export function configureLegacySettingsMigration(deps: LegacySettingsMigrationDeps): void {
  configured = deps;
}

export async function migrateLegacySettings(): Promise<void> {
  if (!configured) throw new Error("legacy_settings_migration_unconfigured");
  await runLegacySettingsMigration(configured);
}
