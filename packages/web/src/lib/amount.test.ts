import { describe, expect, test } from "bun:test";
import { applyAmountKey, hasOpenOp, padKey, padPreview, padPreviewLive } from "./amount";
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
    eq("50+24", 7400); eq("50−24", 2600); eq("74+12", 8600);
    eq("2×50", 10000); eq("10+2×50", 11000); // × before +
    eq("100÷4", 2500); eq("100÷0", null);     // division by zero → null
    eq("200-500", -30000);                     // negative result
    eq("1000×1000", 100000000);                // large
  });
  test("decimal comma and mixed operators", () => {
    eq("12,50", 1250); eq("47,30+2,70", 5000); eq("3×2,5", 750);
  });
  test("no eval — a malicious string returns null or an amount, never executes code", () => {
    eq("alert(1)", null);            // non-arithmetic → parseAmount → null
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
});
