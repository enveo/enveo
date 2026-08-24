import { useEffect, useRef, useState } from "react";
import { fmtSignedTrim } from "../lib/amount";
import { useTheme } from "../lib/contexts";
import { localizePadExpression, parseAmount } from "../lib/format";
import { useT } from "../lib/i18n";
import { useWideHost } from "../lib/shellContext";
import { font } from "../lib/theme";
import { AmountPadHost, type AmountPadTarget } from "./AmountPadSheet";

/**
 * PR6b Task 5 — the shared desktop-input-or-pad amount field (pr6b-context.md ground truth #9,
 * the `AllocCell` desktop pattern from Budget.tsx:454, copied verbatim for a plain FORM FIELD
 * instead of a tap-to-edit table cell): `useWideHost()?.mode === "desktop"` renders a real
 * `<input inputMode="decimal">`; every other host (fold, phone, no host at all) keeps today's
 * readOnly `localizePadExpression` display that opens `AmountPadHost` on click/focus — byte-
 * identical to what every pad-trigger field in the app already does.
 *
 * `value`/`onCommit` stay on the CANONICAL `fmtSignedTrim` string, never a raw minor number:
 * this is exactly the shape the callers already hold (Accounts.tsx's `bl`), so adopting the
 * field costs the caller nothing beyond swapping its own input markup for this component. An
 * empty string is a valid value (unset — every caller already treats `parseAmount("") ?? 0` as
 * the empty-balance default; this field preserves that instead of forcing a "0" prefill).
 */
export function AmountField({
  value,
  onCommit,
  label,
  placeholder,
  allowNegative = false,
}: {
  /** Canonical `fmtSignedTrim` text — "" is a valid, unset value. */
  value: string;
  /** Called with a NEW canonical `fmtSignedTrim` string on a valid commit (pad ✓, or the desktop
   *  input's Enter/blur) — never with raw/partial text. */
  onCommit: (raw: string) => void;
  /** Pad title AND the desktop input's `aria-label`. */
  label: string;
  placeholder?: string;
  /** Account balances (credit cards) may be negative; most other amounts may not. */
  allowNegative?: boolean;
}) {
  const C = useTheme();
  const { lang } = useT();
  const desktop = useWideHost()?.mode === "desktop";
  const [pad, setPad] = useState<AmountPadTarget | null>(null);
  const [input, setInput] = useState(value);
  const [err, setErr] = useState(false);
  // Guards a same-tick `blur` a value-revert can raise from reaching `onBlur`'s commit path —
  // the exact `cancelingRef` AllocCell uses (Budget.tsx): Escape sets it, `onBlur` checks and
  // clears it instead of committing the value Escape just discarded.
  const cancelingRef = useRef(false);

  // Resync the desktop draft whenever the COMMITTED value changes from OUTSIDE this field (a
  // fresh "New account" open, an account switch) — never mid-edit on the same committed value,
  // since a successful commit round-trips back through this same string.
  useEffect(() => {
    setInput(value);
    setErr(false);
  }, [value]);

  if (desktop) {
    return (
      <input
        inputMode="decimal"
        aria-label={label}
        aria-invalid={err || undefined}
        value={input}
        placeholder={placeholder}
        onChange={(ev) => {
          setInput(ev.target.value);
          setErr(false);
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") {
            ev.currentTarget.blur();
          } else if (ev.key === "Escape") {
            // Load-bearing: inside a pane surface the keydown would otherwise bubble to
            // WideShell's document-level Escape handler and close the whole surface out from
            // under this field. AllocCell never needed this — it lives in the primary pane,
            // where `panelContains` is already false.
            ev.stopPropagation();
            cancelingRef.current = true;
            setInput(value);
            setErr(false);
          }
        }}
        onBlur={() => {
          if (cancelingRef.current) {
            cancelingRef.current = false;
            return;
          }
          const trimmed = input.trim();
          if (trimmed === "") {
            setErr(false);
            onCommit("");
            return;
          }
          const minor = parseAmount(input);
          if (minor === null || (minor < 0 && !allowNegative)) {
            setErr(true);
            return;
          }
          onCommit(fmtSignedTrim(minor));
        }}
        style={{
          width: "100%",
          padding: "10px 12px",
          borderRadius: 9,
          border: `1px solid ${err ? "var(--danger)" : C.line}`,
          background: C.bg,
          color: err ? "var(--danger)" : C.text,
          fontSize: 14,
          fontFamily: font,
          fontVariantNumeric: "tabular-nums",
          boxSizing: "border-box",
          outline: "none",
        }}
      />
    );
  }

  const openPad = () => setPad({ label, initial: parseAmount(value) ?? 0, allowNegative, onCommit: (minor) => onCommit(fmtSignedTrim(minor)) });

  return (
    <>
      <input
        // `value` stays CANONICAL (fmtSignedTrim) — display only is localized, matching every
        // other pad-trigger field in the app.
        value={localizePadExpression(value, lang)}
        readOnly
        placeholder={placeholder}
        onClick={openPad}
        onFocus={openPad}
        style={{
          width: "100%",
          padding: "10px 12px",
          borderRadius: 9,
          border: `1px solid ${C.line}`,
          background: C.bg,
          color: C.text,
          fontSize: 14,
          fontFamily: font,
          boxSizing: "border-box",
          cursor: "pointer",
        }}
      />
      <AmountPadHost target={pad} onClose={() => setPad(null)} />
    </>
  );
}
