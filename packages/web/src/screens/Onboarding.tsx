/**
 * First-run wizard — rendered by App when the replica is an EMPTY budget
 * (0 accounts, 0 envelopes, 0 transactions). Three steps:
 *  0. welcome: language (every locale in the registry), currency (same list as in Settings),
 *     "Start with an empty budget" OR "Try with sample data"
 *     (POST /demo/seed on the server → fullResync of the replica),
 *  1. first account (name + initial balance) — local.createAccount,
 *  2. envelope template (checklist with the option to add custom ones per group)
 *     — local.createGroup + local.createEnvelope.
 * All writes go through the existing local-first path (mirror + outbox).
 * On completion we call onDone — App removes the wizard and shows Start.
 */
import { type ReactNode, useEffect, useState } from "react";
import { AmountPadHost, type AmountPadTarget } from "../components/AmountPadSheet";
import BootShellWide from "../components/BootShellWide";
import { LogoMark } from "../components/chrome";
import { markInstallOffered } from "../components/InstallBanner";
import { InstallBody } from "../components/InstallBody";
import { fmtSignedTrim } from "../lib/amount";
import { api, apiErrorMessage } from "../lib/api";
import { useSettings, useTheme } from "../lib/contexts";
import { browserLocales, SUPPORTED_CURRENCIES, wizardCurrency } from "../lib/currency";
import { localizePadExpression, parseAmount } from "../lib/format";
import { type Lang, LOCALES, loadLocale, type Message, useT } from "../lib/i18n";
import { getInstallState, isInstallable, useInstall } from "../lib/installPrompt";
import { local } from "../lib/mutate";
import { customEnvelopeStyle, TEMPLATE } from "../lib/onboardingTemplate";
import { store } from "../lib/store";
import { assertOwnReplica, fullResync } from "../lib/sync";
import { ACCOUNT_COLORS, CORAL, font, P, TEAL } from "../lib/theme";
import { useViewMode } from "../lib/viewMode";

/** Checklist row: a template item (name=Message, color/icon from TEMPLATE) or a custom envelope (custom, styled via customEnvelopeStyle). */
type TplRow = { name?: Message; custom?: string; isSavings?: boolean; checked: boolean; color: string; icon: string };

/** Full-width action button (Settings idiom). */
function BigButton({
  label,
  onClick,
  disabled,
  variant = "teal",
}: {
  label: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "teal" | "outline";
}) {
  const C = useTheme();
  const styles: React.CSSProperties =
    variant === "teal" ? { border: "none", background: TEAL, color: "#fff" } : { border: `1px solid ${C.line}`, background: C.bg, color: C.text };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: "100%",
        padding: "13px 0",
        borderRadius: 11,
        fontSize: 13.5,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: font,
        ...styles,
      }}
    >
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
});

