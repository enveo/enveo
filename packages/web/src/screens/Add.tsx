import { captureAllocationFlow, computeStateResponse, isCalendarDate, resolveAllocationFlow, type Transaction, type TxnPayload } from "@enveo/shared";
import { lazy, useEffect, useMemo, useRef, useState } from "react";
import { useBand } from "../components/kit";
import { LazyChunk, useOpenedOnce } from "../components/lazy";
import { Numpad } from "../components/pickers";
import { hasOpenOp, keyboardPadKey, type PadState, padKey } from "../lib/amount";
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
import { currentMonth, dayMonth, shiftDay, todayISO } from "../lib/dates";
import { evalExpression } from "../lib/format";
import { haptic } from "../lib/haptics";
import { type Message, msg, useT } from "../lib/i18n";
import { preferredAccountId, setLastAccountId } from "../lib/lastAccount";
import { local, type TxnFlowOptions, txnToDuplicatePayload } from "../lib/mutate";
import { useWideHost } from "../lib/shellContext";
import { store } from "../lib/store";
import { rankPlaces, withSelectedFirst } from "../lib/suggest";
import { P, tint } from "../lib/theme";

import { AccountPickerSheet, DestinationAccountSheet } from "./add/AccountPickerSheet";
import { AddHeader } from "./add/AddHeader";
import { AmountSection } from "./add/AmountSection";
import { AutomaticEnvelopeEffect } from "./add/AutomaticEnvelopeEffect";
import { ChipPicker } from "./add/ChipPicker";
import { DateSheet } from "./add/DateSheet";
import { EnvelopePickerSheet } from "./add/EnvelopePickerSheet";
import { FlowCard, type FlowEndpoint } from "./add/FlowCard";
import { TransactionFields } from "./add/TransactionFields";
import type { AddDraft, Tab } from "./add/types";

export type { AddDraft, Tab } from "./add/types";

// Screenshot import is the app's one AI-only surface (§3f): the review sheet, the AI dispatch
// and the response parsers it pulls in serve a path most sessions never open, while manual
// transaction entry — everything else on this screen — stays eager. The chunk is fetched the
// first time the sheet is opened and then stays mounted, exactly as it was before.
const ImportSheet = lazy(() => import("../components/ImportSheet").then((m) => ({ default: m.ImportSheet })));

/** Top `take` of `ranked`, but guaranteed to include `pinnedId` (prepended, bumping the tail)
 *  when it exists in `ranked` and would otherwise fall outside the slice — a selection made via
 *  the full list must stay visible when the chips come back. */
function withPinned<T extends { id: string }>(ranked: T[], pinnedId: string | null, take: number): T[] {
  const base = ranked.slice(0, take);
  if (pinnedId != null && !base.some((x) => x.id === pinnedId)) {
    const pinned = ranked.find((x) => x.id === pinnedId);
    if (pinned) return [pinned, ...base.slice(0, take - 1)];
  }
  return base;
}

/** Minor units → the pad's canonical expression ("1234,50"). */
const padExpr = (minor: number): string => (minor / 100).toFixed(2).replace(".", ",");

