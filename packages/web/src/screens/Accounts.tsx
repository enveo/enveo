import { computeStateResponse } from "@enveo/shared";
import { useEffect, useMemo, useState } from "react";
import { AmountPadHost, type AmountPadTarget } from "../components/AmountPadSheet";
import { Sheet } from "../components/chrome";
import { IconColorPicker } from "../components/IconColorPicker";
import { fmtSignedTrim } from "../lib/amount";
import { type StateResponse, useLedgerVersion } from "../lib/api";
import {
  accountFormPayload,
  canConfigureAutomaticEnvelope,
  selectableAutomaticEnvelopes,
  visibleAutomaticEnvelopeName,
} from "../lib/automaticEnvelopeAccountUi";
import { useMask, useTheme } from "../lib/contexts";
import { currentMonth } from "../lib/dates";
import { useDragReorder } from "../lib/dnd";
import { localizePadExpression, parseAmount } from "../lib/format";
import { useT } from "../lib/i18n";
import { Ico } from "../lib/icons";
import { local } from "../lib/mutate";
import { useWideHost } from "../lib/shellContext";
import { store } from "../lib/store";
import { ACCOUNT_COLORS, font, P, TEAL } from "../lib/theme";
import { AccountListRowContent } from "./AccountListRowContent";
import { EnvelopePickerSheet } from "./add/EnvelopePickerSheet";

