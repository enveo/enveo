import { describe, expect, test } from "bun:test";
import { activeAllocationDecoration, INPUT_FOCUS_CLASS, INPUT_FOCUS_CSS, NAME_UNDERLINE_FOCUS_CLASS, NAME_UNDERLINE_FOCUS_CSS } from "./focusPresentation";

describe("input focus presentation", () => {
  test("moves the focus indicator from the rectangular input to its rounded shell", () => {
    // given: a search input hosted inside the shared focus shell
    const inputRule = `.${INPUT_FOCUS_CLASS}>input:focus-visible{outline:none}`;
    const shellRule = `.${INPUT_FOCUS_CLASS}:has(>input:focus-visible){outline:2px solid var(--input-underline);outline-offset:2px}`;

    // when/then: only a keyboard-focused direct input transfers its visible ring to the shell,
    // and browsers without :has() retain the global input outline instead of losing focus feedback
    expect(INPUT_FOCUS_CSS).toBe(`@supports selector(:has(*)){${inputRule}${shellRule}}`);
    expect(INPUT_FOCUS_CSS).not.toContain(":focus-within");
  });

  test("uses only an underline for the transaction name field", () => {
    expect(NAME_UNDERLINE_FOCUS_CSS).toBe(`.${NAME_UNDERLINE_FOCUS_CLASS}:focus-visible{outline:none;box-shadow:inset 0 -2px 0 var(--input-underline)}`);
    expect(NAME_UNDERLINE_FOCUS_CSS).not.toContain("outline:2px");
  });

  test("keeps the budget allocation chip rounded while drawing its active underline inside", () => {
    // given: the accent used by an actively edited allocation
    const accent = "var(--accent)";

    // when: the active decoration is calculated
    const decoration = activeAllocationDecoration(accent);

    // then: it cannot square the bottom corners or change the chip's measured height
    expect(decoration).toEqual({ borderRadius: 7, boxShadow: `inset 0 -2px 0 ${accent}` });
    expect("borderBottom" in decoration).toBe(false);
  });
});
