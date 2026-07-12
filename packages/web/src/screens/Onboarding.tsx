/**
 * First-run wizard — rendered by App when the replica is an EMPTY budget
 * (0 accounts, 0 envelopes, 0 transactions). Three steps:
 *  0. welcome: language (Seg PL/EN), currency (same list as in Settings),
 *     "Start with an empty budget" OR "Try with sample data"
 *     (POST /demo/seed on the server → fullResync of the replica),
 *  1. first account (name + initial balance) — local.createAccount,
 *  2. envelope template (checklist with the option to add custom ones per group)
 *     — local.createGroup + local.createEnvelope.
 * All writes go through the existing local-first path (mirror + outbox).
 * On completion we call onDone — App removes the wizard and shows Start.
 */
import { useState, type ReactNode } from "react";
import { AmountPadHost, type AmountPadTarget } from "../components/AmountPadSheet";
import { LogoMark } from "../components/chrome";
import { api, apiErrorMessage } from "../lib/api";
import { useCurrency, useSettings, useTheme } from "../lib/contexts";
import { fmtSignedTrim } from "../lib/amount";
import { parseAmount } from "../lib/format";
import { useT, type TKey } from "../lib/i18n";
import { local } from "../lib/mutate";
import { store } from "../lib/store";
import { fullResync } from "../lib/sync";
import { ACCOUNT_COLORS, CORAL, P, TEAL, font } from "../lib/theme";

/* ── Envelope template — dictionary keys ONLY (names live in i18n, not here) ── */
const TEMPLATE: Array<{ group: TKey; envelopes: Array<{ name: TKey; isSavings?: boolean }> }> = [
  { group: "onb.tpl.bills", envelopes: [{ name: "onb.tpl.housing" }, { name: "onb.tpl.utilities" }, { name: "onb.tpl.subscriptions" }] },
  { group: "onb.tpl.living", envelopes: [{ name: "onb.tpl.groceries" }, { name: "onb.tpl.transport" }, { name: "onb.tpl.health" }, { name: "onb.tpl.fun" }] },
  { group: "onb.tpl.savings", envelopes: [{ name: "onb.tpl.savingsEnv", isSavings: true }, { name: "onb.tpl.rainyDay" }] },
];

/** Checklist row: a template item (name=TKey) or a custom envelope (custom). */
type TplRow = { name?: TKey; custom?: string; isSavings?: boolean; checked: boolean };

/** Selectable currencies — same list as in Settings (ISO 4217, no conversion). */
const CURRENCIES = ["PLN", "EUR", "USD", "GBP", "CHF", "CZK", "SEK", "NOK", "UAH"];

