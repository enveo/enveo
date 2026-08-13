/**
 * The shared numpad's KEY CONTRACT, pure and in one place.
 *
 * Two different things live on one cell and must never be confused:
 * - the CANONICAL key it emits (`NumpadKey[0]`) — what `padKey` consumes. Locale-independent,
 *   decimal is always ",".
 * - the LABEL a human sees (`numpadKeyLabel`) — glyphs for ⌫/✓/=, and the UI language's decimal
 *   separator from `Intl` ("." in English, "," in Polish).
 *
 * It lives here rather than in `components/pickers.tsx` so the contract is unit-testable without a
 * DOM, and so no screen can grow its own divergent decimal key: `Numpad` is the only renderer.
 */
import { decimalSeparator } from "./format";
import type { Lang } from "./i18n";

/** `[canonical key, cell kind]` — kind drives colour only: n=number, o=operator, f=delete, k=OK. */
export type NumpadKey = [string, "n" | "o" | "f" | "k"];

/** Row order shared by both variants: [1 2 3 ⌫][4 5 6 +][7 8 9 −][× 0 , ✓]
 *  (digits 1-2-3 on top, decimal under 9, contextual OK bottom-right). */
export const NUMPAD_KEYS: NumpadKey[] = [
  ["1", "n"],
  ["2", "n"],
  ["3", "n"],
  ["DEL", "f"],
  ["4", "n"],
  ["5", "n"],
  ["6", "n"],
  ["+", "o"],
  ["7", "n"],
  ["8", "n"],
  ["9", "n"],
  ["−", "o"],
  ["×", "o"],
  ["0", "n"],
  [",", "n"],
  ["OK", "k"],
];

/** What the cell for `key` SHOWS. Presentation only — the emitted key is `key` itself, unchanged. */
export function numpadKeyLabel(key: string, lang: Lang, okGlyph: "check" | "equals" = "check"): string {
  if (key === "DEL") return "⌫";
  if (key === "OK") return okGlyph === "equals" ? "=" : "✓";
  if (key === ",") return decimalSeparator(lang);
  return key;
}
