import type React from "react";
import { useEffect, useRef, useState } from "react";
import { fmtSignedTrim } from "../lib/amount";
import { useCurrency, useTheme } from "../lib/contexts";
import { formatMoney, localizePadExpression, parseAmount } from "../lib/format";
import { useT } from "../lib/i18n";
import { useWideHost } from "../lib/shellContext";
import { font } from "../lib/theme";
import { AmountPadHost, type AmountPadTarget } from "./AmountPadSheet";

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
        style={
          inline
            ? { ...inlineFigureStyle(C.mute, err ? "var(--danger)" : C.text), fontFamily: font }
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

  const openPad = () => setPad({ label, initial: parseAmount(value) ?? 0, allowNegative, onCommit: (minor) => onCommit(fmtSignedTrim(minor)) });

  return (
    <>
      <input
        value={inline && parseAmount(value) !== null ? formatMoney(parseAmount(value)!, currency, lang) : localizePadExpression(value, lang)}
        readOnly
        placeholder={placeholder}
        onClick={openPad}
        onFocus={openPad}
        style={
          inline
            ? { ...inlineFigureStyle(C.mute, C.text), fontFamily: font, cursor: "pointer" }
            : {
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
              }
        }
      />
      {}
      {!externalPad && <AmountPadHost target={pad} onClose={() => setPad(null)} />}
    </>
  );
}
