import {
  type AccountPreferenceField,
  type AccountPreferences,
  type AccountPreferencesPatch,
  type BudgetPreferences,
  type BudgetPreferencesPatch,
  createDefaultBudgetPreferences,
  type OpenAiModel,
} from "@enveo/shared";
import type { DevicePreferences, DevicePreferencesPatch } from "./devicePreferences";
import type { LegacySettings, LegacySettingsRecord } from "./settingsPersist";

type AckState = true | "pending";

export interface LegacyMigrationAck {
  schemaVersion: 1;
  account?: AckState;
  budget?: AckState;
  device?: true;
  credential?: true | "pending-stage-4";
  provider?: AckState;
  complete?: true;
}

export interface LegacyMigrationContext {
  userId: string;
  budgetId: string;
  tier: "plain" | "e2ee";
}

export interface LegacySettingsMigrationDeps {
  readLegacy(): LegacySettingsRecord | null;
  removeLegacy(expectedRaw: string): Promise<boolean> | boolean;
  loadAck(): Promise<LegacyMigrationAck>;
  saveAck(value: LegacyMigrationAck): Promise<void>;
  clearAck(): Promise<void>;
  context(): LegacyMigrationContext | null;
  accountState(): {
    value: AccountPreferences;
    revision: number;
    dirty: Partial<Record<AccountPreferenceField, true>>;
  } | null;
  updateAccount(patch: AccountPreferencesPatch): Promise<void> | void;
  budgetState(): BudgetPreferences;
  updateBudget(patch: BudgetPreferencesPatch): Promise<void> | void;
  budgetPreferencePending(): boolean;
  deviceState(): { value: DevicePreferences; present: boolean };
  updateDevice(patch: DevicePreferencesPatch): Promise<void> | void;
  credentialStatus(budgetId: string): Promise<{ configured: boolean; available: boolean }>;
  saveCredential(budgetId: string, model: OpenAiModel, key: string): Promise<void>;
}

const ackState = (value: unknown): AckState | undefined => (value === true || value === "pending" ? value : undefined);