export function AccountsScreen({ state, onMenu }: { state: StateResponse; onMenu: () => void }) {
  const C = useTheme();
  const M = useMask();
  const { t, lang } = useT();
  const inWide = useWideHost() !== null;
  // Accounts are CURRENT-balance always (unlike envelopes) — recomputed from the replica at
  // `currentMonth()` regardless of the app's viewed month, same pattern as chrome.tsx's Drawer
  // and widgets.tsx's AccountsWidget.
  const version = useLedgerVersion();
  const accountsNow = useMemo(() => {
    const l = store.getLedger();
    return l ? computeStateResponse(l, currentMonth()).accounts : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const accounts = [...accountsNow].filter((a) => !a.archived).sort((a, b) => a.sort - b.sort);
  const closed = [...accountsNow].filter((a) => a.archived).sort((a, b) => a.sort - b.sort);
  const total = accounts.reduce((s, a) => s + a.balance, 0);
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<StateResponse["accounts"][number] | null>(null);
  const [nm, setNm] = useState("");
  const [bl, setBl] = useState("");
  const [nmColor, setNmColor] = useState<string>(ACCOUNT_COLORS[0]!);
  const [nmIcon, setNmIcon] = useState("wallet");
  const [automaticEnvelopeId, setAutomaticEnvelopeId] = useState<string | null>(null);
  const [automaticPicker, setAutomaticPicker] = useState(false);
  const [pad, setPad] = useState<AmountPadTarget | null>(null);
  const selectableEnvelopes = selectableAutomaticEnvelopes(state.envelopes);
  const automaticEnvelopeName = selectableEnvelopes.find((envelope) => envelope.id === automaticEnvelopeId)?.name ?? null;
  useEffect(() => {
    if (automaticEnvelopeId && !state.envelopes.some((envelope) => !envelope.archived && envelope.id === automaticEnvelopeId)) setAutomaticEnvelopeId(null);
  }, [automaticEnvelopeId, state.envelopes]);
  const openAdd = () => {
    // rotating preselection like the previous auto-assignment — the user may change it
    setNm("");
    setBl("");
    setNmColor(ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length]!);
    setNmIcon("wallet");
    setAutomaticEnvelopeId(null);
    setAutomaticPicker(false);
    setAdd(true);
  };
  const closeAdd = () => {
    setAutomaticPicker(false);
    setAdd(false);
  };

  // A move is applied to the flat ordering of active accounts — only changed sorts are written
  // (accounts are a single flat list, unlike ManageGroup's per-group envelopes).
  const commitMove = (from: number, to: number) => {
    const order = [...accounts];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved!);
    const sortOf = new Map(accounts.map((a) => [a.id, a.sort]));
    const ch = order.map((a, i) => ({ id: a.id, sort: i })).filter((c) => sortOf.get(c.id) !== c.sort);
    for (const c of ch) local.updateAccount(c.id, { sort: c.sort });
  };
  const dnd = useDragReorder(commitMove);

  const openBalancePad = () =>
    setPad({
      label: t("Starting balance"),
      initial: parseAmount(bl) ?? 0,
      allowNegative: true, // account balance may be negative (e.g. a credit card)
      onCommit: (minor) => setBl(fmtSignedTrim(minor)),
    });

  const submit = () => {
    if (!nm.trim()) return;
    local.createAccount(
      accountFormPayload({
        name: nm.trim(),
        initialBalance: parseAmount(bl) ?? 0,
        color: nmColor,
        icon: nmIcon,
        onBudget: true,
        automaticEnvelopeId,
        sort: accounts.length,
      }),
    );
    setNm("");
    setBl("");
    setAutomaticEnvelopeId(null);
    closeAdd();
  };

  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `12px ${P}px 4px` }}>
        {inWide ? (
          <span style={{ width: 28, height: 28 }} aria-hidden="true" />
        ) : (
          <button onClick={onMenu} aria-label={t("Menu")} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
            <Ico d="M4 6h16M4 12h16M4 18h16" size={20} />
          </button>
        )}
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 18.5, fontWeight: 600, color: C.text }}>{t("Accounts")}</div>
          <div style={{ fontSize: 12, color: C.soft, marginTop: 1 }}>
            {t("Balance")}: <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{M(total)}</span>
          </div>
        </div>
        <button
          onClick={openAdd}
          aria-label={t("Add account")}
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            border: "none",
            background: "var(--accent-1a)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Ico d="M12 5v14M5 12h14" size={18} color={TEAL} sw={2.2} />
        </button>
      </div>
      <div style={{ padding: `8px ${P}px` }}>
        {accounts.map((a, i) => {
          const b = dnd.bind(i);
          const linkedEnvelopeName = visibleAutomaticEnvelopeName(a, state.envelopes);
          const automaticLabel = linkedEnvelopeName ? t("Automatic: {envelope}", { envelope: linkedEnvelopeName }) : null;
          return (
            <div
              key={a.id}
              ref={dnd.itemRef(i)}
              className="fu"
              style={{
                animationDelay: `${i * 22}ms`,
                display: "flex",
                alignItems: "center",
                gap: 2,
                padding: "11px 0",
                borderBottom: i < accounts.length - 1 ? `1px solid ${C.line}` : "none",
                background: dnd.dragging === i ? C.bg : "transparent",
                outline: dnd.over === i && dnd.dragging !== i ? `2px dashed ${TEAL}` : "none",
                outlineOffset: -2,
                borderRadius: 8,
              }}
            >
              <span
                {...b}
                aria-label={t("Drag {name}", { name: a.name })}
                style={{ ...b.style, display: "flex", padding: "8px 6px", marginLeft: -6, flexShrink: 0 }}
              >
                <Ico d="M4 7h16M4 12h16M4 17h16" size={14} color={C.mute} />
              </span>
              <div
                role="button"
                onClick={() => setEdit(a)}
                style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}
              >
                <AccountListRowContent account={a} automaticLabel={automaticLabel} balanceText={M(a.balance)} colors={C} />
              </div>
            </div>
          );
        })}
        {closed.length > 0 && (
          <>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: C.mute, textTransform: "uppercase", letterSpacing: 0.6, margin: "16px 0 4px" }}>
              {t("Closed")}
            </div>
            {closed.map((a) => {
              const linkedEnvelopeName = visibleAutomaticEnvelopeName(a, state.envelopes);
              const automaticLabel = linkedEnvelopeName ? t("Automatic: {envelope}", { envelope: linkedEnvelopeName }) : null;
              return (
                <div
                  key={a.id}
                  role="button"
                  onClick={() => setEdit(a)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    minWidth: 0,
                    padding: "9px 0",
                    opacity: 0.55,
                    cursor: "pointer",
                  }}
                >
                  <AccountListRowContent account={a} automaticLabel={automaticLabel} balanceText={M(a.balance)} compact colors={C} />
                </div>
              );
            })}
          </>
        )}
      </div>

      <Sheet show={add} onClose={closeAdd}>
        {(C) => (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 14 }}>{t("New account")}</div>
            <input
              value={nm}
              onChange={(e) => setNm(e.target.value)}
              placeholder={t("Account name")}
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
                marginBottom: 8,
              }}
            />
            <input
              // `bl` stays CANONICAL (fmtSignedTrim in, parseAmount out) — display only is localized.
              value={localizePadExpression(bl, lang)}
              readOnly
              onClick={openBalancePad}
              onFocus={openBalancePad}
              placeholder={t("Starting balance (0)")}
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
                marginBottom: 14,
                cursor: "pointer",
              }}
            />
            <IconColorPicker palette={ACCOUNT_COLORS} color={nmColor} icon={nmIcon} onColor={setNmColor} onIcon={setNmIcon} />
            <AutomaticEnvelopeControl
              enabled={automaticEnvelopeId !== null}
              envelopeName={automaticEnvelopeName}
              onToggle={() => (automaticEnvelopeId ? setAutomaticEnvelopeId(null) : setAutomaticPicker(true))}
              onPick={() => setAutomaticPicker(true)}
            />
            <button
              onClick={submit}
              style={{
                width: "100%",
                padding: 12,
                borderRadius: 11,
                border: "none",
                background: TEAL,
                color: "#fff",
                fontSize: 13.5,
                fontWeight: 600,
                cursor: "pointer",
                opacity: nm.trim() ? 1 : 0.4,
              }}
            >
              {t("Add account")}
            </button>
          </>
        )}
      </Sheet>

      <EnvelopePickerSheet
        show={add && automaticPicker}
        onClose={() => setAutomaticPicker(false)}
        envelopes={state.envelopes}
        groups={state.groups}
        onSelect={(id) => {
          setAutomaticEnvelopeId(id);
          setAutomaticPicker(false);
        }}
      />
      <AccountEdit account={edit} envelopes={state.envelopes} groups={state.groups} onClose={() => setEdit(null)} />
      {/* Sibling of the "New account" sheet (not a child) — the panel's transform would break the pad's position:fixed. */}
      <AmountPadHost target={pad} onClose={() => setPad(null)} />
    </div>
  );
}

