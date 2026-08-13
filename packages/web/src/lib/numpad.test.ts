import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type PadState, padKey, padPreview } from "./amount";
import { decimalSeparator, localizePadExpression } from "./format";
import type { Lang } from "./i18n";
import { LOCALES } from "./i18n/registry";
import { NUMPAD_KEYS, numpadKeyLabel } from "./numpad";

/** What the shared Numpad's click handler does: the cell's canonical key, "DEL" mapped to "⌫". */
const emit = (key: string) => (key === "DEL" ? "⌫" : key);

/**
 * "Clicks" the cell a user SEES carrying `label` in `lang` and feeds the canonical key it emits to
 * the engine — the pure equivalent of tapping that button. Fails loudly if the label is on no cell,
 * so a language whose separator has no key can never pass silently.
 */
function pressVisible(state: PadState, label: string, lang: Lang, opts?: { allowNegative?: boolean }): PadState {
  const cell = NUMPAD_KEYS.find(([k]) => numpadKeyLabel(k, lang) === label);
  if (!cell) throw new Error(`no numpad cell shows "${label}" in ${lang}`);
  return padKey(state, emit(cell[0]), opts);
}

const type = (labels: string[], lang: Lang, from: PadState = { expr: "", fresh: false }, opts?: { allowNegative?: boolean }): PadState =>
  labels.reduce((s, l) => pressVisible(s, l, lang, opts), from);

describe("numpad key contract — one decimal cell, canonical output, localized face", () => {
  test("the decimal cell EMITS the canonical comma in every language", () => {
    const decimalCells = NUMPAD_KEYS.filter(([k]) => k === ",");
    expect(decimalCells).toHaveLength(1);
    for (const { code } of LOCALES) {
      const [key] = NUMPAD_KEYS.find(([k]) => numpadKeyLabel(k, code) === decimalSeparator(code))!;
      expect(key).toBe(",");
    }
  });

  test("the decimal cell SHOWS the language's separator: '.' in English, ',' in Polish", () => {
    expect(numpadKeyLabel(",", "en")).toBe(".");
    expect(numpadKeyLabel(",", "pl")).toBe(",");
    for (const { code } of LOCALES) expect(numpadKeyLabel(",", code)).toBe(decimalSeparator(code));
  });

  test("no other cell's face changes with the language (digits, operators, ⌫, contextual OK)", () => {
    for (const { code } of LOCALES) {
      for (const [key] of NUMPAD_KEYS) {
        if (key === ",") continue;
        expect(numpadKeyLabel(key, code)).toBe(numpadKeyLabel(key, "en"));
      }
    }
    expect(numpadKeyLabel("DEL", "pl")).toBe("⌫");
    expect(numpadKeyLabel("OK", "pl")).toBe("✓");
    expect(numpadKeyLabel("OK", "pl", "equals")).toBe("=");
    expect(numpadKeyLabel("−", "en")).toBe("−");
  });

  test("clicking the VISIBLE '.' (en) and ',' (pl) produces the same canonical state", () => {
    const en = type(["1", "2", ".", "5", "0"], "en");
    const pl = type(["1", "2", ",", "5", "0"], "pl");
    expect(en.expr).toBe("12,50");
    expect(pl.expr).toBe(en.expr);
  });

  test("a second decimal press is ignored, and at most two fraction digits are accepted", () => {
    const en = type(["1", "2", ".", "5", ".", "0", "7"], "en");
    expect(en.expr).toBe("12,50");
    expect(padPreview(en.expr)).toBe(1250);
    const pl = type(["1", "2", ",", "5", ",", "0", "7"], "pl");
    expect(pl.expr).toBe("12,50");
    expect(type(["0", ",", "0", "5"], "pl").expr).toBe("0,05");
  });
});

