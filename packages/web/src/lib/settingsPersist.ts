/** Read-only quarantine for the pre-scoped `enveo.settings` localStorage object. */
import {
  ACCENT_THEMES,
  LANGS,
  type Lang,
  OPENAI_MODELS,
  type OpenAiModel,
  THEME_MODES,
  type ThemeMode,
  type WidgetConfig,
  widgetConfigSchema,
} from "@enveo/shared";
import { storageMode } from "./idb";

const SETTINGS_KEY = "enveo.settings";

export interface LegacySettings {
  themeMode?: ThemeMode;
  accentTheme?: (typeof ACCENT_THEMES)[number] | "koral" | "atrament";
  discreet?: boolean;
  lang?: Lang;
  aiMode?: "off" | "server" | "byok";
  openaiKey?: string;
  openaiModel?: OpenAiModel;
  customProfiles?: Array<{ id: string; name: string; prompt: string }>;
  startWidgets?: WidgetConfig[];
}
export type CredentialMigration = "pending-stage-3";

export interface LegacySettingsRecord {
  raw: string;
  value: LegacySettings;
}

let ephemeralCredential: { key: string; model?: OpenAiModel } | null = null;

const LEGACY_KEYS = new Set(["themeMode", "accentTheme", "discreet", "lang", "aiMode", "openaiKey", "openaiModel", "customProfiles", "startWidgets"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isOneOf = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === "string" && values.includes(value as T);
const uniqueIds = <T extends { id: string }>(values: T[]): boolean => new Set(values.map((value) => value.id)).size === values.length;

function parseLegacySettings(raw: unknown): LegacySettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (Object.keys(source).some((key) => !LEGACY_KEYS.has(key))) return null;
  if (source.themeMode !== undefined && !isOneOf(source.themeMode, THEME_MODES)) return null;
  if (source.accentTheme !== undefined && !isOneOf(source.accentTheme, [...ACCENT_THEMES, "koral", "atrament"])) return null;
  if (source.discreet !== undefined && typeof source.discreet !== "boolean") return null;
  if (source.lang !== undefined && !isOneOf(source.lang, LANGS)) return null;
  if (source.aiMode !== undefined && !isOneOf(source.aiMode, ["off", "server", "byok"])) return null;
  if (source.openaiKey !== undefined && typeof source.openaiKey !== "string") return null;
  if (source.openaiModel !== undefined && !isOneOf(source.openaiModel, OPENAI_MODELS)) return null;
  if (source.customProfiles !== undefined) {
    if (!Array.isArray(source.customProfiles)) return null;
    const profiles = source.customProfiles as Array<Record<string, unknown>>;
    if (
      profiles.some(
        (profile) =>
          !profile ||
          typeof profile !== "object" ||
          Array.isArray(profile) ||
          Object.keys(profile).some((key) => !["id", "name", "prompt"].includes(key)) ||
          typeof profile.id !== "string" ||
          !UUID.test(profile.id) ||
          typeof profile.name !== "string" ||
          typeof profile.prompt !== "string",
      ) ||
      !uniqueIds(profiles as Array<{ id: string }>)
    )
      return null;
  }
  if (source.startWidgets !== undefined) {
    if (!Array.isArray(source.startWidgets)) return null;
    const widgets = source.startWidgets.map((widget) => widgetConfigSchema.safeParse(widget));
    if (widgets.some((widget) => !widget.success)) return null;
    if (!uniqueIds(widgets.map((widget) => widget.data!))) return null;
  }
  return source as LegacySettings;
}

export function readLegacySettings(): LegacySettingsRecord | null {
  if (storageMode() === "memory-forced") return null;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const value = parseLegacySettings(JSON.parse(raw));
    return value ? { raw, value } : null;
  } catch {
    return null;
  }
}

/** Compatibility reader used only until Stage 3 moves an existing key into the vault. */
export function loadPersistedSettings(): LegacySettings | null {
  return readLegacySettings()?.value ?? null;
}

export function legacyCredentialMigration(): CredentialMigration | null {
  const key = readLegacySettings()?.value.openaiKey;
  return key && key.trim().length > 0 ? "pending-stage-3" : null;
}

export function readLegacyOpenAiCredential(): { key: string; model?: OpenAiModel } | null {
  if (ephemeralCredential) return ephemeralCredential;
  const value = readLegacySettings()?.value;
  if (!value?.openaiKey?.trim()) return null;
  return { key: value.openaiKey, model: value.openaiModel };
}

/** Temporary in-memory bridge for a key entered before the Stage 3 vault is available. */
export function setEphemeralOpenAiCredential(key: string, model?: OpenAiModel): void {
  ephemeralCredential = key.trim() ? { key: key.trim(), model } : null;
}

export function clearEphemeralOpenAiCredential(): void {
  ephemeralCredential = null;
}

/** Quarantine is read-only: scoped stores own every new preference write. */
export function persistSettings(_settings: unknown): void {}

/** Explicit sign-out from a shared/cloud device is still allowed to remove the credential. */
export function clearPersistedSettings(): void {
  clearEphemeralOpenAiCredential();
  try {
    localStorage.removeItem(SETTINGS_KEY);
  } catch {
    /* ignore */
  }
}
