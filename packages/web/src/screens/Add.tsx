import { computeStateResponse, type Transaction, type TxnPayload } from "@enveo/shared";
import { lazy, useEffect, useMemo, useRef, useState } from "react";
import { useBand } from "../components/kit";
import { LazyChunk, useOpenedOnce } from "../components/lazy";
import { Numpad } from "../components/pickers";
import { hasOpenOp, type PadState, padKey } from "../lib/amount";
import { type StateResponse, useLedgerVersion } from "../lib/api";
import {
  automaticEnvelopePreview,
  expenseEnvelopeAfterAccountChange,
  expenseEnvelopeAfterSplitCancel,
  expenseEnvelopeSelection,
  expenseEnvelopeSelectionForImport,
  explicitExpenseEnvelopeSelection,
  formatAutomaticEnvelopeEffect,
} from "../lib/automaticEnvelopeUi";
import { categoryCountsFor, rankCategories } from "../lib/categoryIndex";
import { useMask, useTheme } from "../lib/contexts";
import { currentMonth, formatDateLong, todayISO } from "../lib/dates";
import { evalExpression } from "../lib/format";
import { haptic } from "../lib/haptics";
import { type Message, msg, useT } from "../lib/i18n";
import { preferredAccountId, setLastAccountId } from "../lib/lastAccount";
import { local } from "../lib/mutate";
import { store } from "../lib/store";
import { rankEnvelopes, rankPlaces } from "../lib/suggest";
import { P } from "../lib/theme";

import { AccountPickerSheet, DestinationAccountSheet } from "./add/AccountPickerSheet";
import { AddHeader } from "./add/AddHeader";
import { AmountSection } from "./add/AmountSection";
import { AutomaticEnvelopeEffect } from "./add/AutomaticEnvelopeEffect";
import { DateSheet } from "./add/DateSheet";
import { EnvelopePickerSheet } from "./add/EnvelopePickerSheet";
import { ExpenseFields } from "./add/ExpenseFields";
import { TransactionFields } from "./add/TransactionFields";
import { TransferFields } from "./add/TransferFields";
import type { AddDraft, Tab } from "./add/types";

export type { AddDraft, Tab } from "./add/types";