describe("round trip — the same visible keystrokes commit identical minor units in en and pl", () => {
  const cases: Array<{ name: string; keys: (sep: string) => string[]; expected: number; allowNegative?: boolean }> = [
    { name: "plain fraction", keys: (s) => ["1", "2", s, "5", "0"], expected: 1250 },
    { name: "addition of two fractions", keys: (s) => ["1", "2", s, "5", "0", "+", "2", s, "7", "0"], expected: 1520 },
    { name: "subtraction crossing zero", keys: (s) => ["2", "0", "0", s, "2", "5", "−", "5", "0", "0"], expected: -29975 },
    { name: "multiplication", keys: (s) => ["1", "2", s, "5", "0", "×", "4"], expected: 5000 },
    { name: "delete then retype the fraction", keys: (s) => ["9", "9", s, "9", "9", "⌫", "⌫", "0", "1"], expected: 9901 },
    { name: "leading zero stays a single zero", keys: (s) => ["0", "0", s, "5"], expected: 50 },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const en = type(c.keys("."), "en", { expr: "", fresh: false }, { allowNegative: c.allowNegative });
      const pl = type(c.keys(","), "pl", { expr: "", fresh: false }, { allowNegative: c.allowNegative });
      expect(en.expr).toBe(pl.expr);
      expect(padPreview(en.expr)).toBe(c.expected);
      expect(padPreview(pl.expr)).toBe(c.expected);
    });
  }

  test("division reduces identically (÷ has no cell, it arrives through the engine)", () => {
    const en = padKey(type(["1", "0", "0"], "en"), "÷");
    const pl = padKey(type(["1", "0", "0"], "pl"), "÷");
    expect(padPreview(padKey(en, "4").expr)).toBe(padPreview(padKey(pl, "4").expr));
    expect(padPreview(padKey(en, "4").expr)).toBe(2500);
  });

  test("negative allocation (allowNegative) is identical in both languages", () => {
    const opts = { allowNegative: true };
    const en = type(["−", "5", "0", ".", "2", "5"], "en", { expr: "", fresh: false }, opts);
    const pl = type(["−", "5", "0", ",", "2", "5"], "pl", { expr: "", fresh: false }, opts);
    expect(en.expr).toBe("-50,25");
    expect(pl.expr).toBe(en.expr);
    expect(padPreview(en.expr)).toBe(-5025);
  });

  test("a fresh EXISTING value: an operator goes relative, a digit replaces — same in both", () => {
    const fresh: PadState = { expr: "1500,50", fresh: true };
    const enRel = type(["+", "9", ".", "5"], "en", fresh);
    const plRel = type(["+", "9", ",", "5"], "pl", fresh);
    expect(enRel.expr).toBe("1500,50+9,5");
    expect(plRel.expr).toBe(enRel.expr);
    expect(padPreview(enRel.expr)).toBe(151000);

    const enNew = type(["7", ".", "5"], "en", fresh);
    const plNew = type(["7", ",", "5"], "pl", fresh);
    expect(enNew.expr).toBe("7,5");
    expect(plNew.expr).toBe(enNew.expr);
  });
});

/**
 * Source gate: the decimal key exists ONCE. A screen re-declaring its own key array would look
 * fine in its own tests and quietly ship a "," to English users (or, worse, a "." to `padKey`).
 */
describe("one key definition, one renderer", () => {
  const SRC = new URL("../", import.meta.url).pathname; // packages/web/src
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (name.endsWith(".ts") || name.endsWith(".tsx")) acc.push(p);
    }
    return acc;
  };
  /** Its home, the ONE renderer, and this gate. */
  const ALLOWED = new Set(["lib/numpad.ts", "components/pickers.tsx", "lib/numpad.test.ts"]);

  test("NUMPAD_KEYS is named only by its home, the Numpad renderer and this gate", () => {
    const offenders = walk(SRC)
      .filter((p) => readFileSync(p, "utf8").includes("NUMPAD_KEYS"))
      .map((p) => p.slice(SRC.length))
      .filter((rel) => !ALLOWED.has(rel));
    expect(offenders).toEqual([]);
  });

  test("the allowlist stays honest (files exist and really do name the symbol)", () => {
    for (const rel of ALLOWED) {
      expect(statSync(join(SRC, rel)).isFile()).toBe(true);
      expect(readFileSync(join(SRC, rel), "utf8").includes("NUMPAD_KEYS")).toBe(true);
    }
  });

  test("`Numpad` is imported from exactly one module", () => {
    const homes = walk(SRC)
      .map((p) => p.slice(SRC.length))
      .filter((rel) => rel !== "lib/numpad.test.ts") // this gate names the pattern it looks for
      .filter((rel) => /export function Numpad\b/.test(readFileSync(join(SRC, rel), "utf8")));
    expect(homes).toEqual(["components/pickers.tsx"]);
  });
});

describe("switching language mid-edit changes presentation only", () => {
  test("canonical state and committed minor units are untouched; only the rendering moves", () => {
    const state = type(["1", "2", ".", "5", "0", "+", "2", ".", "7", "0"], "en");
    const before = { ...state };

    expect(localizePadExpression(state.expr, "en")).toBe("12.50+2.70");
    expect(localizePadExpression(state.expr, "pl")).toBe("12,50+2,70");
    expect(numpadKeyLabel(",", "en")).not.toBe(numpadKeyLabel(",", "pl"));

    // nothing about the state depends on the language it is rendered in
    expect(state).toEqual(before);
    expect(state.expr).toBe("12,50+2,70");
    expect(padPreview(state.expr)).toBe(1520);
  });

  test("continuing to type AFTER the switch keeps one canonical expression", () => {
    const typedInEnglish = type(["8", ".", "2"], "en");
    const continuedInPolish = type(["5"], "pl", typedInEnglish);
    expect(continuedInPolish.expr).toBe("8,25");
    expect(padPreview(continuedInPolish.expr)).toBe(825);
  });
});