export function OnboardingScreen({ onDone }: { onDone: () => void }) {
  const C = useTheme();
  const { settings, setSettings } = useSettings();
  const { t, tp, lang } = useT();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Once the budget exists, offer the install step only where it is actually possible;
  // otherwise leave straight away — the card must never block completion.
  const { state: installState } = useInstall();
  const [showInstall, setShowInstall] = useState(false);
  // The card IS the one-time install offer. Marking it as made keeps the banner from sliding up
  // on Start seconds later, asking the same thing again.
  const doneWithInstall = () => {
    markInstallOffered();
    onDone();
  };
  const finish = () => {
    // tryDemo is async (awaits demoSeed + fullResync) — a beforeinstallprompt/appinstalled
    // event can land mid-flight, so read the LIVE store state (non-hook getter), not the
    // value the hook closed over at click time.
    if (isInstallable(getInstallState())) setShowInstall(true);
    else onDone();
  };
  // M5: `appinstalled` while the card is open (e.g. Chrome's omnibox install) — the offer
  // succeeded; InstallBody would render null under the heading. Finish exactly like the
  // card's own paths do.
  useEffect(() => {
    if (showInstall && !isInstallable(installState)) doneWithInstall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showInstall, installState]);

  // step 0 — currency. PRESELECTED from the browser locale (the budget row still carries the bare
  // server default at this point); the pick lives in local state and is written to the ledger when
  // the user leaves step 0, so the amounts in steps 1-2 already format in the chosen currency.
  const [currency, setCurrency] = useState<string>(() => wizardCurrency(store.getLedger()?.budgets?.[0]?.currency, browserLocales()));

  /** The wizard ALWAYS sets the currency — commit the pick (a no-op when it already matches). */
  const commitCurrency = () => {
    const budget = store.getLedger()?.budgets?.[0];
    if (budget && budget.currency !== currency) local.updateBudget(budget.id, currency);
  };

  // step 1 — first account
  const [accName, setAccName] = useState("");
  const [accBal, setAccBal] = useState("");
  const [pad, setPad] = useState<AmountPadTarget | null>(null);

  const openBalancePad = () =>
    setPad({
      label: t("Starting balance"),
      initial: parseAmount(accBal) ?? 0,
      allowNegative: true, // initial balance may be negative (e.g. a credit card)
      onCommit: (minor) => setAccBal(fmtSignedTrim(minor)),
    });

  // step 2 — template checklist (everything checked by default) + custom entries per group
  const [rows, setRows] = useState<TplRow[][]>(() =>
    TEMPLATE.map((g) => g.envelopes.map((e) => ({ name: e.name, color: e.color, icon: e.icon, ...(e.isSavings ? { isSavings: true } : {}), checked: true }))),
  );
  const [drafts, setDrafts] = useState<string[]>(() => TEMPLATE.map(() => ""));

  const tryDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      // enqueue BEFORE the resync: the snapshot brings the server's default currency back, but
      // fullResync replays the outbox onto the fresh mirror, so the pick survives (and is pushed)
      commitCurrency();
      // the demo dataset itself exists in Polish and English only — any other UI language gets the English one
      const userId = await assertOwnReplica(); // owner assertion: the verified id travels in the body
      await api.demoSeed(lang === "pl" ? "pl" : "en", userId);
      await fullResync(); // fresh server data → full replica replacement
      finish();
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
    // running count of customs added so far (across ALL groups) picks the next color in the cycle
    const customCount = rows.reduce((n, g) => n + g.filter((r) => r.custom !== undefined).length, 0);
    const style = customEnvelopeStyle(customCount);
    setRows((prev) => prev.map((g, i) => (i === gi ? [...g, { custom: name, checked: true, ...style }] : g)));
    setDrafts((prev) => prev.map((d, i) => (i === gi ? "" : d)));
  };

  const anyChecked = rows.some((g) => g.some((r) => r.checked));
  // Wide-only sticky-row status text (Task 4) — total checked count across every group.
  const picked = rows.reduce((n, g) => n + g.filter((r) => r.checked).length, 0);

  const createEnvelopes = () => {
    TEMPLATE.forEach((tpl, gi) => {
      const sel = rows[gi]!.filter((r) => r.checked);
      if (sel.length === 0) return;
      const g = local.createGroup(t(tpl.group));
      sel.forEach((r, i) => {
        local.createEnvelope({
          groupId: g.id,
          name: r.custom ?? t(r.name!),
          sort: i,
          color: r.color,
          icon: r.icon,
          ...(r.isSavings ? { isSavings: true } : {}),
        });
      });
    });
    finish(); // empty-budget condition cleared → App renders Start (or the install card first)
  };

  // Wide (fold/desktop): the wizard hosts itself inside the boot shell (PR7 Task 3) — it is a
  // boot state, not an app screen, so it leaves App's rail/BottomNav/SyncBadge/InstallBanner
  // entirely behind (App.tsx renders this component unwrapped, before any of those mount — see
  // App.tsx's own comment at that branch). Static import is legal here: this whole module is
  // ALREADY lazy (App.tsx's `OnboardingScreen = lazy(...)`), so Vite emits BootShellWide as a
  // shared chunk reachable only through dynamic imports — nothing eager grows.
  const mode = useViewMode();
  const wide = mode !== "phone";
  // ONE step/install tree for both hosts (do not fork it per mode): the step wrappers' own
  // `flex: 1; justifyContent: "center"` are no-ops inside BootShellWide's auto-height content
  // column (flex-grow against an auto-sized parent does nothing there), and the shell centres
  // its column with `margin: auto` instead — so the exact same JSX reads correctly in the
  // phone's own flex-1/overflow scroller below and in the shell's content region.
  const body = showInstall ? (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 18 }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: C.text, marginBottom: 6 }}>
          {wide ? t("Add Enveo to this device") : t("Add Enveo to your phone")}
        </div>
        <div style={{ fontSize: 13.5, color: C.soft, lineHeight: 1.5 }}>
          {wide
            ? t("One click and Enveo runs in its own window — offline, full screen, no browser bar.")
            : t("One tap and Enveo lives on your home screen — offline, full screen, no browser bar.")}
        </div>
      </div>
      <InstallBody onDone={doneWithInstall} />
      <button
        onClick={doneWithInstall}
        style={{
          width: "100%",
          marginTop: 4,
          padding: "11px 0",
          borderRadius: 11,
          border: "none",
          background: "transparent",
          color: C.soft,
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: font,
        }}
      >
        {t("Skip for now")}
      </button>
    </div>
  ) : (
    <>
      {/* ── Step 0: welcome + language/currency + path choice ── */}
      {step === 0 && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", marginBottom: 26 }}>
            <div style={{ marginBottom: 16 }}>
              <LogoMark size={74} />
            </div>
            <div style={{ fontSize: 21, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("Welcome to Enveo")}</div>
            <div style={{ fontSize: 13, color: C.soft, lineHeight: 1.6, maxWidth: 300 }}>
              {t("Envelope budgeting: assign your income to envelopes and always know how much you can still spend.")}
            </div>
          </div>

          <Row label={t("Language")}>
            {/* From the registry, like Settings: detectLang() can preselect ANY locale, so a two-option
                    control would open the wizard with nothing selected for a German or Czech browser. */}
            <select
              value={settings.lang}
              /* the locale chunk is fetched BEFORE the switch — otherwise the wizard stays English until a reload */
              onChange={(e) => {
                const id = e.target.value as Lang;
                void loadLocale(id).then(() => setSettings({ ...settings, lang: id }));
              }}
              style={{
                padding: "7px 10px",
                borderRadius: 9,
                border: `1px solid ${C.line}`,
                background: C.bg,
                color: C.text,
                fontSize: 12.5,
                fontWeight: 600,
                fontFamily: font,
              }}
            >
              {LOCALES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.endonym}
                </option>
              ))}
            </select>
          </Row>
          <Row label={t("Currency")}>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              style={{
                padding: "7px 10px",
                borderRadius: 9,
                border: `1px solid ${C.line}`,
                background: C.bg,
                color: C.text,
                fontSize: 12.5,
                fontWeight: 600,
                fontFamily: font,
              }}
            >
              {SUPPORTED_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Row>

          <div style={{ height: 26 }} />
          <BigButton
            label={t("Start with an empty budget")}
            onClick={() => {
              commitCurrency();
              setStep(1);
            }}
            disabled={busy}
            variant="teal"
          />
          <div style={{ height: 10 }} />
          <BigButton label={busy ? t("Loading sample data…") : t("Try it with sample data")} onClick={() => void tryDemo()} disabled={busy} variant="outline" />
          {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
        </div>
      )}

      {/* ── Step 1: first account ── */}
      {step === 1 && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: 19, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("Your first account")}</div>
          <div style={{ fontSize: 12.5, color: C.soft, lineHeight: 1.6, marginBottom: 22 }}>
            {t("Add the account you spend from. The balance can be approximate — it is easy to adjust later.")}
          </div>

          <div style={{ fontSize: 11, color: C.mute, fontWeight: 600, marginBottom: 6 }}>{t("Account name")}</div>
          <input
            value={accName}
            onChange={(e) => setAccName(e.target.value)}
            placeholder={t("e.g. Checking")}
            style={{ ...inputStyle(C.line, C.bg, C.text), marginBottom: 14 }}
          />

          <div style={{ fontSize: 11, color: C.mute, fontWeight: 600, marginBottom: 6 }}>{`${t("Starting balance")} (${currency})`}</div>
          <input
            // `accBal` stays CANONICAL (fmtSignedTrim in, parseAmount out) — display only is
            // localized, placeholder included ("0.00" in en, "0,00" in pl).
            value={localizePadExpression(accBal, lang)}
            readOnly
            onClick={openBalancePad}
            onFocus={openBalancePad}
            placeholder={localizePadExpression("0,00", lang)}
            style={{ ...inputStyle(C.line, C.bg, C.text), marginBottom: 22, cursor: "pointer" }}
          />
          {/* Wide-only (M13 sibling ruling): the mock draws this caption in both modes, but a
                  wizard step this short never needed reassurance on a 420px phone screen — phone
                  pixels stay untouched (spec §Goal: phone identity wins on an unflagged mock
                  addition). negative marginTop folds the caption up against the input's own
                  marginBottom:22 instead of stacking a second gap under it. */}
          {wide && (
            <div style={{ fontSize: 11.5, color: C.mute, lineHeight: 1.5, marginTop: -14, marginBottom: 22 }}>
              {t("A negative balance is fine — that is how a credit card starts.")}
            </div>
          )}

          <BigButton label={t("Add account")} onClick={createAccount} disabled={!accName.trim()} variant="teal" />
          <button
            onClick={() => setStep(0)}
            style={{
              width: "100%",
              marginTop: 12,
              padding: "11px 0",
              borderRadius: 11,
              border: "none",
              background: "transparent",
              color: C.soft,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: font,
            }}
          >
            {t("Back")}
          </button>
        </div>
      )}

      {/* ── Step 2: envelope template (checklist + custom per group) ── */}
      {step === 2 && (
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, color: C.text, marginBottom: 8, marginTop: 6 }}>{t("Your envelopes")}</div>
          <div style={{ fontSize: 12.5, color: C.soft, lineHeight: 1.6, marginBottom: 18 }}>
            {t("Pick the envelopes you want to start with — you can change them or add new ones anytime.")}
          </div>

          {/* Wide (fold/desktop): the groups tile into a 2/3-column grid instead of stacking —
                  minmax(0, 1fr) is load-bearing (a track with an implicit auto minimum would grow
                  to fit a long custom-envelope name instead of letting it ellipsize inside the
                  cell). Phone keeps single-column stacking. Group blocks themselves are byte-
                  identical between modes (M13) — only this outer wrapper forks. */}
          <div
            style={
              wide ? { display: "grid", gridTemplateColumns: `repeat(${mode === "desktop" ? 3 : 2}, minmax(0, 1fr))`, gap: 12, alignItems: "start" } : undefined
            }
          >
            {TEMPLATE.map((tpl, gi) => (
              <div key={tpl.group} style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: C.mute, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
                  {t(tpl.group)}
                </div>
                <div style={{ background: C.bg, borderRadius: 11, border: `1px solid ${C.line}`, padding: "2px 12px" }}>
                  {rows[gi]!.map((r, ri) => (
                    <button
                      key={r.custom ?? r.name}
                      onClick={() => toggleRow(gi, ri)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        width: "100%",
                        padding: "11px 0",
                        background: "none",
                        border: "none",
                        borderBottom: `1px solid ${C.line}`,
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: 6,
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          background: r.checked ? TEAL : "transparent",
                          border: r.checked ? "none" : `1.5px solid ${C.line}`,
                        }}
                      >
                        {r.checked && (
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="#fff"
                            strokeWidth="3.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M4.5 12.5l5 5 10-11" />
                          </svg>
                        )}
                      </span>
                      {/* flex:1/minWidth:0 + nowrap/ellipsis: a narrowed grid column (or a very
                              long custom name on phone) truncates the name instead of overflowing
                              the card — the wealth chip after it never gets pushed off. */}
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontSize: 13.5,
                          color: C.text,
                          fontWeight: 500,
                        }}
                      >
                        {r.custom ?? t(r.name!)}
                      </span>
                      {wide && r.isSavings && (
                        <span
                          style={{
                            fontSize: 9.5,
                            fontWeight: 750,
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                            color: TEAL,
                            flexShrink: 0,
                          }}
                        >
                          {t("Wealth")}
                        </span>
                      )}
                    </button>
                  ))}
                  <div style={{ display: "flex", gap: 8, padding: "9px 0" }}>
                    <input
                      value={drafts[gi]}
                      onChange={(e) => setDrafts((prev) => prev.map((d, i) => (i === gi ? e.target.value : d)))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addCustom(gi);
                      }}
                      placeholder={t("Custom envelope…")}
                      style={{ ...inputStyle(C.line, C.bg, C.text), padding: "8px 10px", fontSize: 13 }}
                    />
                    <button
                      onClick={() => addCustom(gi)}
                      disabled={!drafts[gi]?.trim()}
                      aria-label={t("Add a custom envelope")}
                      style={{
                        flexShrink: 0,
                        width: 38,
                        borderRadius: 10,
                        border: `1px solid ${C.line}`,
                        background: C.bg,
                        color: C.text,
                        fontSize: 18,
                        fontWeight: 600,
                        cursor: "pointer",
                        opacity: drafts[gi]?.trim() ? 1 : 0.5,
                        fontFamily: font,
                      }}
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* sticky (not fixed): stays pinned to the .gs scrollport's bottom edge while the
                  checklist scrolls, so the CTA is reachable without scrolling all the way down —
                  desktop viewports (1280x800) can otherwise clip it below the fold (B3). On phone
                  bottom:-32 compensates the .gs container's own 32px bottom padding; on wide the
                  scrollport is the shell's content region (no such padding baked into .gs there),
                  so the offset is 0. The background hides list rows scrolling underneath. */}
          <div style={{ position: "sticky", bottom: wide ? 0 : -32, padding: "10px 0 4px", background: C.bg, display: "flex", alignItems: "center", gap: 12 }}>
            {wide && (
              <span style={{ flex: 1, fontSize: 12, color: C.soft }}>
                {picked === 0 ? (
                  t("Pick at least one envelope.")
                ) : (
                  <>
                    {tp("{n} envelope selected | {n} envelopes selected", picked)}
                    {" · "}
                    {currency}
                  </>
                )}
              </span>
            )}
            <div style={{ flex: wide ? "none" : 1, minWidth: wide ? 220 : undefined, width: wide ? undefined : "100%" }}>
              <BigButton label={t("Create envelopes")} onClick={createEnvelopes} disabled={!anyChecked} variant="teal" />
            </div>
          </div>
        </div>
      )}
    </>
  );

  if (!wide)
    return (
      <div className="gs" style={{ flex: 1, overflowY: "auto", padding: `24px ${P + 4}px 32px`, display: "flex", flexDirection: "column" }}>
        {body}
        <AmountPadHost target={pad} onClose={() => setPad(null)} />
      </div>
    );

  return (
    <BootShellWide
      mode={mode}
      view={showInstall ? "install" : "wizard"}
      wizardStep={step}
      formMax={step === 2 && !showInstall ? (mode === "desktop" ? 820 : 1000) : undefined}
    >
      <div className="gs">{body}</div>
      <AmountPadHost target={pad} onClose={() => setPad(null)} />
    </BootShellWide>
  );
}
