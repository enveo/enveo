import { computeStateResponse, type Transaction, type TxnPayload } from "@enveo/shared";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { ImportSheet } from "../components/ImportSheet";
import { SectionEyebrow, useBand } from "../components/kit";
import { Numpad } from "../components/pickers";
import { hasOpenOp, type PadState, padKey } from "../lib/amount";
import { type StateResponse, useLedgerVersion } from "../lib/api";
import { categoryCountsFor, rankCategories } from "../lib/categoryIndex";
import { useMask, useTheme } from "../lib/contexts";
import { currentMonth, formatDateLong, todayISO } from "../lib/dates";
import { evalExpression } from "../lib/format";
import { haptic } from "../lib/haptics";
import { type Message, msg, useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { preferredAccountId, setLastAccountId } from "../lib/lastAccount";
import { local } from "../lib/mutate";
import { store } from "../lib/store";
import { rankEnvelopes, rankPlaces } from "../lib/suggest";
import { font, P, TEAL, tint } from "../lib/theme";

import { AccountPickerSheet, DestinationAccountSheet } from "./add/AccountPickerSheet";
import { AddHeader } from "./add/AddHeader";
import { AmountSection } from "./add/AmountSection";
import { DateSheet } from "./add/DateSheet";
import { EnvelopePickerSheet } from "./add/EnvelopePickerSheet";
import { SplitEditor } from "./add/SplitEditor";
import { TransactionFields } from "./add/TransactionFields";
import type { AddDraft, Tab } from "./add/types";

export type { AddDraft, Tab } from "./add/types";

/** Top `take` of `ranked`, but guaranteed to include `pinnedId` (prepended, bumping the tail)
 *  when it exists in `ranked` and would otherwise fall outside the slice — a selection made via
 *  the full sheet (or inherited from edit/draft prefill) must stay visible if the grid reopens. */
function withPinned<T extends { id: string }>(ranked: T[], pinnedId: string | null, take: number): T[] {
  const base = ranked.slice(0, take);
  if (pinnedId != null && !base.some((x) => x.id === pinnedId)) {
    const pinned = ranked.find((x) => x.id === pinnedId);
    if (pinned) return [pinned, ...base.slice(0, take - 1)];
  }
  return base;
}

/** ISO date `n` days before `iso` (UTC — matches DateSheet's own Yesterday button). */
function isoDaysBefore(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function AddScreen({
  state,
  onDone,
  editTxn,
  draft,
  initialTab,
  initialImport,
}: {
  state: StateResponse;
  onDone: () => void;
  editTxn: Transaction | null;
  draft?: AddDraft;
  /** Quick-action preset from Start (lib/contexts.tsx WidgetId "quickActions" → App.tsx onQuickAdd):
   *  pre-selects a tab on a FRESH Add (read once at mount — AddScreen unmounts/remounts per screen switch). */
  initialTab?: Tab;
  /** Quick-action preset: opens the screenshot-import sheet immediately on mount. */
  initialImport?: boolean;
}) {
  const C = useTheme();
  const M = useMask();
  const { band } = useBand();
  const { t, lang } = useT();
  const ledgerVersion = useLedgerVersion();
  // Accounts are CURRENT-balance always — never scoped to the viewed month (unlike envelopes).
  // Recomputed from the replica at `currentMonth()` regardless of which month `state` was built
  // for, so every account display in this screen (source/destination pickers, grids) shows the
  // same balance as the Start screen and Accounts screen — same pattern as chrome.tsx's Drawer.
  const accountsNow = useMemo(() => {
    const l = store.getLedger();
    return l ? computeStateResponse(l, currentMonth()).accounts : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerVersion]);
  const accounts = [...accountsNow].filter((a) => !a.archived).sort((a, b) => a.sort - b.sort);

  const [tab, setTab] = useState<Tab>(initialTab ?? "expense");
  // Amount = the same state machine as the Budget pad (padKey): reduction on
  // an operator ("15+25" + "+" → "40+"), contextual "="/✓, fresh=prefill
  // replaced by the first digit. setAmount sets the prefill (edit/AI).
  const [pad, setPad] = useState<PadState>({ expr: "", fresh: true });
  const amount = pad.expr;
  const setAmount = (s: string) => setPad({ expr: s, fresh: true });
  const [accountId, setAccountId] = useState(() => preferredAccountId(accounts, accounts[1]?.id ?? accounts[0]?.id ?? ""));
  const [toAccountId, setToAccountId] = useState(accounts.find((a) => a.id !== accountId)?.id ?? "");
  const [isRefund, setIsRefund] = useState(false);
  const [envelopeId, setEnvelopeId] = useState<string | null>(null);
  // KOPERTA/NA KONTO: suggestion grid (true) vs the collapsed single-row summary (false).
  // Expense starts open (nothing to summarize yet); income/transfer start collapsed — a pool
  // default or a pre-picked destination already exists, so the grid is an opt-in "change" step.
  const [envOpen, setEnvOpen] = useState(true);
  const [destOpen, setDestOpen] = useState(false);
  const [items, setItems] = useState<Array<{ envelopeId: string; amount: number }>>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [catInput, setCatInput] = useState("");
  const [catOpen, setCatOpen] = useState(false);
  const [name, setName] = useState("");
  const [placeId, setPlaceId] = useState<string | null>(null);
  const [placeInput, setPlaceInput] = useState("");
  const [showPlace, setShowPlace] = useState(false);
  // Only true right after the user taps "Type a place…" — the place input's `autoFocus` reads
  // this instead of firing unconditionally, so entering EDIT for a transaction that already has
  // a place (which expands the field programmatically below) doesn't steal focus at mount and
  // leave a permanent :focus-visible ring with no user interaction.
  const [placeAutoFocus, setPlaceAutoFocus] = useState(false);
  const [note, setNote] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [numpad, setNumpad] = useState(true);

  const [showAcc, setShowAcc] = useState(false);
  const [showTo, setShowTo] = useState(false);
  const [showDate, setShowDate] = useState(false);
  const [showEnv, setShowEnv] = useState(false);
  const [showImport, setShowImport] = useState(!!initialImport);
  const [splitMode, setSplitMode] = useState(false);
  const [showTxnMenu, setShowTxnMenu] = useState(false); // kebab in the edit header

  // editing an existing transaction
  useEffect(() => {
    if (!editTxn) return;
    setTab(editTxn.type);
    setAmount((editTxn.amount / 100).toFixed(2).replace(".", ","));
    setAccountId(editTxn.accountId);
    if (editTxn.toAccountId) setToAccountId(editTxn.toAccountId);
    setIsRefund(editTxn.isRefund);
    setEnvelopeId(editTxn.envelopeId);
    setItems(editTxn.items.map((i) => ({ envelopeId: i.envelopeId, amount: i.amount })));
    setSplitMode(editTxn.items.length > 0);
    setCategoryId(editTxn.categoryId);
    setPlaceId(editTxn.placeId);
    setName(editTxn.name ?? "");
    setNote(editTxn.note ?? "");
    setShowPlace(!!editTxn.placeId); // expand filled fields right away (no icon clicking)
    setPlaceAutoFocus(false); // programmatic expansion — never steal focus on entering edit
    setDate(editTxn.date);
    setEnvOpen(false);
    setDestOpen(false);
  }, [editTxn]);

  // Draft-mode prefill: from corrections (initial — returning to the edit) or from a
  // recognized import item. ONLY on mount — the draft object is often created inline
  // by the parent and must not overwrite typed values on re-renders.
  useEffect(() => {
    if (!draft) return;
    const e = draft.initial;
    if (e) {
      setTab(e.type);
      setAmount((e.amount / 100).toFixed(2).replace(".", ","));
      setAccountId(e.accountId);
      if (e.toAccountId) setToAccountId(e.toAccountId);
      setIsRefund(e.isRefund);
      setEnvelopeId(e.envelopeId);
      setCategoryId(e.categoryId);
      setName(e.name);
      setNote(e.note);
      prefillPlace(e.placeName);
      setDate(e.date);
    } else {
      const it = draft.item;
      setTab(it.type);
      setAmount((it.amount / 100).toFixed(2).replace(".", ","));
      setAccountId(draft.accountId);
      if (it.toAccountId) setToAccountId(it.toAccountId); // transfer learned from history
      setIsRefund(it.type === "expense" && !!it.isRefund);
      setEnvelopeId(it.envelopeId);
      setCategoryId(it.categoryId ?? null);
      setName(it.name);
      prefillPlace(it.placeName ?? null);
      setDate(it.date);
    }
    setEnvOpen(false);
    setDestOpen(false);
    setNumpad(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A place from import is a NAME (no ID) — if a 1:1 match exists, we attach the ID
  // (the input shows the selected place without a dropdown); otherwise text goes to placeInput.
  function prefillPlace(placeName: string | null) {
    if (!placeName) return;
    const match = state.places.find((p) => p.name.toLowerCase() === placeName.toLowerCase());
    if (match) setPlaceId(match.id);
    else setPlaceInput(placeName);
    setShowPlace(true);
  }

  const plus = tab === "income" || (tab === "expense" && isRefund);
  const accObj = accounts.find((a) => a.id === accountId);
  const envById = new Map(state.envelopes.map((e) => [e.id, e]));
  const env = envelopeId ? envById.get(envelopeId) : null;
  const toAcc = accounts.find((a) => a.id === toAccountId);

  /* Categories sorted by co-occurrence with the SELECTED envelope (index
     memoized per replica version — zero scanning on each open);
     the text filter preserves the ranking within the matches. */
  const rankedCats = useMemo(() => {
    const ledger = store.getLedger();
    const forEnv = envelopeId ?? items[0]?.envelopeId ?? null;
    const counts = ledger ? categoryCountsFor(ledger, ledgerVersion, forEnv) : new Map<string, number>();
    return rankCategories(state.categories, counts);
  }, [ledgerVersion, envelopeId, items, state.categories]);
  const filteredCats = catInput ? rankedCats.filter((c) => c.name.toLowerCase().includes(catInput.toLowerCase())) : rankedCats;
  const filteredPlaces = placeInput ? state.places.filter((p) => p.name.toLowerCase().includes(placeInput.toLowerCase())) : [];

  const press = (k: string) => setPad((p) => padKey(p, k === "DEL" ? "⌫" : k));

  const reset = () => {
    setEnvelopeId(null);
    setItems([]);
    setSplitMode(false);
    setCategoryId(null);
    setCatInput("");
    setCatOpen(false);
  };

  const minor = evalExpression(amount) ?? 0;
  // scroll the amount field to the end (cursor visible) for a long expression
  const amtRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = amtRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [amount]);
  const splitSum = items.reduce((s, i) => s + i.amount, 0);
  // entering split: the selected envelope becomes the first item with the whole amount
  const enterSplit = () => {
    if (items.length === 0 && env) setItems([{ envelopeId: env.id, amount: minor }]);
    setSplitMode(true);
  };
  const submitLabel: Message =
    tab === "expense" ? (isRefund ? msg("Add refund") : msg("Add expense")) : tab === "income" ? msg("Add income") : msg("Add transfer");

  // empty-state backstop: without an account there is nothing to save a transaction on
  const noAccount = accounts.length === 0;

  // fully synchronous save: local mirror immediately, network in the background (outbox)
  function submit() {
    if (minor <= 0 || noAccount) return;
    if (!draft) setLastAccountId(accountId); // per-device preference
    // Draft mode: build the corrected import item and hand it to the parent — ZERO local.*
    // (the save goes in bulk through /import/apply with source_ref preserved).
    if (draft) {
      if (tab === "transfer" && (!toAccountId || toAccountId === accountId)) return;
      draft.onSave({
        type: tab,
        accountId,
        toAccountId: tab === "transfer" ? toAccountId : null,
        isRefund: tab === "expense" && isRefund,
        amount: minor,
        date,
        name: name.trim(),
        // income has no envelope selection (always → To be budgeted); transfer likewise has none.
        // Place/category are expense-only — switching tab after picking either on an expense must
        // not silently attach them to an income/transfer.
        envelopeId: tab === "expense" ? envelopeId : null,
        categoryId: tab === "expense" ? categoryId : null,
        placeName: tab === "expense" ? (placeId ? (state.places.find((p) => p.id === placeId)?.name ?? null) : placeInput.trim() || null) : null,
        note,
      });
      haptic([10, 30, 14]);
      return;
    }
    const usingSplit = tab === "expense" && splitMode && items.length > 0;
    const payload: TxnPayload = {
      type: tab,
      accountId,
      toAccountId: tab === "transfer" ? toAccountId : null,
      amount: usingSplit ? splitSum : minor,
      date,
      isRefund: tab === "expense" && isRefund,
      // income has no envelope selection (always → To be budgeted); transfer likewise has none.
      // Place/category are expense-only — gated the same way, so switching tab after picking
      // either on an expense never silently attaches them to an income/transfer.
      envelopeId: tab !== "expense" ? null : usingSplit ? null : envelopeId,
      placeId: tab === "expense" ? placeId : null,
      categoryId: usingSplit ? null : tab === "expense" ? categoryId : null,
      name: name.trim() || null,
      note: note || null,
      items: usingSplit ? items.map((i) => ({ envelopeId: i.envelopeId, amount: i.amount })) : undefined,
    };
    if (editTxn) local.updateTxn(editTxn.id, payload);
    else local.createTxn(payload);
    haptic([10, 30, 14]);
    onDone();
  }

  // Date shown under the amount: Today/Yesterday when applicable, else the long form; a date
  // other than today renders C.warn so a back-dated entry is visible at a glance (board spec).
  const todayIso = todayISO();
  const isToday = date === todayIso;
  const isYesterday = !isToday && date === isoDaysBefore(todayIso, 1);
  const dateLabel = isToday ? t("Today") : isYesterday ? t("Yesterday") : formatDateLong(date, lang);
  const dateColor = isToday ? C.soft : C.warn;

  // Local suggestion rankings (lib/suggest.ts) — pure, no I/O; recomputed on every render (cheap
  // for a personal ledger). Envelope ranking also reacts live to the typed amount (amount affinity).
  const ledgerNow = store.getLedger();
  const rankedEnvObjs = ledgerNow
    ? rankEnvelopes(ledgerNow, todayIso, minor > 0 ? minor : null)
        .map((id) => envById.get(id))
        .filter((e): e is NonNullable<typeof e> => !!e)
    : [];
  const placeScopeEnv = envelopeId ?? items[0]?.envelopeId ?? null;
  const rankedPlaceObjs = ledgerNow
    ? rankPlaces(ledgerNow, placeScopeEnv, categoryId)
        .map((id) => state.places.find((p) => p.id === id))
        .filter((p): p is NonNullable<typeof p> => !!p)
    : [];

  const envGridList = withPinned(rankedEnvObjs, envelopeId, 4);
  const catList = withPinned(rankedCats, categoryId, 4);
  const placeList = withPinned(rankedPlaceObjs, placeId, 3);
  const destList = withPinned(
    accounts.filter((a) => a.id !== accountId),
    toAccountId,
    4,
  );

  // Live preview for the collapsed KOPERTA row: what the envelope's "available" becomes after
  // this transaction (income/refund add, expense subtracts) — reuses the existing Reports idiom.
  const envAfter = (env?.available ?? 0) + (plus ? minor : -minor);
  const envPreviewText = envAfter < 0 ? t("over by {amount}", { amount: M(-envAfter) }) : t("{amount} left", { amount: M(envAfter) });

  // Chip surface (board spec: pill, centered flex-wrap) — the ghost variant marks "type your own".
  const chipStyle = (selected: boolean): CSSProperties => ({
    background: selected ? "var(--accent-1a)" : C.card,
    border: `1px solid ${selected ? "var(--accent)" : C.line}`,
    color: selected ? "var(--accent)" : C.text,
    borderRadius: 999,
    padding: "5px 11px",
    fontSize: 11,
    fontWeight: selected ? 650 : 600,
    cursor: "pointer",
  });
  const ghostChipStyle: CSSProperties = {
    background: C.card,
    border: `1px solid ${C.line}`,
    color: C.mute,
    borderRadius: 999,
    padding: "5px 11px",
    fontSize: 11,
    cursor: "pointer",
  };
  // KOPERTA/NA KONTO suggestion card (2×2 grid) and its collapsed single-row summary.
  const gridCardStyle = (selected: boolean): CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 7,
    background: C.card,
    textAlign: "left",
    width: "100%",
    border: `${selected ? 2 : 1}px solid ${selected ? "var(--accent)" : C.line}`,
    borderRadius: 11,
    padding: selected ? "7px 9px" : "8px 10px",
    cursor: "pointer",
  });
  const collapsedRowStyle = (accent: boolean): CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 9,
    textAlign: "left",
    width: `calc(100% - ${2 * P}px)`,
    background: accent ? C.card : "none",
    border: accent ? `2px solid var(--accent)` : `1.3px dashed ${C.line}`,
    borderRadius: 12,
    padding: "9px 12px",
    margin: `0 ${P}px`,
    cursor: "pointer",
  });
  const linkBtnStyle: CSSProperties = {
    background: "none",
    border: "none",
    padding: 0,
    color: "var(--accent)",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: font,
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
      <AddHeader
        tab={tab}
        isEdit={!!editTxn}
        isDraft={!!draft}
        menuOpen={showTxnMenu}
        onBack={draft ? draft.onCancel : onDone}
        onTabSelect={(tb) => {
          setTab(tb);
          reset();
          setIsRefund(false);
          setEnvOpen(tb === "expense");
          setDestOpen(false);
        }}
        onDelete={() => {
          if (!editTxn) return;
          if (window.confirm(t("Delete this transaction? This cannot be undone."))) {
            local.deleteTxn(editTxn.id);
            onDone();
          }
        }}
        onToggleMenu={() => setShowTxnMenu((v) => !v)}
        onDuplicate={() => {
          if (!editTxn) return;
          setShowTxnMenu(false);
          local.duplicateTxn(editTxn);
          onDone();
        }}
        onOpenImport={() => setShowImport(true)}
      />

      <AmountSection
        tab={tab}
        isRefund={isRefund}
        plus={plus}
        amount={amount}
        numpadOpen={numpad}
        amtRef={amtRef}
        accountName={accObj?.name ?? null}
        dateLabel={dateLabel}
        dateColor={dateColor}
        onOpenPad={() => setNumpad(true)}
        onToggleRefund={() => setIsRefund((v) => !v)}
        onOpenAccountSheet={() => setShowAcc(true)}
        onOpenDateSheet={() => {
          setShowDate(true);
          setNumpad(false);
        }}
      />

      <TransactionFields name={name} note={note} onNameChange={setName} onFieldFocus={() => setNumpad(false)} onClearNote={() => setNote("")} />

      <div className="gs" style={{ flex: 1, overflowY: "auto" }} onClick={() => setNumpad(false)}>
        {tab === "transfer" ? (
          <>
            <SectionEyebrow
              label={t("Destination account")}
              right={
                <button onClick={() => setShowTo(true)} style={linkBtnStyle}>
                  {destOpen ? t("All") : t("Change")} ›
                </button>
              }
            />
            {destOpen ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, padding: `0 ${P}px` }}>
                {destList.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => {
                      setToAccountId(a.id);
                      setDestOpen(false);
                    }}
                    style={gridCardStyle(a.id === toAccountId)}
                  >
                    <Glyph name={a.icon} size={15} color={a.color} sw={1.8} />
                    <span style={{ minWidth: 0 }}>
                      <span
                        style={{
                          display: "block",
                          fontSize: 11,
                          fontWeight: 650,
                          color: C.text,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {a.name}
                      </span>
                      <span style={{ display: "block", fontSize: 9, color: C.soft, fontVariantNumeric: "tabular-nums" }}>{M(a.balance)}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <button onClick={() => setShowTo(true)} style={collapsedRowStyle(true)}>
                {toAcc && <Glyph name={toAcc.icon} size={17} color={toAcc.color} sw={1.8} />}
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12.5,
                    fontWeight: 650,
                    color: C.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {toAcc?.name ?? t("Destination account")}
                </span>
              </button>
            )}
          </>
        ) : tab === "expense" && splitMode ? (
          <SplitEditor items={items} setItems={setItems} envelopes={state.envelopes} total={minor} onCancel={() => setSplitMode(false)} />
        ) : tab === "expense" ? (
          <>
            <SectionEyebrow
              label={t("Envelope")}
              right={
                <button onClick={() => setShowEnv(true)} style={linkBtnStyle}>
                  {envOpen ? t("All") : t("Change")} ›
                </button>
              }
            />
            {envOpen ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, padding: `0 ${P}px` }}>
                {envGridList.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => {
                      setEnvelopeId(e.id);
                      setEnvOpen(false);
                    }}
                    style={gridCardStyle(e.id === envelopeId)}
                  >
                    <Glyph name={e.icon} size={15} color={e.color} sw={1.8} />
                    <span style={{ minWidth: 0 }}>
                      <span
                        style={{
                          display: "block",
                          fontSize: 11,
                          fontWeight: 650,
                          color: C.text,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {e.name}
                      </span>
                      <span style={{ display: "block", fontSize: 9, color: C.soft, fontVariantNumeric: "tabular-nums" }}>
                        {e.available < 0 ? "−" : ""}
                        {M(Math.abs(e.available))}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : env ? (
              <button onClick={() => setShowEnv(true)} style={collapsedRowStyle(true)}>
                <Glyph name={env.icon} size={17} color={env.color} sw={1.8} />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12.5,
                    fontWeight: 650,
                    color: C.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {env.name}
                </span>
                <span style={{ fontSize: 11, color: C.soft, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{envPreviewText}</span>
              </button>
            ) : (
              <button onClick={() => setEnvOpen(true)} style={collapsedRowStyle(false)}>
                <span style={{ flex: 1, fontSize: 12.5, color: C.mute }}>{t("Choose an envelope")}</span>
              </button>
            )}
          </>
        ) : null}

        {tab === "expense" && !splitMode && (
          <>
            <SectionEyebrow
              label={t("Category")}
              right={
                <button onClick={() => setCatOpen(true)} style={linkBtnStyle}>
                  {t("Other")} ›
                </button>
              }
            />
            {!catOpen && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: `0 ${P}px 4px` }}>
                {catList.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setCategoryId(categoryId === c.id ? null : c.id);
                      setCatOpen(false);
                    }}
                    style={chipStyle(categoryId === c.id)}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            )}
            {catOpen && (
              <div style={{ padding: `0 ${P}px 6px` }}>
                <input
                  value={catInput}
                  onChange={(e) => setCatInput(e.target.value)}
                  onFocus={() => setNumpad(false)}
                  placeholder={t("Type or pick a category...")}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: `1px solid ${C.line}`,
                    background: C.bg,
                    color: C.text,
                    fontSize: 12,
                    fontFamily: font,
                    boxSizing: "border-box",
                    marginBottom: 6,
                  }}
                />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                  {filteredCats.slice(0, 8).map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        setCategoryId(c.id);
                        setCatInput("");
                        setCatOpen(false);
                      }}
                      style={{
                        padding: "5px 10px",
                        borderRadius: 8,
                        fontSize: 11,
                        background: C.chip,
                        color: C.text,
                        border: `1px solid ${C.line}`,
                        cursor: "pointer",
                      }}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
                {/* category creation = local.createCategory — unavailable in draft (zero local.*) */}
                {!draft && catInput && !state.categories.some((c) => c.name.toLowerCase() === catInput.toLowerCase()) && (
                  <button
                    onClick={() => {
                      const c = local.createCategory(catInput);
                      setCategoryId(c.id);
                      setCatInput("");
                      setCatOpen(false);
                    }}
                    style={{
                      padding: "7px 10px",
                      borderRadius: 8,
                      fontSize: 11,
                      background: tint(C.pos, 0.1),
                      color: C.pos,
                      border: `1px solid ${tint(C.pos, 0.27)}`,
                      cursor: "pointer",
                      width: "100%",
                      textAlign: "left",
                    }}
                  >
                    {t("+ Add “{name}”", { name: catInput })}
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {tab === "expense" && (
          <>
            <SectionEyebrow label={t("Place")} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: `0 ${P}px 4px` }}>
              {placeList.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    if (placeId === p.id) setPlaceId(null);
                    else {
                      setPlaceId(p.id);
                      setPlaceInput("");
                      setShowPlace(false);
                    }
                  }}
                  style={chipStyle(placeId === p.id)}
                >
                  {p.name}
                </button>
              ))}
              <button
                onClick={() => {
                  const next = !showPlace;
                  setShowPlace(next);
                  setPlaceAutoFocus(next);
                }}
                style={ghostChipStyle}
              >
                {t("Type a place…")}
              </button>
            </div>
            {showPlace && (
              <div style={{ position: "relative", padding: `0 ${P}px 6px` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Ico d="M3 9l9-7 9 7v11a1 1 0 01-1 1h-4v-7H8v7H4a1 1 0 01-1-1V9z" size={15} color={placeId ? TEAL : C.mute} />
                  <input
                    // biome-ignore lint/a11y/noAutofocus: flag-gated — set only right after the user taps "Type a place…", never on a programmatic expand
                    autoFocus={placeAutoFocus}
                    placeholder={t("Place")}
                    value={placeId ? (state.places.find((p) => p.id === placeId)?.name ?? "") : placeInput}
                    onChange={(e) => {
                      setPlaceInput(e.target.value);
                      setPlaceId(null);
                    }}
                    onFocus={() => setNumpad(false)}
                    style={{
                      flex: 1,
                      background: "none",
                      border: "none",
                      borderBottom: `1px solid ${C.line}`,
                      color: C.text,
                      fontSize: 12,
                      fontFamily: font,
                      padding: "4px 0",
                    }}
                  />
                  {placeId && (
                    <button
                      onClick={() => {
                        setPlaceId(null);
                        setPlaceInput("");
                      }}
                      style={{ background: "none", border: "none", color: C.mute, fontSize: 11, cursor: "pointer" }}
                    >
                      ✕
                    </button>
                  )}
                </div>
                {/* in draft the place travels by NAME to /import/apply (server creates/matches) —
                    no local.createPlace button; dropdown only when there are suggestions */}
                {placeInput && !placeId && (!draft || filteredPlaces.length > 0) && (
                  <div
                    style={{
                      position: "absolute",
                      top: "100%",
                      left: 23,
                      right: 0,
                      background: C.card,
                      border: `1px solid ${C.line}`,
                      borderRadius: 8,
                      zIndex: 10,
                      maxHeight: 140,
                      overflowY: "auto",
                      marginTop: 2,
                      boxShadow: "0 4px 14px rgba(0,0,0,0.1)",
                    }}
                  >
                    {filteredPlaces.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          setPlaceId(p.id);
                          setPlaceInput("");
                        }}
                        style={{
                          display: "block",
                          width: "100%",
                          padding: "8px 11px",
                          background: "none",
                          border: "none",
                          borderBottom: `1px solid ${C.line}`,
                          color: C.text,
                          fontSize: 11,
                          cursor: "pointer",
                          textAlign: "left",
                          fontFamily: font,
                        }}
                      >
                        {p.name}
                      </button>
                    ))}
                    {!draft && (
                      <button
                        onClick={() => {
                          const p = local.createPlace(placeInput);
                          setPlaceId(p.id);
                          setPlaceInput("");
                        }}
                        style={{
                          display: "block",
                          width: "100%",
                          padding: "8px 11px",
                          background: "none",
                          border: "none",
                          color: TEAL,
                          fontSize: 11,
                          cursor: "pointer",
                          textAlign: "left",
                          fontFamily: font,
                        }}
                      >
                        {t("+ “{name}”", { name: placeInput })}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Footer: split link (expense only) — the old bottom icon row's remaining link. Hidden
            in draft (import editing is the past; it never splits). */}
        {!draft && tab === "expense" && !splitMode && (
          <div style={{ textAlign: "center", padding: "10px 0 6px" }}>
            <button
              onClick={enterSplit}
              style={{ background: "none", border: "none", color: C.soft, fontSize: 11, fontWeight: 600, cursor: "pointer", padding: 0 }}
            >
              {t("Split across envelopes")} ›
            </button>
          </div>
        )}
      </div>

      {/* Numpad above the CTA (board order: tgrow → numpad → cta2). Contextual OK like the
          docked pad: A⊕B → "=" (reduction, pad stays), otherwise ✓ closes the pad. */}
      {numpad && (
        <Numpad
          onKey={press}
          onOk={() => {
            if (hasOpenOp(amount)) press("=");
            else setNumpad(false);
          }}
          okGlyph={hasOpenOp(amount) ? "equals" : "check"}
          variant="sheet"
        />
      )}

      <div style={{ padding: `0 ${P}px calc(8px + env(safe-area-inset-bottom))` }}>
        {noAccount && (
          <div style={{ fontSize: 11.5, color: C.neg, textAlign: "center", marginBottom: 6 }}>
            {t("Add an account first — you need one to save a transaction.")}
          </div>
        )}
        <button
          onClick={submit}
          disabled={minor <= 0 || noAccount}
          style={{
            display: "block",
            width: "100%",
            margin: "10px 0 0",
            background: "var(--cta)",
            color: band ? C.headerBg : "#fff",
            textAlign: "center",
            border: "none",
            borderRadius: 13,
            padding: "13px 0",
            fontSize: 13.5,
            fontWeight: 700,
            cursor: "pointer",
            opacity: minor > 0 && !noAccount ? 1 : 0.4,
          }}
        >
          {draft ? t("Save item") : editTxn ? t("Save changes") : t(submitLabel)}
        </button>
      </div>

      <AccountPickerSheet
        show={showAcc}
        onClose={() => setShowAcc(false)}
        accounts={accounts}
        selectedId={accountId}
        onSelect={(id) => {
          setAccountId(id);
          if (toAccountId === id) setToAccountId(accounts.find((x) => x.id !== id)?.id ?? "");
          setShowAcc(false);
        }}
      />
      <DestinationAccountSheet
        show={showTo}
        onClose={() => setShowTo(false)}
        accounts={accounts}
        excludeId={accountId}
        selectedId={toAccountId}
        onSelect={(id) => {
          setToAccountId(id);
          setDestOpen(false);
          setShowTo(false);
        }}
      />
      <DateSheet show={showDate} date={date} onClose={() => setShowDate(false)} onChange={setDate} />
      {/* !editTxn is NOT required here: the "From screenshot" toggle restores edit-mode access
          (pre-redesign behavior — the edit header has no camera button, trash+kebab instead). */}
      {!draft && <ImportSheet show={showImport} onClose={() => setShowImport(false)} state={state} onApplied={onDone} />}
      <EnvelopePickerSheet
        show={showEnv}
        onClose={() => setShowEnv(false)}
        envelopes={state.envelopes}
        groups={state.groups}
        onSelect={(id) => {
          setEnvelopeId(id);
          setEnvOpen(false);
          setShowEnv(false);
        }}
      />
    </div>
  );
}
