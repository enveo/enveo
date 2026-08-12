import { describe, expect, test } from "bun:test";
import { applyAmountKey, hasOpenOp, padKey, padPreview, padPreviewLive, type PadState } from "./amount";
import { evalExpression } from "./format";

describe("applyAmountKey", () => {
  test("leading zero disappears", () => {
    expect(applyAmountKey("", "4")).toBe("4");
    expect(applyAmountKey("0", "4")).toBe("4");
  });

  test("single zero OK", () => {
    expect(applyAmountKey("0", "0")).toBe("0");
    expect(applyAmountKey("", "0")).toBe("0");
  });

  test("comma", () => {
    expect(applyAmountKey("0", ",")).toBe("0,");
    expect(applyAmountKey("47", ",")).toBe("47,");
  });

  test("second comma ignored", () => {
    expect(applyAmountKey("47,", ",")).toBe("47,");
  });

  test("max 2 decimal places", () => {
    expect(applyAmountKey("47,3", "0")).toBe("47,30");
    expect(applyAmountKey("47,30", "5")).toBe("47,30");
  });

  test("backspace", () => {
    expect(applyAmountKey("47", "⌫")).toBe("4");
    expect(applyAmountKey("4", "⌫")).toBe("");
    expect(applyAmountKey("", "⌫")).toBe("");
  });

  test("expressions: normalization only in the segment after the last operator", () => {
    expect(applyAmountKey("12+0", "5")).toBe("12+5");
    expect(applyAmountKey("12+0", "0")).toBe("12+0");
    expect(applyAmountKey("12+3,", ",")).toBe("12+3,");
    expect(applyAmountKey("12+3,45", "9")).toBe("12+3,45");
  });
});

describe("padKey — the amount numpad engine (matrix from the spec)", () => {
  test("fresh + digit: replaces the value (entry from scratch)", () => {
    expect(padKey({ expr: "200", fresh: true }, "4").expr).toBe("4");
  });

  test("fresh + operator: relative mode from the current value", () => {
    expect(padKey({ expr: "200", fresh: true }, "+").expr).toBe("200+");
  });

  test("REDUCTION on an operator: A⊕B → result⊕", () => {
    expect(padKey({ expr: "50+24", fresh: false }, "+").expr).toBe("74+");
    expect(padKey({ expr: "74+12", fresh: false }, "+").expr).toBe("86+");
  });

  test("reduction also works for − and × (Numpad characters)", () => {
    expect(padKey({ expr: "50−24", fresh: false }, "−").expr).toBe("26−");
    expect(padKey({ expr: "50×3", fresh: false }, "+").expr).toBe("150+");
  });

  test("an operator at A⊕ swaps the operation sign", () => {
    expect(padKey({ expr: "50+", fresh: false }, "×").expr).toBe("50×");
  });

  test("negative intermediate state after a reduction", () => {
    expect(padKey({ expr: "200-500", fresh: false }, "+").expr).toBe("-300+");
  });

  test("⌫ deletes a trailing operator (A⊕ → A)", () => {
    expect(padKey({ expr: "74+", fresh: false }, "⌫").expr).toBe("74");
  });

  test("⌫ within a segment (applyAmountKey)", () => {
    expect(padKey({ expr: "74+12", fresh: false }, "⌫").expr).toBe("74+1");
  });

  test("comma within a segment via applyAmountKey", () => {
    expect(padKey({ expr: "47", fresh: false }, ",").expr).toBe("47,");
  });

  test("fresh + comma = a new entry from scratch", () => {
    expect(padKey({ expr: "200", fresh: true }, ",").expr).toBe("0,");
  });

  test("fresh + ⌫ clears the line (entry from scratch)", () => {
    expect(padKey({ expr: "200", fresh: true }, "⌫").expr).toBe("");
  });

  test("fresh goes off after every key", () => {
    expect(padKey({ expr: "200", fresh: true }, "4").fresh).toBe(false);
    expect(padKey({ expr: "200", fresh: true }, "+").fresh).toBe(false);
    expect(padKey({ expr: "200", fresh: true }, ",").fresh).toBe(false);
  });

  test("the segment after a reduction is normally editable", () => {
    expect(padKey({ expr: "74+", fresh: false }, "1").expr).toBe("74+1");
    expect(padKey({ expr: "74+1", fresh: false }, "2").expr).toBe("74+12");
  });

  test("÷ behaves exactly like + − × (first-class operator)", () => {
    // (a) fresh + ÷: relative mode from the current value, same as + and ×
    expect(padKey({ expr: "705", fresh: true }, "÷")).toEqual({ expr: "705÷", fresh: false });

    // (b) mid-expression: A⊕B + ÷ → reduces then appends ("15+25" → "40÷")
    expect(padKey({ expr: "15+25", fresh: false }, "÷").expr).toBe("40÷");

    // reduction also works when ÷ is the operator already open (A÷B → result÷)
    expect(padKey({ expr: "50÷2", fresh: false }, "÷").expr).toBe("25÷");

    // an operator at A÷ swaps the operation sign, and swapping INTO ÷ works too
    expect(padKey({ expr: "50+", fresh: false }, "÷").expr).toBe("50÷");
    expect(padKey({ expr: "50÷", fresh: false }, "×").expr).toBe("50×");

    // ⌫ deletes a trailing ÷ operator (A÷ → A)
    expect(padKey({ expr: "74÷", fresh: false }, "⌫").expr).toBe("74");

    // the segment after a ÷ reduction is normally editable
    expect(padKey({ expr: "74÷", fresh: false }, "1").expr).toBe("74÷1");
  });
});

