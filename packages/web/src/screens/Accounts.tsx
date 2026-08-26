import { computeStateResponse } from "@enveo/shared";
import { useEffect, useMemo, useState } from "react";
import { AccountEditSheet, AutomaticEnvelopeControl } from "../components/AccountEditSheet";
import { AmountField } from "../components/AmountField";
import { AmountPadHost, type AmountPadTarget } from "../components/AmountPadSheet";
import { Surface } from "../components/chrome";
import { IconColorPicker } from "../components/IconColorPicker";
import { SegBar } from "../components/reportKit";
import { accountIconColor } from "../components/tiles";
import { type StateResponse, useLedgerVersion } from "../lib/api";
import { accountFormPayload, selectableAutomaticEnvelopes, visibleAutomaticEnvelopeName } from "../lib/automaticEnvelopeAccountUi";
import { useMask, useTheme } from "../lib/contexts";
import { currentMonth, monthLabel } from "../lib/dates";
import { useDragReorder } from "../lib/dnd";
import { parseAmount } from "../lib/format";
import { useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { local } from "../lib/mutate";
import { useWideHost } from "../lib/shellContext";
import { store } from "../lib/store";
import { ACCOUNT_COLORS, CTA, font, P, TEAL } from "../lib/theme";
import { AccountListRowContent } from "./AccountListRowContent";
import { EnvelopePickerSheet } from "./add/EnvelopePickerSheet";

export function AccountsScreen({
  state,
  onMenu,
  onOpenAccount,
  selectedAccountId = null,
}: {
  state: StateResponse;
  onMenu: () => void;
  /** PR6b Task 3: wide-only — a row opens the account pane instead of the edit sheet when both
   *  this and `inWide` (below) hold. Phone never passes it (`inWide` is always false there), so
   *  phone behaviour stays byte-identical. */
  onOpenAccount?: (id: string) => void;
  /** PR6b Task 3: the currently-selected account (App's `acctView`), for the row highlight below.
   *  Always `null` on phone. */
  selectedAccountId?: string | null;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, tp, lang } = useT();
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
  // Wide hero card (design v3:944-996, E1): cash = Σ positive balances, owed = Σ|negative
  // balances| — the SAME `accounts` (global-current, non-archived) the header total above
  // already reduces over, just split by sign instead of summed flat.
  const cashTotal = accounts.filter((a) => a.balance > 0).reduce((s, a) => s + a.balance, 0);
  const debtTotal = accounts.filter((a) => a.balance < 0).reduce((s, a) => s + a.balance, 0);
  // SegBar shows the CASH side's composition only (design's own `acctSummary.segments`) — a
  // debt-only ledger renders an empty (all-`C.line`) bar, which is correct: there is no cash to
  // segment, and the caption below already says so via `debtShareText`.
  const segments = accounts.filter((a) => a.balance > 0).map((a) => ({ weight: a.balance, color: a.color }));
  // Below 1% would round to a flat "0%" beside a non-zero Owed figure — say "under 1%" instead
  // (design behavior, v3:2702-2706). The design's OWN zero-debt case reads the bare word "none"
  // (v3:2703's `pct < 1` guard only fires once `debtTotal !== 0`) — deliberately literal "0%"
  // here instead: numerically identical, and it keeps the outer caption's ONE placeholder a
  // locale-neutral number+percent in every branch except the deliberate "under 1%" rounding
  // note, rather than smuggling a second bare English word through as translatable data.
  const debtPct = cashTotal > 0 && debtTotal !== 0 ? (Math.abs(debtTotal) / cashTotal) * 100 : null;
  const debtShareText = debtPct === null ? "0%" : debtPct < 1 ? t("under 1%") : `${Math.min(100, Math.round(debtPct))}%`;
  // Sub-line transaction count: "touches this account" is two-sided (a transfer's `toAccountId`
  // counts too), the SAME rule `AccountPanel.tsx`'s own recent-activity list documents — against
  // `state.transactions` (the VIEWED month, same as every other per-month stat on this state),
  // never the global replica (that's the balance's job, computed separately above).
  const accountTxnCount = (a: { id: string }) => state.transactions.filter((tr) => tr.accountId === a.id || tr.toAccountId === a.id).length;
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<StateResponse["accounts"][number] | null>(null);
  // PR6b Task 3: on wide, a row opens the account pane instead of the edit sheet; phone (and any
  // wide state that hasn't wired `onOpenAccount` yet) keeps today's row-tap-opens-edit behaviour.
  const openRow = (a: StateResponse["accounts"][number]) => (inWide && onOpenAccount ? onOpenAccount(a.id) : setEdit(a));
  const [nm, setNm] = useState("");
  const [bl, setBl] = useState("");
  // Hoisted out of `AmountField` (its `externalPad` escape hatch) so `AmountPadHost` (below) can
  // render as a SIBLING of the "New account" `<Surface>` — nesting the pad inside the Surface body
  // would put its Sheet inside the (phone) outer Sheet's always-transformed content div, breaking
  // the pad's position:fixed backdrop+numpad (the ancestor-transform pitfall; ReconcileSheet.tsx
  // is the reference shape, and AmountField.test.ts fails the suite on a regression).
  const [blPad, setBlPad] = useState<AmountPadTarget | null>(null);
  const [nmColor, setNmColor] = useState<string>(ACCOUNT_COLORS[0]!);
  const [nmIcon, setNmIcon] = useState("wallet");
  const [automaticEnvelopeId, setAutomaticEnvelopeId] = useState<string | null>(null);
  const [automaticPicker, setAutomaticPicker] = useState(false);
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
    // The hoisted pad outlives the Surface's own unmount-on-close (unlike the field-internal
    // default) — close it with the sheet or it would float over the bare accounts list.
    setBlPad(null);
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
    <div
      className="gs"
      data-wide-accounts={inWide || undefined}
      style={
        inWide
          ? { flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 12 }
          : { flex: 1, overflowY: "auto", paddingBottom: 6 }
      }
    >
      {inWide ? (
        // Design parity wave E task 1 (v3:944-996): the hero card + "OPEN ACCOUNTS" grid replace
        // BOTH the phone header above (its "Accounts"/"Balance" text now lives in the band caption,
        // App.tsx's `wideRightSlot` — waveA-t5-brief.md) and the flat drag-reorderable list below.
        // No back-chevron, no hamburger, no phone footer — owner rule 2 (no phone chrome in
        // panels) applies equally to the PRIMARY pane here, and the band already carries the title.
        <>
          <div
            style={{
              background: C.card,
              border: `1px solid ${C.line}`,
              borderRadius: 14,
              padding: "14px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.mute }}>{t("Net worth")}</div>
                <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em", color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(total)}</div>
              </div>
              <div style={{ display: "flex", gap: 22, paddingBottom: 4 }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.mute }}>{t("Cash")}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: C.pos, fontVariantNumeric: "tabular-nums" }}>{M(cashTotal)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.mute }}>{t("Owed")}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: C.neg, fontVariantNumeric: "tabular-nums" }}>{M(Math.abs(debtTotal))}</div>
                </div>
              </div>
            </div>
            <SegBar segments={segments} height={10} />
            <span style={{ fontSize: 11.5, color: C.soft }}>
              {t("Card debt is {debtShare} of what you hold · balances are always current, whatever month you view", { debtShare: debtShareText })}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <span style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.mute }}>{t("Open accounts")}</span>
            <button
              onClick={openAdd}
              style={{
                cursor: "pointer",
                fontSize: 12.5,
                fontWeight: 650,
                color: "#fff",
                background: CTA,
                border: "none",
                borderRadius: 9,
                padding: "7px 13px",
              }}
            >
              <span aria-hidden="true">＋</span> {t("New account")}
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {accounts.map((a) => {
              const linkedEnvelopeName = visibleAutomaticEnvelopeName(a, state.envelopes);
              const sub = linkedEnvelopeName
                ? t("Automatic: {envelope}", { envelope: linkedEnvelopeName })
                : tp("{n} transaction · {month} | {n} transactions · {month}", accountTxnCount(a), { month: monthLabel(state.month, lang) });
              const isSelected = selectedAccountId === a.id;
              return (
                <div
                  key={a.id}
                  role="button"
                  aria-current={isSelected || undefined}
                  onClick={() => openRow(a)}
                  style={{
                    cursor: "pointer",
                    background: C.card,
                    border: `1px solid ${isSelected ? TEAL : C.line}`,
                    boxShadow: isSelected ? "0 2px 8px rgba(20,20,28,0.10)" : "none",
                    borderRadius: 14,
                    padding: "13px 14px",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <span
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: 12,
                      background: a.color,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <span
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: "50%",
                        background: "rgba(255,255,255,0.92)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Glyph name={a.icon} size={16} color={accountIconColor(a.color)} />
                    </span>
                  </span>
                  <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 14.5, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.name}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: linkedEnvelopeName ? TEAL : C.mute,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {sub}
                    </span>
                  </span>
                  <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, flexShrink: 0 }}>
                    <span style={{ fontSize: 15.5, fontWeight: 700, color: a.balance < 0 ? C.neg : C.text, fontVariantNumeric: "tabular-nums" }}>
                      {M(a.balance)}
                    </span>
                    <span
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEdit(a);
                      }}
                      style={{ cursor: "pointer", fontSize: 11, color: TEAL, fontWeight: 600 }}
                    >
                      {t("Edit")}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>

          {closed.length > 0 && (
            <>
              <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.mute, marginTop: 4 }}>
                {t("Closed")}
              </div>
              <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "4px 14px" }}>
                {closed.map((a) => (
                  <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0" }}>
                    <span
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 10,
                        background: a.color,
                        opacity: 0.55,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <span
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: "50%",
                          background: "rgba(255,255,255,0.92)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Glyph name={a.icon} size={12} color={accountIconColor(a.color)} />
                      </span>
                    </span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: C.soft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.name}
                    </span>
                    <span style={{ fontSize: 13, color: C.mute, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{M(a.balance)}</span>
                    <button
                      onClick={() => local.updateAccount(a.id, { archived: false })}
                      style={{
                        cursor: "pointer",
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: TEAL,
                        background: "none",
                        border: `1px solid ${TEAL}`,
                        borderRadius: 8,
                        padding: "5px 11px",
                        flexShrink: 0,
                      }}
                    >
                      {t("Restore")}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `12px ${P}px 4px` }}>
            <button onClick={onMenu} aria-label={t("Menu")} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
              <Ico d="M4 6h16M4 12h16M4 18h16" size={20} />
            </button>
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
                  // PR6b Task 3: the selected-row highlight wins over the drag-dragging background —
                  // the two never coincide in practice (dragging clears any wide selection concern),
                  // but selection reads first for clarity.
                  aria-current={selectedAccountId === a.id || undefined}
                  style={{
                    animationDelay: `${i * 22}ms`,
                    display: "flex",
                    alignItems: "center",
                    gap: 2,
                    padding: "11px 0",
                    borderBottom: i < accounts.length - 1 ? `1px solid ${C.line}` : "none",
                    background: selectedAccountId === a.id ? C.inset : dnd.dragging === i ? C.bg : "transparent",
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
                    onClick={() => openRow(a)}
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
                      onClick={() => openRow(a)}
                      aria-current={selectedAccountId === a.id || undefined}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        minWidth: 0,
                        padding: "9px 0",
                        background: selectedAccountId === a.id ? C.inset : "transparent",
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
        </>
      )}

      <Surface show={add} onClose={closeAdd}>
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
            <div style={{ marginBottom: 14 }}>
              <AmountField
                value={bl}
                onCommit={setBl}
                label={t("Starting balance")}
                placeholder={t("Starting balance (0)")}
                allowNegative
                externalPad={[blPad, setBlPad]}
              />
            </div>
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
      </Surface>

      {/* Sibling of the "New account" Surface (not a child) — the panel's transform would break
          the pad's position:fixed on wide, and on phone the outer Sheet's own always-on transform
          would do the same to a pad nested inside it (ReconcileSheet.tsx is the reference shape;
          see `AmountField`'s `externalPad` docblock). */}
      <AmountPadHost target={blPad} onClose={() => setBlPad(null)} />

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
      <AccountEditSheet account={edit} envelopes={state.envelopes} groups={state.groups} onClose={() => setEdit(null)} />
    </div>
  );
}