/** Segmented control (copy of the Settings idiom — not exported there). */
function Seg<T extends string>({ value, options, onChange }: { value: T; options: Array<{ id: T; label: string }>; onChange: (id: T) => void }) {
  const C = useTheme();
  return (
    <div style={{ display: "flex", background: C.bg, borderRadius: 9, padding: 2, border: `1px solid ${C.line}` }}>
      {options.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)} style={{ padding: "6px 12px", borderRadius: 7, border: "none", fontSize: 11.5, fontWeight: 600, cursor: "pointer", background: value === o.id ? TEAL : "transparent", color: value === o.id ? "#fff" : C.soft, whiteSpace: "nowrap", fontFamily: font }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Full-width action button (Settings idiom). */
function BigButton({ label, onClick, disabled, variant = "teal" }: { label: ReactNode; onClick: () => void; disabled?: boolean; variant?: "teal" | "outline" }) {
  const C = useTheme();
  const styles: React.CSSProperties =
    variant === "teal"
      ? { border: "none", background: TEAL, color: "#fff" }
      : { border: `1px solid ${C.line}`, background: C.bg, color: C.text };
  return (
    <button onClick={onClick} disabled={disabled} style={{ width: "100%", padding: "13px 0", borderRadius: 11, fontSize: 13.5, fontWeight: 600, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1, fontFamily: font, ...styles }}>
      {label}
    </button>
  );
}

/** Setting row (label + control) — as in Settings. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  const C = useTheme();
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 0", borderBottom: `1px solid ${C.line}` }}>
      <span style={{ fontSize: 13.5, color: C.text, fontWeight: 500 }}>{label}</span>
      {children}
    </div>
  );
}

const inputStyle = (line: string, bg: string, text: string): React.CSSProperties => ({
  width: "100%",
  boxSizing: "border-box",
  padding: "11px 12px",
  borderRadius: 10,
  border: `1px solid ${line}`,
  background: bg,
  color: text,
  fontSize: 14,
  fontFamily: font,
  outline: "none",
});

export function OnboardingScreen({ onDone }: { onDone: () => void }) {
  const C = useTheme();
  const { settings, setSettings } = useSettings();
  const { t, lang } = useT();
  const currency = useCurrency();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // step 1 — first account
  const [accName, setAccName] = useState("");
  const [accBal, setAccBal] = useState("");
  const [pad, setPad] = useState<AmountPadTarget | null>(null);

  const openBalancePad = () =>
    setPad({
      label: t("onb.initialBalance"),
      initial: parseAmount(accBal) ?? 0,
      allowNegative: true, // initial balance may be negative (e.g. a credit card)
      onCommit: (minor) => setAccBal(fmtSignedTrim(minor)),
    });

  // step 2 — template checklist (everything checked by default) + custom entries per group
  const [rows, setRows] = useState<TplRow[][]>(() =>
    TEMPLATE.map((g) => g.envelopes.map((e) => ({ name: e.name, ...(e.isSavings ? { isSavings: true } : {}), checked: true }))),
  );
  const [drafts, setDrafts] = useState<string[]>(() => TEMPLATE.map(() => ""));

  const tryDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.demoSeed(lang);
      await fullResync(); // fresh server data → full replica replacement
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const createAccount = () => {
    const name = accName.trim();
    if (!name) return;
    local.createAccount({ name, initialBalance: parseAmount(accBal) ?? 0, color: ACCOUNT_COLORS[0]!, icon: "wallet", sort: 0 });
    setStep(2);
  };

  const toggleRow = (gi: number, ri: number) =>
    setRows((prev) => prev.map((g, i) => (i === gi ? g.map((r, j) => (j === ri ? { ...r, checked: !r.checked } : r)) : g)));

  const addCustom = (gi: number) => {
    const name = drafts[gi]?.trim();
    if (!name) return;
    setRows((prev) => prev.map((g, i) => (i === gi ? [...g, { custom: name, checked: true }] : g)));
    setDrafts((prev) => prev.map((d, i) => (i === gi ? "" : d)));
  };

  const anyChecked = rows.some((g) => g.some((r) => r.checked));

  const createEnvelopes = () => {
    TEMPLATE.forEach((tpl, gi) => {
      const sel = rows[gi]!.filter((r) => r.checked);
      if (sel.length === 0) return;
      const g = local.createGroup(t(tpl.group));
      sel.forEach((r, i) => local.createEnvelope({ groupId: g.id, name: r.custom ?? t(r.name!), sort: i, ...(r.isSavings ? { isSavings: true } : {}) }));
    });
    onDone(); // empty-budget condition cleared → App renders Start
  };

  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", padding: `24px ${P + 4}px 32px`, display: "flex", flexDirection: "column" }}>
      {/* ── Step 0: welcome + language/currency + path choice ── */}
      {step === 0 && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", marginBottom: 26 }}>
            <div style={{ marginBottom: 16 }}><LogoMark size={74} /></div>
            <div style={{ fontSize: 21, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("onb.welcomeTitle")}</div>
            <div style={{ fontSize: 13, color: C.soft, lineHeight: 1.6, maxWidth: 300 }}>{t("onb.welcomeBody")}</div>
          </div>

          <Row label={t("settings.language")}>
            <Seg
              value={settings.lang}
              onChange={(id) => setSettings({ ...settings, lang: id })}
              options={[
                { id: "pl", label: "PL" },
                { id: "en", label: "EN" },
              ]}
            />
          </Row>
          <Row label={t("settings.currency")}>
            <select
              value={currency}
              onChange={(e) => {
                // guard: without a booted replica / a budgets entity there is nothing to update
                const budgetId = store.getLedger()?.budgets?.[0]?.id;
                if (budgetId) local.updateBudget(budgetId, e.target.value);
              }}
              style={{ padding: "7px 10px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.bg, color: C.text, fontSize: 12.5, fontWeight: 600, fontFamily: font, outline: "none" }}
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Row>

          <div style={{ height: 26 }} />
          <BigButton label={t("onb.startFresh")} onClick={() => setStep(1)} disabled={busy} variant="teal" />
          <div style={{ height: 10 }} />
          <BigButton label={busy ? t("onb.demoBusy") : t("onb.tryDemo")} onClick={() => void tryDemo()} disabled={busy} variant="outline" />
          {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
        </div>
      )}

      {/* ── Step 1: first account ── */}
      {step === 1 && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: 19, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("onb.step1Title")}</div>
          <div style={{ fontSize: 12.5, color: C.soft, lineHeight: 1.6, marginBottom: 22 }}>{t("onb.step1Body")}</div>

          <div style={{ fontSize: 11, color: C.mute, fontWeight: 600, marginBottom: 6 }}>{t("onb.accountName")}</div>
          <input value={accName} onChange={(e) => setAccName(e.target.value)} placeholder={t("onb.accountNamePh")} style={{ ...inputStyle(C.line, C.bg, C.text), marginBottom: 14 }} />

          <div style={{ fontSize: 11, color: C.mute, fontWeight: 600, marginBottom: 6 }}>{`${t("onb.initialBalance")} (${currency})`}</div>
          <input value={accBal} readOnly onClick={openBalancePad} onFocus={openBalancePad} placeholder="0,00" style={{ ...inputStyle(C.line, C.bg, C.text), marginBottom: 22, cursor: "pointer" }} />

          <BigButton label={t("onb.createAccount")} onClick={createAccount} disabled={!accName.trim()} variant="teal" />
          <button onClick={() => setStep(0)} style={{ width: "100%", marginTop: 12, padding: "11px 0", borderRadius: 11, border: "none", background: "transparent", color: C.soft, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: font }}>
            {t("common.back")}
          </button>
        </div>
      )}

      {/* ── Step 2: envelope template (checklist + custom per group) ── */}
      {step === 2 && (
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, color: C.text, marginBottom: 8, marginTop: 6 }}>{t("onb.step2Title")}</div>
          <div style={{ fontSize: 12.5, color: C.soft, lineHeight: 1.6, marginBottom: 18 }}>{t("onb.step2Body")}</div>

          {TEMPLATE.map((tpl, gi) => (
            <div key={tpl.group} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: C.mute, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>{t(tpl.group)}</div>
              <div style={{ background: C.bg, borderRadius: 11, border: `1px solid ${C.line}`, padding: "2px 12px" }}>
                {rows[gi]!.map((r, ri) => (
                  <button key={r.custom ?? r.name} onClick={() => toggleRow(gi, ri)} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "11px 0", background: "none", border: "none", borderBottom: `1px solid ${C.line}`, cursor: "pointer", textAlign: "left" }}>
                    <span aria-hidden="true" style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: r.checked ? TEAL : "transparent", border: r.checked ? "none" : `1.5px solid ${C.line}` }}>
                      {r.checked && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4.5 12.5l5 5 10-11" />
                        </svg>
                      )}
                    </span>
                    <span style={{ fontSize: 13.5, color: C.text, fontWeight: 500 }}>{r.custom ?? t(r.name!)}</span>
                  </button>
                ))}
                <div style={{ display: "flex", gap: 8, padding: "9px 0" }}>
                  <input
                    value={drafts[gi]}
                    onChange={(e) => setDrafts((prev) => prev.map((d, i) => (i === gi ? e.target.value : d)))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addCustom(gi);
                    }}
                    placeholder={t("onb.customEnvelopePh")}
                    style={{ ...inputStyle(C.line, C.bg, C.text), padding: "8px 10px", fontSize: 13 }}
                  />
                  <button onClick={() => addCustom(gi)} disabled={!drafts[gi]?.trim()} aria-label={t("onb.addCustomAria")} style={{ flexShrink: 0, width: 38, borderRadius: 10, border: `1px solid ${C.line}`, background: C.bg, color: C.text, fontSize: 18, fontWeight: 600, cursor: "pointer", opacity: drafts[gi]?.trim() ? 1 : 0.5, fontFamily: font }}>
                    +
                  </button>
                </div>
              </div>
            </div>
          ))}

          <BigButton label={t("onb.createEnvelopes")} onClick={createEnvelopes} disabled={!anyChecked} variant="teal" />
        </div>
      )}

      <AmountPadHost target={pad} onClose={() => setPad(null)} />
    </div>
  );
}
