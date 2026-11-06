import type React from "react";
import { useEffect, useRef, useState } from "react";
import { fmtSignedTrim } from "../lib/amount";
import { useCurrency, useTheme } from "../lib/contexts";
import { evalExpression, formatMoney, localizePadExpression, parseAmount } from "../lib/format";
import { useT } from "../lib/i18n";
import { useWideHost } from "../lib/shellContext";
import { font } from "../lib/theme";
import { AmountPadHost, type AmountPadTarget, useDockedPadLine } from "./AmountPadSheet";

const inlineFigureStyle = (underline: string, color: string): React.CSSProperties => ({
  width: 120,
  maxWidth: "50%",
  padding: "1px 0 2px",
  border: "none",
  borderBottom: `1px dotted ${underline}`,
  borderRadius: 0,
  background: "transparent",
  color,
  textAlign: "right",
  fontSize: 13,
  fontWeight: 650,
  fontVariantNumeric: "tabular-nums",
  boxSizing: "border-box",
  outline: "none",
});

export function AmountField({
  value,
  onCommit,
  label,
  placeholder,
  allowNegative = false,
  externalPad,
  inline = false,
}: {
  value: string;
  /** Called with a NEW canonical `fmtSignedTrim` string on a valid commit (pad ✓, or the desktop
   *  input's Enter/blur) — never with raw/partial text. */
  onCommit: (raw: string) => void;

  label: string;
  placeholder?: string;
  /** Account balances (credit cards) may be negative; most other amounts may not. */
  allowNegative?: boolean;

  externalPad?: readonly [AmountPadTarget | null, (target: AmountPadTarget | null) => void];

  inline?: boolean;
}) {
  const C = useTheme();
  const { lang } = useT();
  const currency = useCurrency();
  const desktop = useWideHost()?.mode === "desktop";
  const [internalPad, setInternalPad] = useState<AmountPadTarget | null>(null);
  const [pad, setPad] = externalPad ?? [internalPad, setInternalPad];
  const [input, setInput] = useState(value);
  const [err, setErr] = useState(false);
  const [focused, setFocused] = useState(false);
  const openedRef = useRef<AmountPadTarget | null>(null);
  const docked = useDockedPadLine(openedRef.current);

  const cancelingRef = useRef(false);

  // Desktop types into the field: a pad session left open from a narrower layout must not commit later.
  useEffect(() => {
    if (desktop) setPad(null);
  }, [desktop, setPad]);

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
        // At rest the inline figure reads as money, like the pad layouts' display; editing shows the raw draft.
        value={inline && !focused && !err && parseAmount(input) !== null ? formatMoney(parseAmount(input)!, currency, lang) : input}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
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
          setFocused(false);
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
          const minor = evalExpression(input);
          if (minor === null || (minor < 0 && !allowNegative)) {
            setErr(true);
            return;
          }
          // Canonical even when the committed value is unchanged (then `value` does not resync
          // the draft): "50+50" over 100 must read 100, not the expression's leading 50.
          setInput(fmtSignedTrim(minor));
          onCommit(fmtSignedTrim(minor));
        }}
        style={
          inline
            ? {
                ...inlineFigureStyle(C.mute, err ? "var(--danger)" : C.text),
                fontFamily: font,
                // The active-field look of every desktop amount input (PadInput): accent ring, card fill.
                ...(focused || err
                  ? {
                      background: "var(--card)",
                      borderBottom: "none",
                      borderRadius: 6,
                      padding: "1px 6px 2px",
                      outline: `2px solid ${err ? "var(--danger)" : "var(--accent)"}`,
                      outlineOffset: 3,
                    }
                  : null),
              }
            : {
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
              }
        }
      />
    );
  }

  const openPad = (ev: React.SyntheticEvent<HTMLInputElement>) => {
    const target: AmountPadTarget = {
      label,
      initial: parseAmount(value) ?? 0,
      allowNegative,
      onCommit: (minor) => onCommit(fmtSignedTrim(minor)),
      field: ev.currentTarget,
    };
    openedRef.current = target;
    setPad(target);
  };

  return (
    <>
      <input
        value={
          docked !== null
            ? localizePadExpression(docked, lang) || "0"
            : inline && parseAmount(value) !== null
              ? formatMoney(parseAmount(value)!, currency, lang)
              : localizePadExpression(value, lang)
        }
        data-pad-active={docked !== null ? "" : undefined}
        readOnly
        placeholder={placeholder}
        onClick={openPad}
        onFocus={openPad}
        style={
          inline
            ? {
                ...inlineFigureStyle(C.mute, C.text),
                fontFamily: font,
                cursor: "pointer",
                ...(docked !== null
                  ? {
                      background: "var(--card)",
                      borderBottom: "none",
                      borderRadius: 6,
                      padding: "1px 6px 2px",
                      outline: "2px solid var(--accent)",
                      outlineOffset: 3,
                    }
                  : null),
              }
            : {
                width: "100%",
                padding: "10px 12px",
                borderRadius: 9,
                border: `1px solid ${docked !== null ? "var(--accent)" : C.line}`,
                background: C.bg,
                color: C.text,
                fontSize: 14,
                fontFamily: font,
                boxSizing: "border-box",
                cursor: "pointer",
              }
        }
      />
      {}
      {!externalPad && <AmountPadHost target={pad} onClose={() => setPad(null)} />}
    </>
  );
}