export function AddScreen({
  state,
  onDone,
  editTxn,
  draft,
  initialTab,
  initialImport,
  duplicateFrom,
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
  /** Design parity wave C task 3, owner rule 2 (the wide txn panel's Duplicate pill): seeds the
   *  form as a NEW transaction — `editTxn` stays null, so this is a create, never an update — from
   *  an existing one, via the SAME transform `local.duplicateTxn`'s phone-only instant copy uses
   *  (`txnToDuplicatePayload`: today's date, no tag/sourceRef, allocation ids cleared, orphaned-
   *  split handling) instead of writing to the ledger directly. */
  duplicateFrom?: Transaction | null;
}) {
  const C = useTheme();
  const M = useMask();
  const { band } = useBand();
  const { t, lang } = useT();
  const wideHost = useWideHost();
  const ledgerVersion = useLedgerVersion();
  // Accounts are CURRENT-balance always — never scoped to the viewed month (unlike envelopes).
  // Recomputed from the replica at `currentMonth()` regardless of which month `state` was built
  // for, so every account display in this screen (flow card, pickers) shows the same balance as
  // the Start screen and Accounts screen — same pattern as chrome.tsx's Drawer.
  const accountsNow = useMemo(() => {
    const l = store.getLedger();
    return l ? computeStateResponse(l, currentMonth()).accounts : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerVersion]);
  const accounts = [...accountsNow].filter((a) => !a.archived).sort((a, b) => a.sort - b.sort);

  const [typeChosen, setTypeChosen] = useState(!draft || !!draft.initial || draft.item.type !== null);
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
        : expenseEnvelopeSelectionForImport(draft.item.type ?? "expense", draft.item.envelopeId, automaticEnvelopeId);
    return expenseEnvelopeSelection(automaticEnvelopeId);
  });
  const envelopeId = expenseEnvelope.envelopeId;
  const [items, setItems] = useState<Array<{ envelopeId: string; amount: number }>>([]);
  // Which split row the numpad is editing (null = the hero amount). Its own pad state, so a
  // row keeps the full expression machine (reductions, ⌫, one comma) the total has.
  const [activeSplit, setActiveSplit] = useState<number | null>(null);
  const [splitPad, setSplitPad] = useState<PadState>({ expr: "", fresh: true });
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [catInput, setCatInput] = useState("");
  const [catOpen, setCatOpen] = useState(false);
  const [name, setName] = useState("");
  const [placeId, setPlaceId] = useState<string | null>(null);
  const [placeInput, setPlaceInput] = useState("");
  const [placeOpen, setPlaceOpen] = useState(false);
  const [note, setNote] = useState("");
  // Transfer only: the human can skip the account-linked envelope leg for THIS transaction (the
  // money was already assigned by hand). `touched` separates "left alone" — which must keep the
  // stored flow verbatim on an edit — from "re-ticked", which has to capture the links again.
  const [skipAllocation, setSkipAllocation] = useState(false);
  const [allocationTouched, setAllocationTouched] = useState(false);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [numpad, setNumpad] = useState(true);

  const [showAcc, setShowAcc] = useState(false);
  const [showTo, setShowTo] = useState(false);
  const [showDate, setShowDate] = useState(false);
  // "target" picks the expense envelope; "split" appends a row to the split.
  const [showEnv, setShowEnv] = useState<null | "target" | "split">(null);
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
    setAmount(padExpr(editTxn.amount));
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
    setDate(editTxn.date);
    // A stored transfer that carries NO flow although its route is linked was saved opted out —
    // the switch has to open in that state, or re-saving would quietly restore the envelope leg.
    const linked = captureAllocationFlow(accounts, editTxn);
    setSkipAllocation(
      editTxn.type === "transfer" &&
        (linked.allocationFromEnvelopeId !== null || linked.allocationToEnvelopeId !== null) &&
        editTxn.allocationFromEnvelopeId === null &&
        editTxn.allocationToEnvelopeId === null,
    );
    setAllocationTouched(false);
  }, [editTxn]);

  // Duplicate prefill (design parity wave C task 3, owner rule 2): `editTxn` stays null throughout
  // (App.tsx's `duplicateTxnFromPanel`), so submit()'s existing `editTxn ? update : create` branch
  // already does the right thing on an explicit Save — this effect only ever seeds the FORM.
  useEffect(() => {
    if (!duplicateFrom) return;
    const p = txnToDuplicatePayload(duplicateFrom, todayISO());
    setTab(p.type);
    setAmount(padExpr(p.amount));
    setAccountId(p.accountId);
    if (p.toAccountId) setToAccountId(p.toAccountId);
    setIsRefund(p.isRefund ?? false);
    setExpenseEnvelope(explicitExpenseEnvelopeSelection(p.envelopeId ?? null));
    setItems((p.items ?? []).map((i) => ({ envelopeId: i.envelopeId, amount: i.amount })));
    setSplitMode(!!p.items?.length);
    setCategoryId(p.categoryId ?? null);
    setPlaceId(p.placeId ?? null);
    setName(p.name ?? "");
    setNote(p.note ?? "");
    setDate(p.date);
  }, [duplicateFrom]);

  // Draft-mode prefill: from corrections (initial — returning to the edit) or from a
  // recognized import item. ONLY on mount — the draft object is often created inline
  // by the parent and must not overwrite typed values on re-renders.
  useEffect(() => {
    if (!draft) return;
    const e = draft.initial;
    if (e) {
      setTab(e.type);
      setAmount(padExpr(e.amount));
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
      setDate(isCalendarDate(e.date) ? e.date : "");
    } else {
      const it = draft.item;
      setTab(it.type ?? "expense");
      setAmount(it.amount === null ? "" : padExpr(it.amount));
      setAccountId(draft.accountId);
      if (it.toAccountId) setToAccountId(it.toAccountId); // reviewed recognition candidate
      setIsRefund(it.type === "expense" && !!it.isRefund);
      const automaticEnvelopeId = accounts.find((account) => account.id === draft.accountId)?.automaticEnvelopeId;
      setExpenseEnvelope(
        draft.automaticEnvelopeDefault
          ? expenseEnvelopeSelection(automaticEnvelopeId)
          : expenseEnvelopeSelectionForImport(it.type ?? "expense", it.envelopeId, automaticEnvelopeId),
      );
      setCategoryId(it.categoryId ?? null);
      setName(it.name);
      prefillPlace(it.placeName ?? null);
      setDate(isCalendarDate(it.date) ? it.date : "");
    }
    setNumpad(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A place from import is a NAME (no ID) — if a 1:1 match exists, we attach the ID
  // (the chip row shows it selected); otherwise the text stays in the search field, from
  // which draft mode submits it by name.
  function prefillPlace(placeName: string | null) {
    if (!placeName) return;
    const match = state.places.find((p) => p.name.toLowerCase() === placeName.toLowerCase());
    if (match) setPlaceId(match.id);
    else {
      setPlaceInput(placeName);
      setPlaceOpen(true);
    }
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
    return rankCategories(
      state.categories.filter((c) => !c.archived),
      counts,
    );
  }, [ledgerVersion, envelopeId, items, state.categories]);
  const filteredCats = catInput ? rankedCats.filter((c) => c.name.toLowerCase().includes(catInput.toLowerCase())) : rankedCats;

  const minor = evalExpression(amount) ?? 0;
  const splitSum = items.reduce((s, i) => s + i.amount, 0);
  const splitUi = tab === "expense" && splitMode;
  const editingSplitRow = splitUi && activeSplit !== null;
  const padExprInFocus = editingSplitRow ? splitPad.expr : amount;

  /** One numpad key — routed to the focused split row, otherwise to the hero amount. */
  const press = (k: string) => {
    const key = k === "DEL" ? "⌫" : k;
    if (editingSplitRow) {
      const next = padKey(splitPad, key);
      setSplitPad(next);
      const value = Math.max(0, evalExpression(next.expr) ?? 0);
      setItems(items.map((it, i) => (i === activeSplit ? { ...it, amount: value } : it)));
      return;
    }
    setPad((p) => padKey(p, key));
  };
  const openHeroPad = () => {
    setActiveSplit(null);
    setNumpad(true);
  };
  const closePad = () => {
    setNumpad(false);
    setActiveSplit(null);
  };

  // scroll the amount field to the end (cursor visible) for a long expression
  const amtRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = amtRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [amount]);

  /* ── Physical-keyboard amount entry, WIDE ONLY (owner round 5 item 26) ─────────────────────
     `wideHost` is null on phone, so NO listener is ever attached there — touch behavior is
     byte-identical. Every accepted key routes through the SAME `press` → `padKey` machine the
     on-screen pad drives (`keyboardPadKey` is a pure key map, never a second parser), so the
     hero amount and a focused split row behave exactly as if their pad cells were tapped. */
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** The keyboard's ⏎ = the pad's contextual OK with "save" in place of "close": an open A⊕B
   *  reduces first (`=`), otherwise the CTA's own guarded save runs (`submit` checks `canSubmit`
   *  itself — the same guard as the button). Shared by the document listener below and the
   *  amount surface's own Enter (AmountSection `onConfirm`) so the two can never disagree. */
  const confirmFromKeyboard = () => {
    if (hasOpenOp(padExprInFocus)) press("=");
    else submit();
  };
  // Opening the Add pane IS the explicit user action (the autofocus rule), so the pane instance
  // moves focus to the amount surface on mount: the first keystroke lands in the pad machine and
  // ⏎ cannot re-activate whichever button opened the pane (focus would otherwise still sit on
  // it, and a button's native Enter activation is deliberately left alone below). Phone (no
  // host) and the ImportSheet draft editor keep their own focus order.
  useEffect(() => {
    if (!wideHost || draft) return;
    rootRef.current?.querySelector<HTMLElement>("[data-amount-surface]")?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Attached on `document` and re-attached every render (WideShell's Escape listener pattern —
  // one cheap listener, always-fresh closures). Guards, in order:
  //  - modifier chords (Ctrl/Meta/Alt) stay the browser's; `defaultPrevented` = an inner handler
  //    (the amount surface's own Enter) already took the event;
  //  - any of this screen's sheets/menus open → the amount is not the frontmost surface, keys
  //    must not edit it invisibly;
  //  - an editable element (input/textarea/select/contenteditable) keeps its keystrokes — the
  //    "do not steal keys" rule; Enter additionally leaves interactive elements (buttons, links)
  //    to their native activation.
  // Escape defers to WideShell's own document-level handler whenever focus sits inside the panel
  // (its `panelContains` gate) — both would otherwise run `doneEdit`, whose `history.back()` is
  // not idempotent; with focus OUTSIDE the panel that handler never fires, so this one covers
  // exactly the gap it leaves.
  useEffect(() => {
    if (!wideHost || draft) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (showAcc || showTo || showDate || showEnv !== null || showImport || showTxnMenu) return;
      const el = e.target instanceof Element ? e.target : null;
      const editable =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (editable) return;
      if (e.key === "Escape") {
        if (el?.closest("[data-wide-panel], [data-wide-panel-portal]")) return; // WideShell's Escape closes the pane (same doneEdit)
        e.preventDefault();
        onDone();
        return;
      }
      if (e.key === "Enter") {
        if (el?.closest("button, a[href], summary, [role='button']")) return; // native activation wins (the amount surface handles its own Enter)
        e.preventDefault();
        confirmFromKeyboard();
        return;
      }
      if (e.key === "=") {
        // "=" mirrors the pad's OK only in its reduce half — it never saves (that is ⏎'s job).
        if (hasOpenOp(padExprInFocus)) {
          e.preventDefault();
          press("=");
        }
        return;
      }
      const k = keyboardPadKey(e.key);
      if (k === null) return;
      e.preventDefault();
      press(k);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  const reset = (nextTab: Tab) => {
    const automaticEnvelopeId = accounts.find((account) => account.id === accountId)?.automaticEnvelopeId;
    setExpenseEnvelope(nextTab === "expense" && !editTxn && !draft ? expenseEnvelopeSelection(automaticEnvelopeId) : explicitExpenseEnvelopeSelection(null));
    setItems([]);
    setSplitMode(false);
    setActiveSplit(null);
    setSkipAllocation(false);
    setAllocationTouched(false);
    setCategoryId(null);
    setCatInput("");
    setCatOpen(false);
  };

  // entering split: the selected envelope becomes the first row with the whole amount
  const enterSplit = () => {
    if (items.length === 0 && env) setItems([{ envelopeId: env.id, amount: minor }]);
    setSplitMode(true);
    setActiveSplit(null);
    setNumpad(false);
  };
  const focusSplitRow = (index: number) => {
    setActiveSplit(index);
    setSplitPad({ expr: padExpr(items[index]?.amount ?? 0), fresh: true });
    setNumpad(true);
  };
  /** "assign the rest ›" — the gap goes to the focused row, or to the last one. */
  const assignRest = () => {
    const index = activeSplit ?? items.length - 1;
    if (index < 0) return;
    const next = Math.max(0, (items[index]?.amount ?? 0) + (minor - splitSum));
    setItems(items.map((it, i) => (i === index ? { ...it, amount: next } : it)));
    if (activeSplit === index) setSplitPad({ expr: padExpr(next), fresh: true });
  };
  const removeSplitRow = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
    setActiveSplit(null);
  };

  const submitLabel: Message =
    tab === "expense" ? (isRefund ? msg("Add refund") : msg("Add expense")) : tab === "income" ? msg("Add income") : msg("Add transfer");

  // empty-state backstop: without an account there is nothing to save a transaction on
  const noAccount = accounts.length === 0;
  // A split must add up: the rows ARE the transaction, so an unassigned remainder (or an
  // excess) would silently change the amount that was typed. The CTA names the gap instead.
  const splitBalanced = !splitUi || (items.length > 0 && splitSum === minor);
  const canSubmit = Number.isSafeInteger(minor) && minor > 0 && isCalendarDate(date) && typeChosen && !noAccount && splitBalanced;

  // fully synchronous save: local mirror immediately, network in the background (outbox)
  function submit() {
    if (!canSubmit) return;
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
    const usingSplit = splitUi && items.length > 0;
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
    // undefined unless the transfer switch is on screen: every other path keeps the historical
    // capture/preserve behaviour (see TxnFlowOptions).
    const flowOptions: TxnFlowOptions | undefined = allocationApplies
      ? { skipAutomaticAllocation: skipAllocation ? true : allocationTouched ? false : undefined }
      : undefined;
    if (editTxn) local.updateTxn(editTxn.id, payload, flowOptions);
    else local.createTxn(payload, flowOptions);
    haptic([10, 30, 14]);
    onDone();
  }

  // Date row in the flow card: Today/Yesterday carry the day+month as a quiet second line,
  // any other date leads with the day+month and keeps the year beside it.
  const todayIso = todayISO();
  const isToday = date === todayIso;
  const isYesterday = !isToday && date === shiftDay(todayIso, -1);
  const dayMonthLabel = isCalendarDate(date) ? dayMonth(date, lang) : t("Choose a date");
  const dateLabel = isToday ? t("Today") : isYesterday ? t("Yesterday") : dayMonthLabel;
  const dateHint = isToday || isYesterday ? dayMonthLabel : date.slice(0, 4);

  // Local suggestion rankings (lib/suggest.ts) — pure, no I/O; recomputed on every render (cheap
  // for a personal ledger).
  const ledgerNow = store.getLedger();
  const placeScopeEnv = envelopeId ?? items[0]?.envelopeId ?? null;
  // Hiding an entry takes it out of ENTRY only: suggestions, search and chips. Everything that
  // DESCRIBES existing data (transaction rows, reports, an active filter) keeps showing it.
  const activePlaces = state.places.filter((p) => !p.archived);
  const rankedPlaceObjs = ledgerNow
    ? rankPlaces(ledgerNow, placeScopeEnv, categoryId)
        .map((id) => activePlaces.find((p) => p.id === id))
        .filter((p): p is NonNullable<typeof p> => !!p)
    : [];
  const filteredPlaces = placeInput ? activePlaces.filter((p) => p.name.toLowerCase().includes(placeInput.toLowerCase())) : activePlaces;

  const catList = withPinned(rankedCats, categoryId, 4);
  // Dedupe is by NAME, so typing the name of a hidden entry would reuse that row and leave it
  // hidden. Offer the restore explicitly instead (the create button is already suppressed by the
  // exact-name check, which deliberately looks at hidden entries too).
  const hiddenCatMatch = catInput.trim() ? state.categories.find((c) => c.archived && c.name.toLowerCase() === catInput.trim().toLowerCase()) : undefined;
  const hiddenPlaceMatch = placeInput.trim() ? state.places.find((p) => p.archived && p.name.toLowerCase() === placeInput.trim().toLowerCase()) : undefined;
  // Unlike `rankCategories` (which sorts the FULL list), `rankPlaces` ranks from transaction
  // history, so the selection has to be seeded into the pool or the chip row shows nothing.
  const placeList = withPinned(withSelectedFirst(rankedPlaceObjs, placeId ? state.places.find((p) => p.id === placeId) : null), placeId, 4);

  /* ------------------------------ the flow card ------------------------------ */

  // "Before" must be the world WITHOUT this transaction: while EDITING, the replica already
  // contains its effect, so `balance − amount` would deduct it a second time (a saved 100
  // would preview 7900 → 7800). Recomputed from the replica with the edited row filtered out —
  // exact by construction for splits, transfers and automatic-envelope allocations alike.
  // Accounts are current-balance, envelopes are scoped to the month `state` was built for.
  const editBaseline = useMemo(() => {
    if (!editTxn) return null;
    const ledger = store.getLedger();
    if (!ledger) return null;
    const without = { ...ledger, transactions: ledger.transactions.filter((txn) => txn.id !== editTxn.id) };
    return {
      accounts: computeStateResponse(without, currentMonth()).accounts,
      envelopes: computeStateResponse(without, state.month).envelopes,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerVersion, editTxn, state.month]);
  const balanceBefore = (id: string | undefined, live: number) =>
    editBaseline && id ? (editBaseline.accounts.find((a) => a.id === id)?.balance ?? live) : live;
  const availableBefore = (id: string | undefined, live: number) =>
    editBaseline && id ? (editBaseline.envelopes.find((e) => e.id === id)?.available ?? live) : live;
  /** Envelope list carrying the same "before" availability (split rows read it too). */
  const previewEnvelopes = editBaseline ? state.envelopes.map((e) => ({ ...e, available: availableBefore(e.id, e.available) })) : state.envelopes;

  const accountBalance = balanceBefore(accountId, accObj?.balance ?? 0);
  const accountAfter = accountBalance + (tab === "transfer" ? -minor : plus ? minor : -minor);
  const envBefore = availableBefore(env?.id, env?.available ?? 0);
  const envAfter = envBefore + (plus ? minor : -minor);
  const destBalance = balanceBefore(toAcc?.id, toAcc?.balance ?? 0);
  // Automatic envelopes (account → envelope link) decide where income actually LANDS: the ledger
  // allocates it into the linked envelope, so it never reaches Ready to assign. Resolved through
  // the shared rule (edit-aware, on-budget only) instead of reading automaticEnvelopeId here, so
  // the card can never disagree with what gets written.
  const allocationFlow = resolveAllocationFlow(accounts, { type: tab, accountId, toAccountId: tab === "transfer" ? toAccountId : null }, editTxn);
  const incomeEnvelope = tab === "income" && allocationFlow.allocationToEnvelopeId ? envById.get(allocationFlow.allocationToEnvelopeId) : null;
  const incomeEnvelopeBefore = availableBefore(incomeEnvelope?.id, incomeEnvelope?.available ?? 0);
  const source: FlowEndpoint = {
    role: tab === "income" ? t("To account") : t("From account"),
    name: accObj?.name ?? t("Choose an account"),
    color: accObj?.color ?? C.mute,
    icon: accObj?.icon ?? "wallet",
    before: accountBalance,
    after: accountAfter,
    // Neutral "after" amounts are plain text, NOT the accent: the pill sits on an entity-tinted
    // fill, and on Duet dark the accent measured 3.1:1 against an envelope's own tint (below AA).
    afterColor: accountAfter < 0 ? C.neg : tab === "income" ? C.pos : C.text,
    hint: tab === "income" ? t("balance after the deposit") : tab === "expense" && isRefund ? t("balance after the refund") : t("left after this"),
    pillTint: "var(--accent-18)",
    onOpen: () => {
      setShowAcc(true);
      setNumpad(false);
    },
    placeholder: !accObj,
  };
  const target: FlowEndpoint | null =
    tab === "transfer"
      ? {
          role: t("To account"),
          name: toAcc?.name ?? t("Destination account"),
          color: toAcc?.color ?? C.mute,
          icon: toAcc?.icon ?? "wallet",
          before: destBalance,
          after: destBalance + minor,
          afterColor: C.pos,
          hint: t("balance after the deposit"),
          pillTint: tint(toAcc?.color ?? C.mute, 0.22),
          onOpen: () => {
            setShowTo(true);
            setNumpad(false);
          },
          placeholder: !toAcc,
        }
      : tab === "expense" && !splitUi
        ? {
            role: t("Envelope"),
            name: env?.name ?? t("Choose an envelope"),
            color: env?.color ?? C.mute,
            icon: env?.icon ?? "envelope",
            before: envBefore,
            after: envAfter,
            afterColor: envAfter < 0 ? C.neg : C.text,
            hint: plus ? t("back in the envelope") : envAfter < 0 ? t("over the envelope") : t("left in the envelope"),
            pillTint: tint(env?.color ?? C.mute, 0.22),
            onOpen: () => {
              setShowEnv("target");
              setNumpad(false);
            },
            placeholder: !env,
          }
        : incomeEnvelope
          ? {
              // Not tappable: income has no envelope PICK — the account's link decides.
              role: t("Goes to"),
              name: incomeEnvelope.name,
              color: incomeEnvelope.color,
              icon: incomeEnvelope.icon,
              before: incomeEnvelopeBefore,
              after: incomeEnvelopeBefore + minor,
              afterColor: C.pos,
              hint: t("balance after the deposit"),
              pillTint: tint(incomeEnvelope.color, 0.22),
            }
          : null;

  // Does the route touch a linked envelope at all? (transfer switch visibility)
  const linkedRoute = captureAllocationFlow(accounts, { type: tab, accountId, toAccountId: tab === "transfer" ? toAccountId : null });
  const allocationApplies = tab === "transfer" && (linkedRoute.allocationFromEnvelopeId !== null || linkedRoute.allocationToEnvelopeId !== null);
  const allocationSkipped = allocationApplies && skipAllocation;
  /** What the SWITCH promises must be what `prepareTxnUpdate` writes: re-ticking captures today's
   *  links (previous = null), leaving it alone preserves the stored flow (previous = editTxn). */
  const previewPrevious = allocationTouched ? null : editTxn;
  const automaticPreview = automaticEnvelopePreview(
    state,
    { type: tab, accountId, toAccountId: tab === "transfer" ? toAccountId : null },
    minor,
    previewPrevious,
  );
  const automaticEffect =
    !allocationSkipped && minor > 0 && (automaticPreview.rows.length > 0 || automaticPreview.neutral)
      ? formatAutomaticEnvelopeEffect(automaticPreview, M, {
          heading: t("Automatic envelope effect"),
          readyToAssign: t("Ready to assign"),
          noEnvelopeChange: t("No envelope change"),
          noChange: t("No change"),
        })
      : null;

  const namePlaceholder =
    tab === "income"
      ? t("e.g. paycheck, invoice")
      : tab === "transfer"
        ? t("e.g. transfer to savings")
        : isRefund
          ? t("e.g. refund for shoes")
          : placeId
            ? t("{place} — add details", { place: state.places.find((p) => p.id === placeId)?.name ?? "" })
            : t("e.g. weekly groceries");

  const header = (
    <AddHeader
      tab={typeChosen ? tab : null}
      isEdit={!!editTxn}
      isDraft={!!draft}
      menuOpen={showTxnMenu}
      onBack={draft ? draft.onCancel : onDone}
      onTabSelect={(tb) => {
        setTypeChosen(true);
        setTab(tb);
        reset(tb);
        setIsRefund(false);
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
  );
  if (!typeChosen)
    return (
      <div style={{ flex: 1 }}>
        {header}
        <div role="status" style={{ textAlign: "center", padding: 8, color: C.warn }}>
          {t("Choose a transaction type")}
        </div>
      </div>
    );

  return (
    <div ref={rootRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {header}
      <AmountSection
        tab={tab}
        isRefund={isRefund}
        plus={plus}
        amount={amount}
        numpadOpen={numpad}
        amtRef={amtRef}
        onOpenPad={openHeroPad}
        onToggleRefund={() => setIsRefund((v) => !v)}
        // Item 26, wide pane only: ⏎ on the focused amount surface confirms (reduce/save) instead
        // of merely re-opening the pad — the SAME function the document keydown handler runs.
        onConfirm={wideHost && !draft ? confirmFromKeyboard : undefined}
      />

      {/* EVERYTHING between the amount and the pad scrolls, the FlowCard included. A split with
          five envelopes makes that card taller than the screen, and while it sat OUTSIDE this
          container (unshrinkable, `flex: 0 0 auto`) it pushed the pad and the submit button past
          the bottom of the `100dvh` shell, where `overflow: hidden` clipped them with nothing left
          to scroll. The pad and the CTA below stay pinned; the middle gives way. */}
      <div className="gs" style={{ flex: 1, minHeight: 0, overflowY: "auto" }} onClick={closePad}>
        {/* The card lives inside the scroller now, so it would inherit its close-the-pad click.
            Tapping a split row's amount must OPEN the pad, not close it — the card handles its
            own taps and swallows the rest. */}
        <div onClick={(e) => e.stopPropagation()}>
          <FlowCard
            source={source}
            target={target}
            pool={
              tab === "income" && !incomeEnvelope
                ? { role: t("Goes to"), title: t("Ready to assign"), caption: t("you'll split it into envelopes in the budget") }
                : null
            }
            note={
              tab === "expense" && !splitUi && expenseEnvelope.provenance === "automatic" && envelopeId !== null
                ? t("Selected automatically from this account")
                : null
            }
            automatic={
              allocationApplies
                ? {
                    label: t("Move the money between envelopes too"),
                    checked: !skipAllocation,
                    onToggle: (checked) => {
                      setSkipAllocation(!checked);
                      setAllocationTouched(true);
                    },
                    body: allocationSkipped ? (
                      <div style={{ fontSize: 10.5, color: C.soft, padding: "4px 0 2px 23px" }}>
                        {t("Envelopes stay as they are — you assigned this by hand.")}
                      </div>
                    ) : automaticEffect ? (
                      <AutomaticEnvelopeEffect data={automaticEffect} compact />
                    ) : null,
                  }
                : null
            }
            split={
              splitUi
                ? {
                    label: t("Split across envelopes"),
                    items,
                    envelopes: previewEnvelopes,
                    total: minor,
                    plus,
                    activeIndex: activeSplit,
                    onFocusItem: focusSplitRow,
                    onRemoveItem: removeSplitRow,
                    onAddItem: () => {
                      setShowEnv("split");
                      setNumpad(false);
                    },
                    onAssignRest: assignRest,
                  }
                : null
            }
            amountMinor={minor}
            plus={plus}
            dateLabel={dateLabel}
            dateHint={dateHint}
            onOpenDate={() => {
              setShowDate(true);
              setNumpad(false);
            }}
            splitAction={
              draft || tab !== "expense"
                ? null
                : splitMode
                  ? {
                      label: t("cancel split"),
                      onClick: () => {
                        setExpenseEnvelope((current) => expenseEnvelopeAfterSplitCancel(current, accObj?.automaticEnvelopeId));
                        setSplitMode(false);
                        setActiveSplit(null);
                      },
                    }
                  : { label: `${t("Split across envelopes")} ›`, onClick: enterSplit }
            }
          />
        </div>

        {tab === "expense" && (
          <>
            {/* A split transaction carries no category (submit sends null for it) — offering the
                picker there would silently drop the pick. Place SURVIVES a split, so it stays. */}
            {!splitUi && (
              <ChipPicker
                label={t("Category")}
                chips={catList}
                matches={filteredCats}
                selectedId={categoryId}
                open={catOpen}
                query={catInput}
                searchPlaceholder={t("Type or pick a category...")}
                // category creation = local.createCategory — unavailable in draft (zero local.*)
                createLabel={
                  !draft && catInput.trim() && !state.categories.some((c) => c.name.toLowerCase() === catInput.trim().toLowerCase())
                    ? t("+ Add “{name}”", { name: catInput.trim() })
                    : null
                }
                // Collapsing KEEPS the query: throwing away what was typed made a half-finished
                // "add my own" look like the app had swallowed it.
                restoreLabel={hiddenCatMatch ? t("Restore “{name}” · hidden", { name: hiddenCatMatch.name }) : null}
                onRestore={() => {
                  if (!hiddenCatMatch) return;
                  local.setCategoryArchived(hiddenCatMatch.id, false);
                  setCategoryId(hiddenCatMatch.id);
                  setCatInput("");
                  setCatOpen(false);
                }}
                onToggleOpen={() => setCatOpen(!catOpen)}
                onQueryChange={setCatInput}
                onToggleChip={(id) => setCategoryId(categoryId === id ? null : id)}
                onPick={(id) => {
                  setCategoryId(id);
                  setCatInput("");
                  setCatOpen(false);
                }}
                onCreate={() => {
                  const c = local.createCategory(catInput.trim());
                  setCategoryId(c.id);
                  setCatInput("");
                  setCatOpen(false);
                }}
                onFieldFocus={closePad}
              />
            )}
            <ChipPicker
              label={t("Place")}
              chips={placeList}
              matches={filteredPlaces}
              selectedId={placeId}
              open={placeOpen}
              query={placeInput}
              searchPlaceholder={t("Type or pick a place...")}
              // in draft the place travels by NAME to local import planning (which creates/matches
              // it), so the typed text is the value there — no local.createPlace button
              createLabel={
                !draft && placeInput.trim() && !state.places.some((p) => p.name.toLowerCase() === placeInput.trim().toLowerCase())
                  ? t("+ Add “{name}”", { name: placeInput.trim() })
                  : null
              }
              restoreLabel={hiddenPlaceMatch ? t("Restore “{name}” · hidden", { name: hiddenPlaceMatch.name }) : null}
              onRestore={() => {
                if (!hiddenPlaceMatch) return;
                local.setPlaceArchived(hiddenPlaceMatch.id, false);
                setPlaceId(hiddenPlaceMatch.id);
                setPlaceInput("");
                setPlaceOpen(false);
              }}
              onToggleOpen={() => setPlaceOpen(!placeOpen)}
              onQueryChange={(value) => {
                setPlaceInput(value);
                setPlaceId(null);
              }}
              onToggleChip={(id) => setPlaceId(placeId === id ? null : id)}
              onPick={(id) => {
                setPlaceId(id);
                setPlaceInput("");
                setPlaceOpen(false);
              }}
              onCreate={() => {
                const p = local.createPlace(placeInput.trim());
                setPlaceId(p.id);
                setPlaceInput("");
                setPlaceOpen(false);
              }}
              onFieldFocus={closePad}
            />
          </>
        )}
        {/* Income keeps the effect panel here; a transfer shows it INSIDE the card, next to the
            switch that turns the envelope leg off. */}
        {tab === "income" && automaticEffect && <AutomaticEnvelopeEffect data={automaticEffect} />}

        <TransactionFields
          name={name}
          note={note}
          placeholder={namePlaceholder}
          onNameChange={setName}
          onFieldFocus={closePad}
          onClearNote={() => setNote("")}
        />
      </div>

      {/* Numpad above the CTA (board order: tgrow → numpad → cta2). Contextual OK like the
          docked pad: A⊕B → "=" (reduction, pad stays), otherwise ✓ closes the pad. */}
      {numpad && (
        <Numpad
          onKey={press}
          onOk={() => {
            if (hasOpenOp(padExprInFocus)) press("=");
            else closePad();
          }}
          okGlyph={hasOpenOp(padExprInFocus) ? "equals" : "check"}
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
          disabled={!canSubmit}
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
            opacity: canSubmit ? 1 : 0.4,
          }}
        >
          {splitUi && minor > 0 && splitSum !== minor
            ? splitSum < minor
              ? t("Remaining {amount}", { amount: M(minor - splitSum) })
              : t("Excess {amount}", { amount: M(splitSum - minor) })
            : draft
              ? t("Save item")
              : editTxn
                ? t("Save changes")
                : t(submitLabel)}
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
        show={showEnv !== null}
        onClose={() => setShowEnv(null)}
        envelopes={state.envelopes}
        groups={state.groups}
        title={showEnv === "split" ? t("Add an envelope to the split") : undefined}
        onSelect={(id) => {
          if (showEnv === "split") {
            setItems([...items, { envelopeId: id, amount: 0 }]);
            setActiveSplit(items.length);
            setSplitPad({ expr: "", fresh: true });
            setNumpad(true);
          } else {
            setExpenseEnvelope(explicitExpenseEnvelopeSelection(id));
          }
          setShowEnv(null);
        }}
      />
    </div>
  );
}
