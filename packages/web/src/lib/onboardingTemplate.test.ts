import { describe, expect, test } from "bun:test";
import { ICON_CATEGORIES } from "./icons";
import { CUSTOM_ENVELOPE_COLORS, customEnvelopeStyle, TEMPLATE } from "./onboardingTemplate";

const REGISTERED_ICONS = new Set(ICON_CATEGORIES.flatMap((c) => c.icons));

describe("onboarding envelope template", () => {
  test("every entry has a valid hex color and a registered icon", () => {
    for (const g of TEMPLATE)
      for (const e of g.envelopes) {
        expect(e.color, `${e.name}: color`).toMatch(/^#[0-9a-f]{6}$/);
        expect(REGISTERED_ICONS.has(e.icon), `${e.name}: icon "${e.icon}" is not in the icons registry`).toBe(true);
      }
  });

  test("nine envelopes across the three groups", () => {
    expect(TEMPLATE.flatMap((g) => g.envelopes)).toHaveLength(9);
  });

  test("CUSTOM_ENVELOPE_COLORS is exactly the nine template colors, in template order", () => {
    expect(CUSTOM_ENVELOPE_COLORS).toEqual(TEMPLATE.flatMap((g) => g.envelopes.map((e) => e.color)));
  });
});

describe("customEnvelopeStyle", () => {
  test("cycles through the template colors in order", () => {
    for (let i = 0; i < CUSTOM_ENVELOPE_COLORS.length; i++) expect(customEnvelopeStyle(i).color).toBe(CUSTOM_ENVELOPE_COLORS[i]!);
  });

  test("wraps around after the ninth custom envelope", () => {
    expect(customEnvelopeStyle(CUSTOM_ENVELOPE_COLORS.length)).toEqual(customEnvelopeStyle(0));
    expect(customEnvelopeStyle(CUSTOM_ENVELOPE_COLORS.length + 2)).toEqual(customEnvelopeStyle(2));
  });

  test("always uses the tag icon", () => {
    for (let i = 0; i < 12; i++) expect(customEnvelopeStyle(i).icon).toBe("tag");
  });
});
