/**
 * Pure amount-keyboard logic (the numpad on the Add card).
 * Keys: "0".."9" | "," | "⌫". Expression operators (+ − × ÷) are appended by Add.tsx
 * outside this function — zero/comma normalization operates only on the current
 * segment after the last operator, so expressions survive unchanged.
 */
import { evalExpression, fmtTrim } from "./format";

const OPERATORS = ["+", "−", "×", "÷"];

function lastOperatorIndex(s: string): number {
  let idx = -1;
  for (const op of OPERATORS) {
    const i = s.lastIndexOf(op);
    if (i > idx) idx = i;
  }
  return idx;
}

export function applyAmountKey(amount: string, key: string): string {
  if (key === "⌫") return amount.slice(0, -1);

  const opIdx = lastOperatorIndex(amount);
  const head = amount.slice(0, opIdx + 1);
  const seg = amount.slice(opIdx + 1);

  if (key === ",") {
    if (seg.includes(",")) return amount; // a second comma is ignored
    return head + (seg === "" ? "0," : seg + ",");
  }

  // digit
  const commaIdx = seg.indexOf(",");
  if (commaIdx >= 0 && seg.length - commaIdx - 1 >= 2) return amount; // max 2 decimal places
  if (seg === "0") {
    if (key === "0") return amount; // a single zero stays
    return head + key; // the leading zero disappears
  }
  return head + seg + key;
}

/**
 * The AmountPadSheet engine (spec 2026-07-09-amount-pad-design).
 * State = an expression string with AT MOST one open operation:
 * `A`, `A⊕` or `A⊕B` (⊕ ∈ {+,−,×,÷}; A may be negative after a reduction).
 * `fresh` = the line shows the field's current value and hasn't been edited yet.
 */
export type PadState = { expr: string; fresh: boolean };

/** Operator keys emitted by the Numpad in pickers.tsx: +, −, ×, ÷. */
const PAD_OP_KEYS = ["+", "−", "×", "÷"];
/**
 * Characters recognized as an operator INSIDE an expression — additionally ASCII "-",
 * because reducing a negative result writes the evalExpression-style sign ("-300+").
 */
const EXPR_OPS = ["+", "−", "×", "÷", "-"];

/** Position of the operator splitting A⊕B; index 0 is a number sign ("-300"), not an operator. */
function padOperatorIndex(expr: string): number {
  for (let i = expr.length - 1; i >= 1; i--) {
    if (EXPR_OPS.includes(expr[i]!)) return i;
  }
  return -1;
}

/** The result in minor units with a sign, without a trailing ",00" — the format of the line after a reduction and of the pad's initial line. */
export function fmtSignedTrim(minor: number): string {
  return (minor < 0 ? "-" : "") + fmtTrim(minor);
}

/**
 * Is the expression in the A⊕B state (a full operation ready to compute)?
 * A leading minus ("-300") is a number sign, not an operator — see padOperatorIndex.
 */
export function hasOpenOp(expr: string): boolean {
  const opIdx = padOperatorIndex(expr);
  return opIdx >= 0 && opIdx < expr.length - 1;
}

/**
 * Options for `padKey`. `allowNegative` is opt-in and used ONLY by the allocation pad
 * (DockedNumpad on Budget — negative allocations move money back OUT of an envelope).
 * Every other caller (the Add screen's amount, AmountPadSheet defaults) omits it, so
 * "−" keeps its original binary-operator-only meaning there.
 */
export type PadKeyOpts = { allowNegative?: boolean };

/** One pad key (digit | "," | "⌫" | "+" | "−" | "×" | "=") → new state. Pure function. */
export function padKey(state: PadState, k: string, opts?: PadKeyOpts): PadState {
  const isOp = PAD_OP_KEYS.includes(k);

  if (k === "=") {
    // Explicit REDUCTION without appending an operator: A⊕B → result; A / A⊕ → no-op (fresh untouched).
    if (!hasOpenOp(state.expr)) return state;
    const minor = evalExpression(state.expr);
    if (minor === null) return state; // unparsable — as with an operator, we ignore
    return { expr: fmtSignedTrim(minor), fresh: false };
  }

  // allowNegative ONLY: "−" on a genuinely EMPTY/ZERO expression starts a negative literal
  // ("-" then digits → "-5000") instead of the binary "current−" operator — lets the
  // allocation pad move money OUT of an envelope. Gated on the EXPRESSION being empty/zero,
  // NOT on `fresh` alone: startEdit opens the pad with `{ expr: fmtSignedTrim(env.allocated),
  // fresh: true }`, so `fresh` is true even when the envelope already holds an allocation —
  // in that case "−" must fall through to relative mode below ("50" → "50−"), not wipe the
  // existing value into an absolute literal.
  if (opts?.allowNegative && k === "−" && (state.expr === "" || state.expr === "0")) {
    return { expr: "-", fresh: false };
  }

  if (state.fresh) {
    // operator while fresh → RELATIVE mode: current value + operator ("200" → "200+")
    if (isOp) return { expr: state.expr + k, fresh: false };
    // Backspace always removes exactly one character, including from the field's fresh value.
    if (k === "⌫") return { expr: applyAmountKey(state.expr, k), fresh: false };
    // digit/comma while fresh → REPLACES the value (entry from scratch)
    return { expr: applyAmountKey("", k), fresh: false };
  }

  if (isOp) {
    const expr = state.expr || "0";
    const opIdx = padOperatorIndex(expr);
    if (opIdx === expr.length - 1) return { expr: expr.slice(0, -1) + k, fresh: false }; // A⊕ → operator swap
    if (opIdx >= 0) {
      // REDUCTION: A⊕B → result⊕ ("50+24" + "+" → "74+")
      const minor = evalExpression(expr);
      if (minor === null) return state; // unparsable — the operator is ignored
      return { expr: fmtSignedTrim(minor) + k, fresh: false };
    }
    return { expr: expr + k, fresh: false }; // A → A⊕
  }

  // digits/comma/⌫ within the current segment (leading zeros, one comma, 2 decimal places)
  return { expr: applyAmountKey(state.expr, k), fresh: false };
}

/** The expression result in minor units; null when the operation is open (trailing operator) or unparsable. */
export function padPreview(expr: string): number | null {
  if (!expr) return null;
  if (EXPR_OPS.includes(expr[expr.length - 1]!)) return null;
  return evalExpression(expr);
}

/**
 * "Live" preview: a hanging operator ("705+") does NOT zero the result — it computes
 * the computable part (705). For live UI context (the Available chip, TBB); commit still
 * goes through padPreview (there a hanging operator = an unfinished value).
 */
export function padPreviewLive(expr: string): number | null {
  if (!expr) return null;
  const t = EXPR_OPS.includes(expr[expr.length - 1]!) ? expr.slice(0, -1) : expr;
  if (!t) return null;
  return evalExpression(t);
}
