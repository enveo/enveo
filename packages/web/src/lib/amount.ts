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
    if (seg.includes(",")) return amount;
    return head + (seg === "" ? "0," : seg + ",");
  }

  const commaIdx = seg.indexOf(",");
  if (commaIdx >= 0 && seg.length - commaIdx - 1 >= 2) return amount;
  if (seg === "0") {
    if (key === "0") return amount;
    return head + key;
  }
  return head + seg + key;
}

export type PadState = { expr: string; fresh: boolean };

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

export type PadKeyOpts = { allowNegative?: boolean };

export function padKey(state: PadState, k: string, opts?: PadKeyOpts): PadState {
  const isOp = PAD_OP_KEYS.includes(k);

  if (k === "=") {
    if (!hasOpenOp(state.expr)) return state;
    const minor = evalExpression(state.expr);
    if (minor === null) return state;
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
    if (isOp) return { expr: state.expr + k, fresh: false };

    if (k === "⌫") return { expr: applyAmountKey(state.expr, k), fresh: false };

    return { expr: applyAmountKey("", k), fresh: false };
  }

  if (isOp) {
    const expr = state.expr || "0";
    const opIdx = padOperatorIndex(expr);
    if (opIdx === expr.length - 1) return { expr: expr.slice(0, -1) + k, fresh: false };
    if (opIdx >= 0) {
      const minor = evalExpression(expr);
      if (minor === null) return state;
      return { expr: fmtSignedTrim(minor) + k, fresh: false };
    }
    return { expr: expr + k, fresh: false };
  }

  return { expr: applyAmountKey(state.expr, k), fresh: false };
}

export function keyboardPadKey(key: string): string | null {
  if (/^[0-9]$/.test(key)) return key;
  if (key === "," || key === ".") return ",";
  if (key === "Backspace") return "⌫";
  if (key === "+") return "+";
  if (key === "-" || key === "−") return "−";
  if (key === "*" || key === "×") return "×";
  if (key === "/" || key === "÷") return "÷";
  return null;
}

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