// Screenshot import is the app's one AI-only surface (§3f): the review sheet, the AI dispatch
// and the response parsers it pulls in serve a path most sessions never open, while manual
// transaction entry — everything else on this screen — stays eager. The chunk is fetched the
// first time the sheet is opened and then stays mounted, exactly as it was before.
const ImportSheet = lazy(() => import("../components/ImportSheet").then((m) => ({ default: m.ImportSheet })));

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
  const preferredInitialAccountId = preferredAccountId(accounts, accounts[1]?.id ?? accounts[0]?.id ?? "");
  const initialAccountId = editTxn?.accountId ?? draft?.initial?.accountId ?? draft?.accountId ?? preferredInitialAccountId;
  const [accountId, setAccountId] = useState(initialAccountId);
  const [toAccountId, setToAccountId] = useState(accounts.find((a) => a.id !== accountId)?.id ?? "");
  const [isRefund, setIsRefund] = useState(false);
  const [expenseEnvelope, setExpenseEnvelope] = useState(() => {
    const automaticEnvelopeId = accounts.find((account) => account.id === initialAccountId)?.automaticEnvelopeId;
    if (editTxn) return expenseEnvelopeSelection(automaticEnvelopeId, { envelopeId: editTxn.envelopeId });
    if (draft?.initial)
      return draft.automaticEnvelopeDefault
        ? expenseEnvelopeSelection(automaticEnvelopeId)
        : expenseEnvelopeSelection(automaticEnvelopeId, { envelopeId: draft.initial.envelopeId });
    if (draft)
      return draft.automaticEnvelopeDefault
        ? expenseEnvelopeSelection(automaticEnvelopeId)
        : expenseEnvelopeSelectionForImport(draft.item.type, draft.item.envelopeId, automaticEnvelopeId);
    return expenseEnvelopeSelection(automaticEnvelopeId);
  });
  const envelopeId = expenseEnvelope.envelopeId;
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
  // Latched: the sheet chunk is fetched on the FIRST open and then stays mounted, so closing and
  // reopening keeps its state exactly as it did when the import was statically imported.
  const importOpened = useOpenedOnce(showImport);
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
    setExpenseEnvelope(explicitExpenseEnvelopeSelection(editTxn.envelopeId));
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
      setExpenseEnvelope(
        draft.automaticEnvelopeDefault
          ? expenseEnvelopeSelection(accounts.find((account) => account.id === e.accountId)?.automaticEnvelopeId)
          : explicitExpenseEnvelopeSelection(e.envelopeId),
      );
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
      const automaticEnvelopeId = accounts.find((account) => account.id === draft.accountId)?.automaticEnvelopeId;
      setExpenseEnvelope(
        draft.automaticEnvelopeDefault
          ? expenseEnvelopeSelection(automaticEnvelopeId)
          : expenseEnvelopeSelectionForImport(it.type, it.envelopeId, automaticEnvelopeId),
      );
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

  const reset = (nextTab: Tab) => {
    const automaticEnvelopeId = accounts.find((account) => account.id === accountId)?.automaticEnvelopeId;
    setExpenseEnvelope(nextTab === "expense" && !editTxn && !draft ? expenseEnvelopeSelection(automaticEnvelopeId) : explicitExpenseEnvelopeSelection(null));
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
    // (the accepted review later goes through the local import batch with source_ref preserved).
    if (draft) {
      if (tab === "transfer" && (!toAccountId || toAccountId === accountId)) return;
      draft.onSave(
        {
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
        },
        { automaticEnvelopeDefault: tab === "expense" && expenseEnvelope.provenance === "automatic" },
      );
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
  const automaticPreview = automaticEnvelopePreview(state, { type: tab, accountId, toAccountId: tab === "transfer" ? toAccountId : null }, minor, editTxn);
  const automaticEffect =
    minor > 0 && (automaticPreview.rows.length > 0 || automaticPreview.neutral)
      ? formatAutomaticEnvelopeEffect(automaticPreview, M, {
          heading: t("Automatic envelope effect"),
          readyToAssign: t("Ready to assign"),
          noEnvelopeChange: t("No envelope change"),
          noChange: t("No change"),
        })
      : null;

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
          reset(tb);
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
          <TransferFields
            destOpen={destOpen}
            destList={destList}
            toAccountId={toAccountId}
            toAcc={toAcc}
            onOpenSheet={() => setShowTo(true)}
            onPickDest={(id) => {
              setToAccountId(id);
              setDestOpen(false);
            }}
            automaticEffect={automaticEffect}
          />
        ) : tab === "expense" ? (
          <ExpenseFields
            splitMode={splitMode}
            isDraft={!!draft}
            items={items}
            setItems={setItems}
            envelopes={state.envelopes}
            splitTotal={minor}
            onCancelSplit={() => {
              setExpenseEnvelope((current) => expenseEnvelopeAfterSplitCancel(current, accObj?.automaticEnvelopeId));
              setSplitMode(false);
            }}
            onEnterSplit={enterSplit}
            envOpen={envOpen}
            envGridList={envGridList}
            envelopeId={envelopeId}
            env={env}
            envPreviewText={envPreviewText}
            automaticEnvelopeDefault={expenseEnvelope.provenance === "automatic" && envelopeId !== null}
            onOpenEnvSheet={() => setShowEnv(true)}
            onPickEnvelope={(id) => {
              setExpenseEnvelope(explicitExpenseEnvelopeSelection(id));
              setEnvOpen(false);
            }}
            onExpandEnvGrid={() => setEnvOpen(true)}
            catOpen={catOpen}
            catList={catList}
            categoryId={categoryId}
            catInput={catInput}
            filteredCats={filteredCats}
            categories={state.categories}
            onOpenCat={() => setCatOpen(true)}
            onToggleCategory={(id) => {
              setCategoryId(categoryId === id ? null : id);
              setCatOpen(false);
            }}
            onCatInputChange={setCatInput}
            onPickCategory={(id) => {
              setCategoryId(id);
              setCatInput("");
              setCatOpen(false);
            }}
            onCreateCategory={() => {
              const c = local.createCategory(catInput);
              setCategoryId(c.id);
              setCatInput("");
              setCatOpen(false);
            }}
            placeList={placeList}
            places={state.places}
            placeId={placeId}
            placeInput={placeInput}
            showPlace={showPlace}
            placeAutoFocus={placeAutoFocus}
            filteredPlaces={filteredPlaces}
            onTogglePlaceChip={(id) => {
              if (placeId === id) setPlaceId(null);
              else {
                setPlaceId(id);
                setPlaceInput("");
                setShowPlace(false);
              }
            }}
            onTogglePlaceInput={() => {
              const next = !showPlace;
              setShowPlace(next);
              setPlaceAutoFocus(next);
            }}
            onPlaceInputChange={(value) => {
              setPlaceInput(value);
              setPlaceId(null);
            }}
            onClearPlace={() => {
              setPlaceId(null);
              setPlaceInput("");
            }}
            onPickPlace={(id) => {
              setPlaceId(id);
              setPlaceInput("");
            }}
            onCreatePlace={() => {
              const p = local.createPlace(placeInput);
              setPlaceId(p.id);
              setPlaceInput("");
            }}
            onFieldFocus={() => setNumpad(false)}
          />
        ) : automaticEffect ? (
          <AutomaticEnvelopeEffect data={automaticEffect} />
        ) : null}
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
          const automaticEnvelopeId = accounts.find((account) => account.id === id)?.automaticEnvelopeId;
          setExpenseEnvelope((current) => expenseEnvelopeAfterAccountChange(current, automaticEnvelopeId, splitMode));
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
      {!draft && importOpened && (
        <LazyChunk variant="overlay" onDismiss={() => setShowImport(false)}>
          <ImportSheet show={showImport} onClose={() => setShowImport(false)} state={state} onApplied={onDone} />
        </LazyChunk>
      )}
      <EnvelopePickerSheet
        show={showEnv}
        onClose={() => setShowEnv(false)}
        envelopes={state.envelopes}
        groups={state.groups}
        onSelect={(id) => {
          setExpenseEnvelope(explicitExpenseEnvelopeSelection(id));
          setEnvOpen(false);
          setShowEnv(false);
        }}
      />
    </div>
  );
}
