/**
 * Envelope template for the onboarding wizard — data + styling only (no React).
 * Colors/icons are EXACTLY the demo-seed mapping (api/src/db/seed.ts ENVELOPES):
 * the seed's PL names correspond 1:1 to the EN message keys below, so a fresh
 * "empty budget" start and the "sample data" path land on visually matching envelopes.
 */
import { type Message, msg } from "./i18n";

export type TemplateEnvelope = { name: Message; color: string; icon: string; isSavings?: boolean };
export type TemplateGroup = { group: Message; envelopes: TemplateEnvelope[] };

export const TEMPLATE: TemplateGroup[] = [
  {
    group: msg("Bills"),
    envelopes: [
      { name: msg("Housing"), color: "#ccd9b6", icon: "house" },
      { name: msg("Utilities"), color: "#8f84a8", icon: "receipt" },
      { name: msg("Subscriptions"), color: "#f0c84f", icon: "play" },
    ],
  },
  {
    group: msg("Living"),
    envelopes: [
      { name: msg("Groceries"), color: "#f1dca0", icon: "food" },
      { name: msg("Transport"), color: "#e7e1d4", icon: "car" },
      { name: msg("Health"), color: "#f0d6cc", icon: "heart" },
      { name: msg("Fun"), color: "#aed6ea", icon: "gift" },
    ],
  },
  {
    group: msg("Savings"),
    envelopes: [
      { name: msg("Savings"), color: "#f3c45f", icon: "moneybag", isSavings: true },
      { name: msg("Rainy day"), color: "#e6e6ea", icon: "tag" },
    ],
  },
];

/** The nine template colors, in template order — the cycle custom envelopes draw from. */
export const CUSTOM_ENVELOPE_COLORS: string[] = TEMPLATE.flatMap((g) => g.envelopes.map((e) => e.color));

/**
 * Style for the Nth custom envelope added in the wizard (0-based, counted across ALL
 * groups — a running total, not per-group) — cycles through CUSTOM_ENVELOPE_COLORS so
 * consecutive customs don't collide, and wraps once every template color has been used.
 * Icon is always "tag" (a custom envelope has no type to match an icon to).
 */
export function customEnvelopeStyle(index: number): { color: string; icon: string } {
  const color = CUSTOM_ENVELOPE_COLORS[((index % CUSTOM_ENVELOPE_COLORS.length) + CUSTOM_ENVELOPE_COLORS.length) % CUSTOM_ENVELOPE_COLORS.length]!;
  return { color, icon: "tag" };
}
