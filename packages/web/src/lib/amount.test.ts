import { describe, expect, test } from "bun:test";
import { applyAmountKey, fmtSignedTrim, hasOpenOp, keyboardPadKey, type PadState, padKey, padPreview, padPreviewLive } from "./amount";
import { evalExpression, evalExpressionLive, fmtTrim, parseAmount } from "./format";

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

  test("fresh + ⌫ deletes one character instead of clearing the current amount", () => {
    const first = padKey({ expr: "200", fresh: true }, "⌫");
    expect(first).toEqual({ expr: "20", fresh: false });
    expect(padKey(first, "⌫")).toEqual({ expr: "2", fresh: false });
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

describe("desktop allocation input prefill (Budget.tsx AllocCell, PR6 Task 3b + item 27)", () => {
  // The desktop <input>'s prefill contract: startEdit fills it with fmtSignedTrim(env.allocated)
  // and commit re-reads it — since item 27 through `evalExpression` (which falls back to
  // parseAmount for a plain number, so both are pinned) — and the round-trip must return the
  // EXACT current allocation, sign included. Two consequences this pins:
  //  - "negative prefill keeps its sign": a bare fmtTrim (fmt() takes Math.abs) would prefill a
  //    -50,00 allocation as "50", and an untouched blur would then silently flip the sign — the
  //    reviewed data-corruption finding.
  //  - "an untouched blur writes nothing": persistAllocation only writes when the parsed value
  //    differs from the fresh env.allocated, so an exact round-trip IS the no-op guarantee.
  // Enter-commits / Escape-reverts are DOM wiring (verified in the running app — no DOM test
  // rig in this suite); the parsing contract they both feed is what lives here.
  const roundTrip = (minor: number) => evalExpression(fmtSignedTrim(minor));

  test("negative prefill keeps its sign through the commit round-trip", () => {
    expect(fmtSignedTrim(-5000)).toBe("-50");
    expect(roundTrip(-5000)).toBe(-5000);
    expect(parseAmount(fmtSignedTrim(-5000))).toBe(-5000); // the eval fallback parser agrees
    // the unsigned helper is exactly the bug this guards against:
    expect(evalExpression(fmtTrim(-5000))).toBe(5000);
  });

  test("round-trip is exact across signs, cents and thousand-space grouping", () => {
    for (const minor of [0, 1, -1, 99, -99, 100, -100, 1250, -1250, 5000, -5000, 123456, -123456, 100000000, -100000000, 123456789, -123456789]) {
      expect(roundTrip(minor)).toBe(minor);
      expect(parseAmount(fmtSignedTrim(minor))).toBe(minor);
    }
  });
});

describe("keyboardPadKey — physical-keyboard key → canonical pad key (owner round 5 item 26)", () => {
  test("digits map to themselves", () => {
    for (const d of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) expect(keyboardPadKey(d)).toBe(d);
  });

  test('both "," and "." map to the canonical comma, regardless of the pad glyph', () => {
    expect(keyboardPadKey(",")).toBe(",");
    expect(keyboardPadKey(".")).toBe(",");
  });

  test("Backspace maps to the pad's ⌫", () => {
    expect(keyboardPadKey("Backspace")).toBe("⌫");
  });

  test("ASCII operators map to the pad's − × ÷ (Unicode forms accepted too)", () => {
    expect(keyboardPadKey("+")).toBe("+");
    expect(keyboardPadKey("-")).toBe("−");
    expect(keyboardPadKey("−")).toBe("−");
    expect(keyboardPadKey("*")).toBe("×");
    expect(keyboardPadKey("×")).toBe("×");
    expect(keyboardPadKey("/")).toBe("÷");
    expect(keyboardPadKey("÷")).toBe("÷");
  });

  test("actions and everything else are NOT pad keys (null — the caller decides)", () => {
    for (const k of ["Enter", "Escape", "=", " ", "a", "e", "x", "F1", "ArrowLeft", "Tab", "Delete", "12", "00"]) {
      expect(keyboardPadKey(k)).toBe(null);
    }
  });
});

describe("keyboard-driven padKey sequences (the Add pane's wide keyboard, item 26)", () => {
  // The document keydown handler does exactly this: map with keyboardPadKey, feed padKey —
  // ONE state machine with the on-screen pad, so the pad's whole matrix applies verbatim.
  // These sequences replay the HISTORICAL TRAPS with keyboard-shaped input on top.
  const type = (state: PadState, keys: string[]): PadState =>
    keys.reduce((s, key) => {
      const k = keyboardPadKey(key);
      return k === null ? s : padKey(s, k);
    }, state);

  test("plain amount end-to-end: 12.50 → 12,50 → 1250 minor", () => {
    const s = type({ expr: "", fresh: true }, ["1", "2", ".", "5", "0"]);
    expect(s.expr).toBe("12,50");
    expect(padPreview(s.expr)).toBe(1250);
  });

  test("TRAP 15000 → − → 5000: ASCII '-' on a fresh value is RELATIVE mode, not a wipe", () => {
    let s: PadState = { expr: "15000", fresh: true };
    s = type(s, ["-", "5", "0", "0", "0"]);
    expect(s.expr).toBe("15000−5000"); // NOT "-5000"
    // ⏎ with an open A⊕B reduces first (the confirm's hasOpenOp branch) — the "=" pad key:
    expect(hasOpenOp(s.expr)).toBe(true);
    s = padKey(s, "=");
    expect(s.expr).toBe("10 000"); // fmtSignedTrim's thousand-space grouping — the pad's reduced format
    expect(padPreview(s.expr)).toBe(1000000);
  });

  test("TRAP ⌫ on fresh: Backspace deletes exactly ONE character, never restarts from empty", () => {
    let s: PadState = { expr: "150", fresh: true };
    s = type(s, ["Backspace"]);
    expect(s).toEqual({ expr: "15", fresh: false });
    s = type(s, ["Backspace", "Backspace", "Backspace"]);
    expect(s.expr).toBe(""); // and no further than empty
  });

  test("TRAP leading zeros: typed 047.30 normalizes per segment, never an octal-shaped literal", () => {
    const s = type({ expr: "", fresh: true }, ["0", "4", "7", ".", "3", "0"]);
    expect(s.expr).toBe("47,30");
    expect(padPreview(s.expr)).toBe(4730);
  });

  test("keyboard '*' and '/' drive the pad's × and ÷", () => {
    const mult = type({ expr: "", fresh: true }, ["1", "0", "*", "3"]);
    expect(mult.expr).toBe("10×3");
    expect(padPreview(mult.expr)).toBe(3000);
    const div = type({ expr: "", fresh: true }, ["1", "0", "/", "4"]);
    expect(div.expr).toBe("10÷4");
    expect(padPreview(div.expr)).toBe(250);
  });

  test("non-amount keys leave the state untouched (the handler ignores them)", () => {
    const s = type({ expr: "47,3", fresh: false }, ["a", "ArrowLeft", "Tab", " ", "Escape"]);
    expect(s).toEqual({ expr: "47,3", fresh: false });
  });

  test("keyboard comma follows the pad's one-comma / two-decimals rules", () => {
    const s = type({ expr: "", fresh: true }, ["5", ".", "5", ",", "5", "5"]);
    expect(s.expr).toBe("5,55"); // second separator ignored, 3rd decimal ignored
  });
});

describe("desktop Allocated cell arithmetic (owner round 5 item 27 — commit via evalExpression)", () => {
  test("the C1 hint's promised grammar: + − × ÷ (ASCII and glyph forms) evaluate on save", () => {
    expect(evalExpression("500+1")).toBe(50100);
    expect(evalExpression("10×3")).toBe(3000);
    expect(evalExpression("10*3")).toBe(3000);
    expect(evalExpression("5−2")).toBe(300);
    expect(evalExpression("5-2")).toBe(300);
    expect(evalExpression("10÷4")).toBe(250);
    expect(evalExpression("10/4")).toBe(250);
  });

  test("decimal comma AND dot operands, mixed in one expression", () => {
    expect(evalExpression("1,5+2.5")).toBe(400);
    expect(evalExpression("12.50")).toBe(1250);
    expect(evalExpression("0,5*4")).toBe(200);
  });

  test("garbage → null → no write (the cell flags err and keeps editing)", () => {
    expect(evalExpression("abc")).toBe(null);
    expect(evalExpression("500+")).toBe(null); // unfinished operation is uncommittable
    expect(evalExpression("+")).toBe(null);
    expect(evalExpression("1.234,56")).toBe(null); // Intl grouping never enters inputs
    expect(evalExpression("")).toBe(null);
    expect(evalExpression("   ")).toBe(null);
  });

  test("property: every well-formed operand/operator combination evaluates to INTEGER minor units", () => {
    // Deterministic sweep in place of fast-check (a shared-package-only dependency): the full
    // cross product of representative operands (integers, comma/dot decimals, zero, 0-leading)
    // and all four operators, plus three-term chains — evalExpression must return an integer
    // (minor units are integers by construction: Math.round) or null, never a float.
    const operands = ["0", "1", "7", "047", "12,5", "3.25", "1000", "0,01", "999,99"];
    const ops = ["+", "-", "*", "/", "×", "÷", "−"];
    for (const a of operands) {
      for (const op of ops) {
        for (const b of operands) {
          const v = evalExpression(`${a}${op}${b}`);
          if (v !== null) expect(Number.isInteger(v)).toBe(true);
          // null is legal only for division by zero here — every operand is a valid number
          if (v === null) expect((op === "/" || op === "÷") && evalExpression(b) === 0).toBe(true);
        }
      }
    }
    for (const a of operands) {
      for (const b of operands) {
        const v = evalExpression(`${a}+${b}*2`);
        expect(v).not.toBe(null);
        expect(Number.isInteger(v as number)).toBe(true);
      }
    }
  });
});

describe("evalExpressionLive — the desktop cell's hanging-operator preview (item 27)", () => {
  test("a hanging operator previews the computable part (padPreviewLive's rule for free text)", () => {
    expect(evalExpressionLive("500+")).toBe(50000);
    expect(evalExpressionLive("500+1")).toBe(50100);
    expect(evalExpressionLive("10*")).toBe(1000);
    expect(evalExpressionLive("10/")).toBe(1000);
    expect(evalExpressionLive("40÷")).toBe(4000);
  });

  test("null for empty / bare-sign / garbage input", () => {
    expect(evalExpressionLive("")).toBe(null);
    expect(evalExpressionLive("-")).toBe(null);
    expect(evalExpressionLive("abc")).toBe(null);
  });

  test("a finished expression previews its full value (identical to the commit path)", () => {
    expect(evalExpressionLive("1,5+2.5")).toBe(evalExpression("1,5+2.5"));
    expect(evalExpressionLive("-50")).toBe(-5000);
  });
});