describe("padKey — allocation pad negative-literal entry (allowNegative option)", () => {
  test("'−' on a fresh expression starts a negative literal, not the binary operator", () => {
    expect(padKey({ expr: "0", fresh: true }, "−", { allowNegative: true })).toEqual({ expr: "-", fresh: false });
  });

  test("digits after the negative sign build up the literal", () => {
    let s = padKey({ expr: "0", fresh: true }, "−", { allowNegative: true });
    for (const d of ["5", "0", "0", "0"]) s = padKey(s, d, { allowNegative: true });
    expect(s.expr).toBe("-5000");
  });

  test("'−' on an empty (non-fresh) expression also starts a negative literal", () => {
    expect(padKey({ expr: "", fresh: false }, "−", { allowNegative: true })).toEqual({ expr: "-", fresh: false });
  });

  test("mid-expression, '−' STILL means the binary operator (append, not restart)", () => {
    expect(padKey({ expr: "500", fresh: false }, "−", { allowNegative: true }).expr).toBe("500−");
    expect(padKey({ expr: "-5000", fresh: false }, "−", { allowNegative: true }).expr).toBe("-5000−");
  });

  test("without the option (e.g. the Add screen), '−' stays the RELATIVE binary operator — unweakened", () => {
    expect(padKey({ expr: "200", fresh: true }, "−").expr).toBe("200−");
    expect(padKey({ expr: "", fresh: false }, "−").expr).toBe("0−");
  });

  test("padPreview/padPreviewLive compute the negative minor value", () => {
    expect(padPreview("-5000")).toBe(-500000);
    expect(padPreviewLive("-5000")).toBe(-500000);
    expect(padPreviewLive("-5000−")).toBe(-500000); // hanging operator still shows the computable part
  });
});

describe("padKey — regression: '−' must not wipe an already-allocated fresh value (allowNegative)", () => {
  // Budget.tsx startEdit opens the pad with { expr: fmtSignedTrim(env.allocated), fresh: true } — fresh is
  // true even when the envelope ALREADY has money in it. Pressing "−" there must go into RELATIVE mode
  // (take money OUT of the existing allocation), not restart the line as an absolute negative literal.
  test("(a) '−' on a fresh NON-ZERO/NON-EMPTY expression stays in relative mode (the regression)", () => {
    let s: PadState = { expr: "50", fresh: true };
    s = padKey(s, "−", { allowNegative: true });
    expect(s).toEqual({ expr: "50−", fresh: false }); // NOT { expr: "-", fresh: false }
    s = padKey(s, "1", { allowNegative: true });
    s = padKey(s, "0", { allowNegative: true });
    expect(s.expr).toBe("50−10");
    expect(padPreview(s.expr)).toBe(4000); // 50 allocated, 10 taken out → 40.00 available
  });

  test("(b) '−' on a fresh ZERO expression still starts a negative literal (intended, unchanged)", () => {
    let s: PadState = { expr: "0", fresh: true };
    s = padKey(s, "−", { allowNegative: true });
    expect(s).toEqual({ expr: "-", fresh: false });
    for (const d of ["1", "0", "0", "0"]) s = padKey(s, d, { allowNegative: true });
    expect(s.expr).toBe("-1000");
    expect(padPreview(s.expr)).toBe(-100000); // -1000.00
  });

  test("(c) '−' on a fresh EMPTY expression starts a negative literal", () => {
    expect(padKey({ expr: "", fresh: true }, "−", { allowNegative: true })).toEqual({ expr: "-", fresh: false });
  });
});