export function parseLegacyMigrationAck(raw: unknown): LegacyMigrationAck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { schemaVersion: 1 };
  const source = raw as Record<string, unknown>;
  if (source.schemaVersion !== 1) return { schemaVersion: 1 };
  const credential = source.credential === true || source.credential === "pending-stage-4" ? source.credential : undefined;
  return {
    schemaVersion: 1,
    ...(ackState(source.account) ? { account: ackState(source.account) } : {}),
    ...(ackState(source.budget) ? { budget: ackState(source.budget) } : {}),
    ...(source.device === true ? { device: true as const } : {}),
    ...(credential ? { credential } : {}),
    ...(ackState(source.provider) ? { provider: ackState(source.provider) } : {}),
    ...(source.complete === true ? { complete: true as const } : {}),
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

/** With a legacy key, provider=openai is deliberately deferred until the vault
 * confirms a copy. This ordering is what prevents a provider preference from
 * pointing at a credential that exists only in localStorage. */
function budgetPatch(legacy: LegacySettings, hasCredential: boolean): BudgetPreferencesPatch {
  const patch: BudgetPreferencesPatch = {};
  if (legacy.aiMode && !hasCredential) patch.aiProvider = legacy.aiMode === "server" ? "enveo" : legacy.aiMode === "byok" ? "openai" : "rules";
  if (legacy.openaiModel) patch.openaiModel = legacy.openaiModel;
  if (legacy.customProfiles) patch.customProfiles = legacy.customProfiles;
  if (legacy.startWidgets) patch.startWidgets = legacy.startWidgets;
  return patch;
}

function budgetHasCanonicalValue(value: BudgetPreferences): boolean {
  return JSON.stringify(value) !== JSON.stringify(createDefaultBudgetPreferences());
}

async function mark(deps: LegacySettingsMigrationDeps, ack: LegacyMigrationAck, patch: Partial<LegacyMigrationAck>): Promise<LegacyMigrationAck> {
  const next = { ...ack, ...patch };
  await deps.saveAck(next);
  return next;
}

export async function runLegacySettingsMigration(deps: LegacySettingsMigrationDeps): Promise<void> {
  const record = deps.readLegacy();
  if (!record) {
    await deps.clearAck();
    return;
  }
  const context = deps.context();
  if (!context) return;
  const legacy = record.value;
  const rawKey = legacy.openaiKey?.trim() ?? "";
  const hasCredential = rawKey.length > 0;
  let ack = await deps.loadAck();

  if (ack.complete) {
    const removed = await deps.removeLegacy(record.raw);
    await deps.clearAck();
    if (!removed) return;
    return;
  }

  if (!ack.account) {
    const state = deps.accountState();
    const patch = accountPatch(legacy);
    if (state && Object.keys(state.dirty).length > 0) {
      await mark(deps, ack, { account: "pending" });
      return;
    }
    const canonicalExists = !!state && (state.revision > 0 || Object.keys(state.dirty).length > 0);
    if (!canonicalExists && hasKeys(patch)) {
      await deps.updateAccount(patch);
      await mark(deps, ack, { account: "pending" });
      return;
    }
    ack = await mark(deps, ack, { account: true });
  } else if (ack.account === "pending") {
    const state = deps.accountState();
    if (!state || Object.keys(state.dirty).length > 0) return;
    ack = await mark(deps, ack, { account: true });
  }

  if (!ack.budget) {
    if (deps.budgetPreferencePending()) {
      await mark(deps, ack, { budget: "pending" });
      return;
    }
    const patch = budgetPatch(legacy, hasCredential);
    if (!budgetHasCanonicalValue(deps.budgetState()) && hasKeys(patch)) {
      await deps.updateBudget(patch);
      await mark(deps, ack, { budget: "pending" });
      return;
    }
    ack = await mark(deps, ack, { budget: true });
  } else if (ack.budget === "pending") {
    if (deps.budgetPreferencePending()) return;
    ack = await mark(deps, ack, { budget: true });
  }

  if (!ack.device) {
    const state = deps.deviceState();
    const patch: DevicePreferencesPatch = legacy.discreet === undefined ? {} : { discreet: legacy.discreet };
    if (!state.present && hasKeys(patch)) await deps.updateDevice(patch);
    ack = await mark(deps, ack, { device: true });
  }

  if (!hasCredential) {
    ack = ack.credential ? ack : await mark(deps, ack, { credential: true });
  } else if (context.tier === "e2ee") {
    if (ack.credential !== "pending-stage-4") await mark(deps, ack, { credential: "pending-stage-4" });
    return;
  } else if (!ack.credential) {
    const status = await deps.credentialStatus(context.budgetId);
    if (!status.available) throw new Error("vault_unavailable");
    if (!status.configured) await deps.saveCredential(context.budgetId, legacy.openaiModel ?? "gpt-5.6-luna", rawKey);
    const confirmed = await deps.credentialStatus(context.budgetId);
    if (!confirmed.available) throw new Error("vault_unavailable");
    if (!confirmed.configured) throw new Error("credential_not_configured");
    ack = await mark(deps, ack, { credential: true });
  }

  if (hasCredential && !ack.provider) {
    if (deps.budgetState().aiProvider !== "openai") {
      await deps.updateBudget({ aiProvider: "openai" });
      await mark(deps, ack, { provider: "pending" });
      return;
    }
    if (deps.budgetPreferencePending()) {
      await mark(deps, ack, { provider: "pending" });
      return;
    }
    ack = await mark(deps, ack, { provider: true });
  } else if (ack.provider === "pending") {
    if (deps.budgetPreferencePending()) return;
    ack = await mark(deps, ack, { provider: true });
  }

  ack = await mark(deps, ack, { complete: true });
  const removed = await deps.removeLegacy(record.raw);
  await deps.clearAck();
  if (!removed) return;
}

let configured: LegacySettingsMigrationDeps | null = null;

export function configureLegacySettingsMigration(deps: LegacySettingsMigrationDeps): void {
  configured = deps;
}

export async function migrateLegacySettings(): Promise<void> {
  if (!configured) throw new Error("legacy_settings_migration_unconfigured");
  await runLegacySettingsMigration(configured);
}