/** Account editing: name + color/icon + automatic envelope + archiving. */
function AccountEdit({
  account,
  envelopes,
  groups,
  onClose,
}: {
  account: StateResponse["accounts"][number] | null;
  envelopes: StateResponse["envelopes"];
  groups: StateResponse["groups"];
  onClose: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(ACCOUNT_COLORS[0]!);
  const [icon, setIcon] = useState("wallet");
  const [archived, setArchived] = useState(false);
  const [automaticEnvelopeId, setAutomaticEnvelopeId] = useState<string | null>(null);
  const [automaticPicker, setAutomaticPicker] = useState(false);
  useEffect(() => {
    if (account) {
      setName(account.name);
      setColor(account.color);
      setIcon(account.icon);
      setArchived(account.archived);
      setAutomaticEnvelopeId(
        selectableAutomaticEnvelopes(envelopes).some((envelope) => envelope.id === account.automaticEnvelopeId) ? account.automaticEnvelopeId : null,
      );
      setAutomaticPicker(false);
    }
  }, [account]);
  useEffect(() => {
    if (automaticEnvelopeId && !selectableAutomaticEnvelopes(envelopes).some((envelope) => envelope.id === automaticEnvelopeId)) {
      setAutomaticEnvelopeId(null);
    }
  }, [automaticEnvelopeId, envelopes]);
  if (!account) return null;
  const automaticEnvelopeName = selectableAutomaticEnvelopes(envelopes).find((envelope) => envelope.id === automaticEnvelopeId)?.name ?? null;
  const close = () => {
    setAutomaticPicker(false);
    onClose();
  };
  const save = () => {
    const nm = name.trim();
    if (!nm) return;
    if (archived && !account.archived) {
      const ok = window.confirm(
        t(
          "The account “{name}” will disappear from the Start screen and lists (you will find it under “Closed” on the Accounts screen). Its transactions and balance still count in the budget and reports.\n\nArchive it?",
          { name: nm },
        ),
      );
      if (!ok) return;
    }
    local.updateAccount(
      account.id,
      accountFormPayload({
        name: nm,
        color,
        icon,
        onBudget: account.onBudget,
        automaticEnvelopeId,
        archived,
      }),
    );
    close();
  };
  return (
    <>
      <Sheet show={!!account} onClose={close}>
        {(C) => (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 14 }}>{t("Edit account")}</div>
            <div style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.6 }}>
              {t("Account name")}
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 0",
                border: "none",
                borderBottom: `1px solid ${C.line}`,
                background: "none",
                color: C.text,
                fontSize: 15,
                fontFamily: font,
                marginBottom: 18,
                boxSizing: "border-box",
              }}
            />
            <IconColorPicker palette={ACCOUNT_COLORS} color={color} icon={icon} onColor={setColor} onIcon={setIcon} />
            {canConfigureAutomaticEnvelope(account) && (
              <AutomaticEnvelopeControl
                enabled={automaticEnvelopeId !== null}
                envelopeName={automaticEnvelopeName}
                onToggle={() => (automaticEnvelopeId ? setAutomaticEnvelopeId(null) : setAutomaticPicker(true))}
                onPick={() => setAutomaticPicker(true)}
              />
            )}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <span style={{ fontSize: 14, color: C.text }}>{t("Archived account")}</span>
              <button
                onClick={() => setArchived(!archived)}
                style={{
                  width: 42,
                  height: 24,
                  borderRadius: 12,
                  background: archived ? TEAL : C.line,
                  position: "relative",
                  border: "none",
                  cursor: "pointer",
                  transition: "background .2s",
                }}
              >
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    background: "#fff",
                    position: "absolute",
                    top: 2,
                    left: archived ? 20 : 2,
                    transition: "left .2s",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                  }}
                />
              </button>
            </div>
            <button
              onClick={save}
              disabled={!name.trim()}
              style={{
                width: "100%",
                padding: 12,
                borderRadius: 11,
                border: "none",
                background: TEAL,
                color: "#fff",
                fontSize: 13.5,
                fontWeight: 600,
                cursor: "pointer",
                opacity: name.trim() ? 1 : 0.4,
              }}
            >
              {t("Save")}
            </button>
          </>
        )}
      </Sheet>
      <EnvelopePickerSheet
        show={automaticPicker}
        onClose={() => setAutomaticPicker(false)}
        envelopes={envelopes}
        groups={groups}
        onSelect={(id) => {
          setAutomaticEnvelopeId(id);
          setAutomaticPicker(false);
        }}
      />
    </>
  );
}

