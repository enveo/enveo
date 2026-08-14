/**
 * BYOK model registry (backlog §1, Luna migration): fresh settings default to gpt-5.6-luna,
 * while a legacy persisted choice must stay in the union — loadSettings merges the persisted
 * object OVER the defaults, so preserving the old ids in `OpenAiModel` is what keeps an
 * existing user's explicit selection alive (a removed id would silently retype their device).
 */
import { describe, expect, it } from "bun:test";
import { createDefaultBudgetPreferences } from "@enveo/shared";
import { DEFAULT_OPENAI_MODEL, OPENAI_MODELS, type OpenAiModel, type Settings, splitSettingsPatch } from "./contexts";

const settings = (): Settings => ({
  themeMode: "light",
  accentTheme: "teal",
  discreet: false,
  lang: "en",
  aiMode: "off",
  openaiKey: "",
  openaiModel: DEFAULT_OPENAI_MODEL,
  customProfiles: [],
  startWidgets: createDefaultBudgetPreferences().startWidgets,
});

describe("settings scope routing", () => {
  it("routes language and theme only to the account cache", () => {
    const before = settings();
    expect(splitSettingsPatch(before, { ...before, lang: "pl", themeMode: "dark" })).toEqual({
      account: { lang: "pl", themeMode: "dark" },
      budget: {},
      device: {},
    });
  });

  it("routes dashboard and model changes only to the budget replica", () => {
    const before = settings();
    const widgets = before.startWidgets.map((widget) => ({ ...widget, enabled: widget.id === "accounts" ? false : widget.enabled }));
    expect(splitSettingsPatch(before, { ...before, openaiModel: "gpt-5.6-sol", startWidgets: widgets })).toEqual({
      account: {},
      budget: { openaiModel: "gpt-5.6-sol", startWidgets: widgets },
      device: {},
    });
  });

  it("routes discreet mode only to device metadata", () => {
    const before = settings();
    expect(splitSettingsPatch(before, { ...before, discreet: true })).toEqual({ account: {}, budget: {}, device: { discreet: true } });
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
