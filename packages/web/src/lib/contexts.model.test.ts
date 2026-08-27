/**
 * BYOK model registry (backlog §1, Luna migration): fresh settings default to gpt-5.6-luna,
 * while a legacy persisted choice must stay in the union — loadSettings merges the persisted
 * object OVER the defaults, so preserving the old ids in `OpenAiModel` is what keeps an
 * existing user's explicit selection alive (a removed id would silently retype their device).
 */
import { describe, expect, it } from "bun:test";
import { createDefaultBudgetPreferences } from "@enveo/shared";
import {
  DEFAULT_OPENAI_MODEL,
  type DeviceOverrideActive,
  effectiveAccentTheme,
  effectiveThemeMode,
  OPENAI_MODELS,
  type OpenAiModel,
  type Settings,
  splitSettingsPatch,
} from "./contexts";

const settings = (): Settings => ({
  themeMode: "light",
  accentTheme: "teal",
  discreet: false,
  lang: "en",
  aiMode: "off",
  openaiModel: DEFAULT_OPENAI_MODEL,
  customProfiles: [],
  startWidgets: createDefaultBudgetPreferences().startWidgets,
});

const NO_OVERRIDE: DeviceOverrideActive = { themeMode: false, accentTheme: false };

describe("settings scope routing", () => {
  it("routes language and theme to the account cache when no device override is active", () => {
    const before = settings();
    expect(splitSettingsPatch(before, { ...before, lang: "pl", themeMode: "dark" }, NO_OVERRIDE)).toEqual({
      account: { lang: "pl", themeMode: "dark" },
      budget: {},
      device: {},
    });
  });

  it("routes dashboard and model changes only to the budget replica", () => {
    const before = settings();
    const widgets = before.startWidgets.map((widget) => ({ ...widget, enabled: widget.id === "accounts" ? false : widget.enabled }));
    expect(splitSettingsPatch(before, { ...before, openaiModel: "gpt-5.6-sol", startWidgets: widgets }, NO_OVERRIDE)).toEqual({
      account: {},
      budget: { openaiModel: "gpt-5.6-sol", startWidgets: widgets },
      device: {},
    });
  });

  it("routes discreet mode only to device metadata", () => {
    const before = settings();
    expect(splitSettingsPatch(before, { ...before, discreet: true }, NO_OVERRIDE)).toEqual({ account: {}, budget: {}, device: { discreet: true } });
  });

  it("routes a theme-mode change to the device override once one is active, leaving the account preference untouched", () => {
    const before = settings();
    expect(splitSettingsPatch(before, { ...before, themeMode: "dark" }, { themeMode: true, accentTheme: false })).toEqual({
      account: {},
      budget: {},
      device: { themeModeOverride: "dark" },
    });
  });

  it("routes an accent-theme change to the device override once one is active, leaving the account preference untouched", () => {
    const before = settings();
    expect(splitSettingsPatch(before, { ...before, accentTheme: "duet" }, { themeMode: false, accentTheme: true })).toEqual({
      account: {},
      budget: {},
      device: { accentThemeOverride: "duet" },
    });
  });

  it("keeps routing to account when a change touches only the field without an active override", () => {
    const before = settings();
    // themeMode is overridden, accentTheme is not: an accentTheme-only change still goes to account.
    expect(splitSettingsPatch(before, { ...before, accentTheme: "duet" }, { themeMode: true, accentTheme: false })).toEqual({
      account: { accentTheme: "duet" },
      budget: {},
      device: {},
    });
  });
});

describe("effective theme resolution (override ?? account)", () => {
  it("falls back to the account preference when no device override is set", () => {
    expect(effectiveThemeMode("light", null)).toBe("light");
    expect(effectiveAccentTheme("teal", null)).toBe("teal");
  });

  it("prefers an active device override over the account preference", () => {
    expect(effectiveThemeMode("light", "dark")).toBe("dark");
    expect(effectiveAccentTheme("teal", "duet")).toBe("duet");
  });

  it("keeps an overridden device unaffected by a later account-wide change", () => {
    // The device froze "dark" as its own override; the account preference changing underneath it
    // (e.g. from another device, or the owner switching "All devices" scope elsewhere) must not
    // repaint this device — the override always wins until this device's own scope control clears it.
    expect(effectiveThemeMode("light", "dark")).toBe("dark");
    expect(effectiveThemeMode("auto", "dark")).toBe("dark");
  });
});

describe("BYOK model registry", () => {
  it("fresh settings default to gpt-5.6-luna", () => {
    expect(DEFAULT_OPENAI_MODEL).toBe("gpt-5.6-luna");
    expect(OPENAI_MODELS[0]).toBe("gpt-5.6-luna");
  });

  it("the §1b tier models are registered persistable choices", () => {
    expect(OPENAI_MODELS).toContain("gpt-5.6-terra");
    expect(OPENAI_MODELS).toContain("gpt-5.6-sol");
  });

  it("legacy persisted choices remain registered (never silently overwritten)", () => {
    expect(OPENAI_MODELS).toContain("gpt-5.5");
    expect(OPENAI_MODELS).toContain("gpt-5.5-mini");
    // compile-time: the union still accepts a legacy value
    const legacy: OpenAiModel = "gpt-5.5-mini";
    expect(OPENAI_MODELS).toContain(legacy);
  });
});