function AutomaticEnvelopeControl({
  enabled,
  envelopeName,
  onToggle,
  onPick,
}: {
  enabled: boolean;
  envelopeName: string | null;
  onToggle: () => void;
  onPick: () => void;
}) {
  const C = useTheme();
  const { t } = useT();
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 14, color: C.text }}>{t("Automatic envelope")}</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t("Automatic envelope")}
          onClick={onToggle}
          style={{
            width: 42,
            height: 24,
            borderRadius: 12,
            background: enabled ? TEAL : C.line,
            position: "relative",
            border: "none",
            cursor: "pointer",
            transition: "background .2s",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: "#fff",
              position: "absolute",
              top: 2,
              left: enabled ? 20 : 2,
              transition: "left .2s",
              boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
            }}
          />
        </button>
      </div>
      <div style={{ color: C.mute, fontSize: 11.5, lineHeight: 1.45, marginTop: 6 }}>
        {t("Income and transfers to this account increase the selected envelope. Transfers from this account decrease it.")}
      </div>
      <div style={{ color: C.mute, fontSize: 11.5, lineHeight: 1.45, marginTop: 6 }}>
        {t("The link works from now on. The current account balance and envelope amount will not change.")}
      </div>
      {enabled && envelopeName && (
        <button
          type="button"
          onClick={onPick}
          style={{
            width: "100%",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            marginTop: 10,
            padding: "9px 10px",
            borderRadius: 9,
            border: `1px solid ${C.line}`,
            background: C.bg,
            color: C.text,
            fontSize: 13,
            fontFamily: font,
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{envelopeName}</span>
          <Ico d="M9 18l6-6-6-6" size={15} color={C.mute} />
        </button>
      )}
    </div>
  );
}
