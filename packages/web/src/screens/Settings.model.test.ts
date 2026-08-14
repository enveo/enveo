import { describe, expect, it } from "bun:test";
import { SETTINGS_CATEGORIES, SETTINGS_HUB_FOOTER_ACTIONS } from "./Settings";

describe("Settings information architecture", () => {
  it("has exactly four product categories and no Advanced catch-all", () => {
    expect(SETTINGS_CATEGORIES.map((category) => category.id)).toEqual(["appearance", "ai", "privacy", "data"]);
    expect(SETTINGS_CATEGORIES.some((category) => category.id === ("advanced" as never))).toBe(false);
  });

  it("keeps sign-out outside category cards at the bottom of the hub", () => {
    expect(SETTINGS_CATEGORIES.some((category) => "action" in category && category.action === "signOut")).toBe(false);
    expect(SETTINGS_HUB_FOOTER_ACTIONS).toEqual(["signOut"]);
  });

  it("has no Advanced screen or Local-only product copy", async () => {
    const settingsDir = `${import.meta.dir}/settings`;
    const sources = await Promise.all(
      ["Settings.tsx", "settings/Appearance.tsx", "settings/Ai.tsx", "settings/PrivacySection.tsx", "settings/DataSection.tsx", "settings/DataTools.tsx"].map(
        (file) => Bun.file(`${import.meta.dir}/${file}`).text(),
      ),
    );

    expect(await Bun.file(`${settingsDir}/Advanced.tsx`).exists()).toBe(false);
    expect(sources.join("\n")).not.toMatch(/local-only|Local mode/);
  });

  it("shows legacy BYOK migration state without exposing a new-key input", async () => {
    const sources = await Promise.all([
      Bun.file(`${import.meta.dir}/settings/Ai.tsx`).text(),
      Bun.file(`${import.meta.dir}/../components/AiConsentSheet.tsx`).text(),
    ]);
    expect(sources.join("\n")).not.toContain('type="password"');
    expect(sources.join("\n")).not.toContain("setEphemeralOpenAiCredential");
  });
});