describe('padKey "=" — explicit expression reduction', () => {
  test("A⊕B → result without an operator", () => {
    expect(padKey({ expr: "10+10", fresh: false }, "=")).toEqual({ expr: "20", fresh: false });
  });

  test("negative reduction result", () => {
    expect(padKey({ expr: "200-500", fresh: false }, "=").expr).toBe("-300");
  });

  test("a bare number (A) → no-op", () => {
    expect(padKey({ expr: "74", fresh: false }, "=").expr).toBe("74");
  });

  test("an open operator (A⊕) → no-op", () => {
    expect(padKey({ expr: "74+", fresh: false }, "=").expr).toBe("74+");
  });

  test("a no-op does not clear fresh", () => {
    expect(padKey({ expr: "200", fresh: true }, "=").fresh).toBe(true);
    expect(padKey({ expr: "200", fresh: true }, "=").expr).toBe("200");
  });
});

describe("hasOpenOp — the A⊕B state (a full operation ready to compute)", () => {
  test("a full operation → true", () => {
    expect(hasOpenOp("74+12")).toBe(true);
    expect(hasOpenOp("10+10")).toBe(true);
    expect(hasOpenOp("50×3")).toBe(true);
  });

  test("an open operator (A⊕) → false", () => {
    expect(hasOpenOp("74+")).toBe(false);
  });

  test("a bare number → false", () => {
    expect(hasOpenOp("74")).toBe(false);
  });

  test("a leading minus is a number sign, not an operator", () => {
    expect(hasOpenOp("-300")).toBe(false);
    expect(hasOpenOp("-300+5")).toBe(true);
  });

  test("empty string → false", () => {
    expect(hasOpenOp("")).toBe(false);
  });

  test("÷ is recognized as an operator, same as + − ×", () => {
    expect(hasOpenOp("40÷4")).toBe(true);
    expect(hasOpenOp("40÷")).toBe(false);
  });
});

describe("padPreview", () => {
  test("a full operation → minor units; an open operator → null; a bare number → minor units", () => {
    expect(padPreview("74+12")).toBe(8600);
    expect(padPreview("74+")).toBe(null);
    expect(padPreview("74")).toBe(7400);
  });

  test("empty string → null", () => {
    expect(padPreview("")).toBe(null);
  });

  test("÷: (c) a full division → minor units; (d) a trailing ÷ → null (unfinished value)", () => {
    expect(padPreview("40÷4")).toBe(1000); // 10.00 in minor units, same rounding as ×
    expect(padPreview("40÷")).toBe(null);
  });
});

describe("evalExpression — split sum regression", () => {
  test("leading zeros do not zero the amount (strict-mode octal → SyntaxError → null)", () => {
    expect(evalExpression("047,30")).toBe(4730);
    expect(evalExpression("07")).toBe(700);
    expect(evalExpression("00,50")).toBe(50);
    expect(evalExpression("1+047,30")).toBe(4830);
  });

  test("regular amounts unchanged", () => {
    expect(evalExpression("47,30")).toBe(4730);
    expect(evalExpression("0,50")).toBe(50);
    expect(evalExpression("0")).toBe(0);
    expect(evalExpression("10+2,5")).toBe(1250);
  });
});

describe("evalExpression — an eval-free evaluator (CSP-safe)", () => {
  const eq = (expr: string, gr: number | null) => expect(evalExpression(expr)).toBe(gr);
  test("basic operations and precedence", () => {
    eq("50+24", 7400);
    eq("50−24", 2600);
    eq("74+12", 8600);
    eq("2×50", 10000);
    eq("10+2×50", 11000); // × before +
    eq("100÷4", 2500);
    eq("100÷0", null); // division by zero → null
    eq("200-500", -30000); // negative result
    eq("1000×1000", 100000000); // large
  });
  test("decimal comma and mixed operators", () => {
    eq("12,50", 1250);
    eq("47,30+2,70", 5000);
    eq("3×2,5", 750);
  });
  test("no eval — a malicious string returns null or an amount, never executes code", () => {
    eq("alert(1)", null); // non-arithmetic → parseAmount → null
    expect(evalExpression("1;2")).toBe(100); // parseAmount fallback (safe: takes the leading number, ZERO code execution)
  });
});

describe("padPreviewLive — preview despite a hanging operator (the Available chip does not blank out)", () => {
  test("a hanging operator computes the computable part", () => {
    expect(padPreviewLive("705+")).toBe(70500);
    expect(padPreviewLive("705−")).toBe(70500);
    expect(padPreviewLive("705+5")).toBe(71000);
    expect(padPreviewLive("705")).toBe(70500);
  });
  test("null only for an empty expression", () => {
    expect(padPreviewLive("")).toBe(null);
    expect(padPreviewLive("+")).toBe(null);
  });

  test("÷: (d) a trailing ÷ computes the computable part, same as + − ×", () => {
    expect(padPreviewLive("40÷")).toBe(4000);
    expect(padPreviewLive("40÷4")).toBe(1000);
  });
});
