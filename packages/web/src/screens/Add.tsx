import { useEffect, useMemo, useRef, useState } from "react";
import { type RecurrenceRule, type Transaction, type TxnPayload } from "@enveo/shared";
import { apiErrorMessage, useLedgerVersion, type EditedImportItem, type ImportItem, type QuickAddResponse, type StateResponse } from "../lib/api";
import { runQuickAdd as aiQuickAdd } from "../lib/ai";
import { hasOpenOp, padKey, type PadState } from "../lib/amount";
import { categoryCountsFor, rankCategories } from "../lib/categoryIndex";
import { preferredAccountId, setLastAccountId } from "../lib/lastAccount";
import { local } from "../lib/mutate";
import { store } from "../lib/store";
import { Sheet } from "../components/chrome";
import { AmountPadHost, type AmountPadTarget } from "../components/AmountPadSheet";
import { ImportSheet } from "../components/ImportSheet";
import { accountIconColor } from "../components/tiles";
import { Numpad, ScrollPicker } from "../components/pickers";
import { EnvTile } from "../components/tiles";
import { useCurrency, useSettings, useTheme } from "../lib/contexts";
import { haptic } from "../lib/haptics";
import { currencySymbol, evalExpression, formatMoney, isLight } from "../lib/format";
import { formatDateLong, monthNames } from "../lib/dates";
import { useT, type TKey } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { CORAL, CTA, INCOME, P, SAGE_BG, TEAL, TRANSFER, font } from "../lib/theme";

type Tab = "expense" | "income" | "transfer";
const RECUR: Array<{ label: TKey; rule: string }> = [
  { label: "add.recurNone", rule: "none" },
  { label: "add.recurWeekly", rule: "weekly" },
  { label: "add.recurMonthly", rule: "monthly" },
  { label: "add.recurMonthEnd", rule: "monthEnd" },
  { label: "add.recurQuarterly", rule: "quarterly" },
  { label: "add.recurYearly", rule: "yearly" },
];

/** Draft mode: import item editor — full AddScreen look, but submit does
 *  NOT save a transaction (zero local.*), it only hands an EditedImportItem
 *  back to ImportSheet (corrections go later through /import/apply). */
export interface AddDraft {
  item: ImportItem;
  accountId: string;
  initial?: EditedImportItem;
  onSave: (e: EditedImportItem) => void;
  onCancel: () => void;
}

export function AddScreen({ state, onDone, editTxn, draft }: { state: StateResponse; onDone: () => void; editTxn: Transaction | null; draft?: AddDraft }) {
  const C = useTheme();
  const { t, lang } = useT();
  const currency = useCurrency();
  const { settings } = useSettings();
  const accounts = [...state.accounts].filter((a) => !a.archived).sort((a, b) => a.sort - b.sort);

  const [tab, setTab] = useState<Tab>("expense");
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
  const [items, setItems] = useState<Array<{ envelopeId: string; amount: number }>>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [catInput, setCatInput] = useState("");
  const [catOpen, setCatOpen] = useState(false);
  const [name, setName] = useState("");
  const [placeId, setPlaceId] = useState<string | null>(null);
  const [placeInput, setPlaceInput] = useState("");
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [showPlace, setShowPlace] = useState(false);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [recur, setRecur] = useState("none");
  const [confirmed, setConfirmed] = useState(true);
  const [numpad, setNumpad] = useState(true);
  const [quick, setQuick] = useState("");
  const [quickBusy, setQuickBusy] = useState(false); // quick-add always calls the model now — it takes a moment
  const [quickErr, setQuickErr] = useState<string | null>(null);

  const [showAcc, setShowAcc] = useState(false);
  const [showTo, setShowTo] = useState(false);
  const [showDate, setShowDate] = useState(false);
  const [showRecur, setShowRecur] = useState(false);
  const [showEnv, setShowEnv] = useState(false);
  const [showImport, setShowImport] = useState(false);
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
    setShowNote(!!editTxn.note);
    setShowPlace(!!editTxn.placeId); // expand filled fields right away (no icon clicking)
    setDate(editTxn.date);
    setConfirmed(editTxn.confirmed);
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
      setShowNote(!!e.note);
      prefillPlace(e.placeName);
      setDate(e.date);
      setConfirmed(e.confirmed);
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
      setConfirmed(true);
    }
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

  const at = { expense: CORAL, income: INCOME, transfer: TRANSFER }[tab];
  const plus = tab === "income" || (tab === "expense" && isRefund);
  const accObj = accounts.find((a) => a.id === accountId);
  const envById = new Map(state.envelopes.map((e) => [e.id, e]));
  const env = envelopeId ? envById.get(envelopeId) : null;

  /* Categories sorted by co-occurrence with the SELECTED envelope (index
     memoized per replica version — zero scanning on each open);
     the text filter preserves the ranking within the matches. */
  const ledgerVersion = useLedgerVersion();
  const rankedCats = useMemo(() => {
    const ledger = store.getLedger();
    const forEnv = envelopeId ?? items[0]?.envelopeId ?? null;
    const counts = ledger ? categoryCountsFor(ledger, ledgerVersion, forEnv) : new Map<string, number>();
    return rankCategories(state.categories, counts);
  }, [ledgerVersion, envelopeId, items, state.categories]);
  const filteredCats = catInput ? rankedCats.filter((c) => c.name.toLowerCase().includes(catInput.toLowerCase())) : rankedCats;
  const filteredPlaces = placeInput ? state.places.filter((p) => p.name.toLowerCase().includes(placeInput.toLowerCase())) : [];

  const press = (k: string) => setPad((p) => padKey(p, k === "DEL" ? "⌫" : k));

  const reset = () => { setEnvelopeId(null); setItems([]); setSplitMode(false); setCategoryId(null); setCatInput(""); setCatOpen(false); };

  const minor = evalExpression(amount) ?? 0;
  // scroll the amount field to the end (cursor visible) for a long expression
  const amtRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { const el = amtRef.current; if (el) el.scrollLeft = el.scrollWidth; }, [amount]);
  const splitSum = items.reduce((s, i) => s + i.amount, 0);
  // entering split: the selected envelope becomes the first item with the whole amount
  const enterSplit = () => {
    if (items.length === 0 && env) setItems([{ envelopeId: env.id, amount: minor }]);
    setSplitMode(true);
  };
  const submitLabel: TKey =
    tab === "expense" ? (recur !== "none" ? "add.scheduleExpense" : isRefund ? "add.addRefund" : "add.addExpense")
      : tab === "income" ? (recur !== "none" ? "add.scheduleIncome" : "add.addIncome")
        : recur !== "none" ? "add.scheduleTransfer" : "add.addTransfer";

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
        envelopeId: tab === "transfer" ? null : envelopeId,
        categoryId: tab === "transfer" ? null : categoryId,
        placeName: placeId ? (state.places.find((p) => p.id === placeId)?.name ?? null) : placeInput.trim() || null,
        note,
        confirmed,
      });
      haptic([10, 30, 14]);
      return;
    }
    let recurrenceId: string | null = null;
    if (recur !== "none") {
      recurrenceId = local.createRecurrence({ rule: recur as RecurrenceRule, startDate: date });
    }
    const usingSplit = tab === "expense" && splitMode && items.length > 0;
    const payload: TxnPayload = {
      type: tab,
      accountId,
      toAccountId: tab === "transfer" ? toAccountId : null,
      amount: usingSplit ? splitSum : minor,
      date,
      confirmed,
      isRefund: tab === "expense" && isRefund,
      envelopeId: tab === "transfer" ? null : usingSplit ? null : envelopeId,
      placeId,
      categoryId: usingSplit ? null : categoryId,
      name: name.trim() || null,
      note: note || null,
      planned: recur !== "none",
      recurrenceId,
      items: usingSplit ? items.map((i) => ({ envelopeId: i.envelopeId, amount: i.amount })) : undefined,
    };
    if (editTxn) local.updateTxn(editTxn.id, payload);
    else local.createTxn(payload);
    haptic([10, 30, 14]);
    onDone();
  }

  const applyQuick = (r: QuickAddResponse) => {
    if (r.amount) setAmount((r.amount / 100).toFixed(2).replace(".", ","));
    setTab(r.type);
    setIsRefund(r.isRefund);
    if (r.envelopeId) setEnvelopeId(r.envelopeId);
    if (r.placeId) { setPlaceId(r.placeId); setShowPlace(true); }
    if (r.categoryId) setCategoryId(r.categoryId);
    if (r.note) setName(r.note); // leftover quick-add text = transaction name
    setDate(r.date);
    setNumpad(false);
  };

  /* Quick-add is AI-only (the rule parser is gone): the bar exists only in the
     server/byok modes, so there is nothing to fall back to — a failure (no operator
     key, upstream error, offline) is SHOWN instead of silently degrading. */
  const aiOn = settings.aiMode !== "off";
  async function execQuickAdd() {
    const text = quick.trim();
    const ledger = store.getLedger();
    if (!text || !ledger || quickBusy) return;
    setQuickBusy(true);
    setQuickErr(null);
    try {
      applyQuick(await aiQuickAdd({ text, locale: lang, ledger, settings }));
      setQuick("");
    } catch (e) {
      setQuickErr(apiErrorMessage(e));
    } finally {
      setQuickBusy(false);
    }
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
      {/* one header for create and edit: type tabs always (type editable);
          in edit, trash + kebab on the right instead of the alignment spacer */}
      <div style={{ display: "flex", alignItems: "center", padding: "8px 10px", gap: 6 }}>
        <button onClick={draft ? draft.onCancel : onDone} aria-label={t("add.back")} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
          <Ico d="M19 12H5m0 0l7 7m-7-7l7-7" size={18} />
        </button>
        <div style={{ display: "flex", background: C.bg, borderRadius: 14, padding: 2, flex: 1, border: `1px solid ${C.line}` }}>
          {(["expense", "income", "transfer"] as Tab[]).map((tb) => (
            <button key={tb} onClick={() => { setTab(tb); reset(); setIsRefund(false); }} style={{ flex: 1, padding: "8px 0", borderRadius: 11, border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", background: tab === tb ? { expense: CORAL, income: INCOME, transfer: TRANSFER }[tb] : "transparent", color: tab === tb ? "#fff" : C.soft }}>
              {t(({ expense: "add.tabExpense", income: "add.tabIncome", transfer: "add.tabTransfer" } as const)[tb])}
            </button>
          ))}
        </div>
        {editTxn ? (
          <>
            <button
              onClick={() => { if (window.confirm(t("txn.deleteConfirm"))) { local.deleteTxn(editTxn.id); onDone(); } }}
              aria-label={t("common.delete")}
              style={{ width: 34, height: 34, borderRadius: 10, border: "none", background: C.surface, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
            >
              {/* trash: lid + bucket */}
              <Ico d="M4 7h16M9 7V5a1 1 0 011-1h6a1 1 0 011 1v2m3 0l-.9 12.1A2 2 0 0115.1 21H8.9a2 2 0 01-2-1.9L6 7m4 4v6m4-6v6" size={17} color={CORAL} sw={2} />
            </button>
            <div style={{ position: "relative", flexShrink: 0 }}>
              <button
                onClick={() => setShowTxnMenu((v) => !v)}
                aria-label={t("txns.duplicate")}
                style={{ width: 34, height: 34, borderRadius: 10, border: "none", background: C.surface, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                {/* kebab: 3 dots */}
                <svg width="17" height="17" viewBox="0 0 24 24" fill={C.text}>
                  <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
                </svg>
              </button>
              {showTxnMenu && (
                <div style={{ position: "absolute", top: 38, right: 0, background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, boxShadow: "0 6px 18px rgba(0,0,0,0.16)", zIndex: 30, minWidth: 150, overflow: "hidden" }}>
                  <button
                    onClick={() => { setShowTxnMenu(false); local.duplicateTxn(editTxn); onDone(); }}
                    style={{ display: "block", width: "100%", padding: "11px 14px", background: "none", border: "none", color: C.text, fontSize: 13, fontWeight: 500, cursor: "pointer", textAlign: "left", fontFamily: font }}
                  >
                    {t("txns.duplicate")}
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <div style={{ width: 26 }} />
        )}
      </div>

      {draft && (
        <div style={{ textAlign: "center", fontSize: 12, fontWeight: 600, color: C.soft, padding: "0 10px 4px" }}>{t("import.editTitle")}</div>
      )}

      {/* Smart Quick-Add (AI-only) — hidden in edit and in draft mode (import item editor).
          With AI off there is no rules path left: one line points at Settings instead. */}
      {!editTxn && !draft && (aiOn ? (
        <div style={{ margin: `2px ${P}px 4px`, display: "flex", gap: 6, alignItems: "center" }}>
          <input
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && execQuickAdd()}
            onFocus={() => setNumpad(false)}
            placeholder={t("add.quickPlaceholder")}
            style={{ flex: 1, padding: "9px 12px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.bg, color: C.text, fontSize: 12, fontFamily: font, outline: "none" }}
          />
          <button onClick={execQuickAdd} disabled={quickBusy} aria-label={t("add.quickRunAria")} style={{ padding: "9px 12px", borderRadius: 10, border: "none", background: CTA, color: "#fff", fontSize: 12, fontWeight: 600, cursor: quickBusy ? "default" : "pointer", opacity: quickBusy ? 0.5 : 1 }}>✨</button>
        </div>
      ) : (
        <div style={{ margin: `2px ${P}px 6px`, fontSize: 11.5, color: C.mute, lineHeight: 1.45 }}>{t("add.quickNeedsAi")}</div>
      ))}
      {!editTxn && !draft && quickErr && (
        <div style={{ margin: `0 ${P}px 4px`, fontSize: 11.5, color: CORAL }}>{quickErr}</div>
      )}

      <button onClick={() => setNumpad(true)} style={{ margin: `4px ${P}px 10px`, padding: "12px 14px", background: C.bg, borderRadius: 12, border: `1px solid ${C.line}`, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <button onClick={(e) => { e.stopPropagation(); setShowAcc(true); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            <Glyph name={accObj?.icon ?? "wallet"} size={20} color={C.soft} />
            <span style={{ fontSize: 10, color: C.soft, fontWeight: 500, maxWidth: 76, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{accObj?.name ?? t("add.account")}</span>
          </button>
          {tab === "expense" && (
            <>
              <div style={{ width: 1, height: 30, background: C.line }} />
              <button onClick={(e) => { e.stopPropagation(); setIsRefund(!isRefund); }} aria-label={t("add.refundToggle")} style={{ position: "relative", width: 52, height: 28, borderRadius: 15, border: "none", cursor: "pointer", background: C.line, padding: 0, flexShrink: 0 }}>
                <span style={{ position: "absolute", top: 2, left: 2, width: 24, height: 24, borderRadius: 8, background: isRefund ? INCOME : CORAL, color: "#fff", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", transform: isRefund ? "translateX(24px)" : "translateX(0)", transition: "transform .15s" }}>{isRefund ? "+" : "−"}</span>
              </button>
            </>
          )}
        </div>
        {/* right side as a column: [scrollable amount + currency] above [live result].
            minWidth:0 lets a long expression scroll instead of pushing out the currency/result. */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
          <div style={{ display: "flex", alignItems: "center", maxWidth: "100%" }}>
            <div ref={amtRef} className="gs" style={{ overflowX: "auto", whiteSpace: "nowrap", minWidth: 0, display: "flex", alignItems: "center" }}>
              <span style={{ fontSize: 30, fontWeight: 700, color: plus ? INCOME : C.text, fontVariantNumeric: "tabular-nums" }}>{amount || "0"}</span>
              {numpad && <div style={{ width: 2, height: 24, background: TEAL, borderRadius: 1, marginLeft: 2, flexShrink: 0, animation: "fi .6s ease-in-out infinite alternate" }} />}
            </div>
            <span style={{ fontSize: 15, color: C.soft, alignSelf: "flex-end", paddingBottom: 3, marginLeft: 4, flexShrink: 0 }}>{currencySymbol(currency, lang)}</span>
          </div>
        </div>
      </button>

      <div className="gs" style={{ flex: 1, overflowY: "auto", padding: `0 ${P}px` }} onClick={() => setNumpad(false)}>
        {tab === "expense" && !splitMode && !env && (
          <button onClick={() => setShowEnv(true)} style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "4px 0 12px", background: "none", border: "none", cursor: "pointer" }}>
            <div style={{ width: 54, height: 40, borderRadius: 9, background: C.bg, border: `1.3px dashed ${C.line}`, display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box" }}>
              <span style={{ fontSize: 16, color: C.mute }}>?</span>
            </div>
            <span style={{ fontSize: 14, color: C.mute }}>{t("add.pickEnvelope")}</span>
            <span style={{ flex: 1 }} />
            {!draft && <span onClick={(e) => { e.stopPropagation(); enterSplit(); }} style={{ fontSize: 11, color: TEAL, fontWeight: 600 }}>{t("add.split")}</span>}
          </button>
        )}
        {tab === "expense" && !splitMode && env && (
          <div style={{ padding: "2px 0 10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button onClick={() => setShowEnv(true)} style={{ display: "flex", alignItems: "center", gap: 11, background: "none", border: "none", cursor: "pointer", padding: 0, minWidth: 0 }}>
                <MiniEnv color={env.color} icon={env.icon} />
                <span style={{ fontSize: 15.5, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{env.name}</span>
              </button>
              <span style={{ flex: 1 }} />
              {!draft && <button onClick={enterSplit} style={{ background: "none", border: "none", color: TEAL, fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>{t("add.split")}</button>}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
              {categoryId ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 11px", borderRadius: 17, background: C.bg, border: `1px solid ${C.line}`, flexShrink: 0, maxWidth: "60%" }}>
                  <Glyph name="tag" size={13} color={C.soft} />
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{state.categories.find((c) => c.id === categoryId)?.name}</span>
                  <button onClick={() => setCategoryId(null)} aria-label={t("add.removeCategoryAria")} style={{ background: "none", border: "none", cursor: "pointer", padding: 1, display: "flex", flexShrink: 0 }}>
                    <Ico d="M6 6l12 12M18 6L6 18" size={12} color={C.mute} sw={2} />
                  </button>
                </div>
              ) : (
                <button onClick={() => { setCatOpen(!catOpen); setNumpad(false); }} style={{ padding: "6px 11px", borderRadius: 17, background: "none", border: `1.3px dashed ${C.line}`, color: C.mute, fontSize: 12.5, fontWeight: 600, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>
                  {t("add.addCategory")}
                </button>
              )}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onFocus={() => setNumpad(false)}
                placeholder={t("add.namePlaceholder")}
                style={{ flex: 1, minWidth: 0, background: "none", border: "none", borderBottom: `1px solid ${C.line}`, color: C.text, fontSize: 14, fontFamily: font, outline: "none", padding: "5px 0" }}
              />
            </div>

            {catOpen && !categoryId && (
              <div style={{ marginTop: 10 }}>
                <input value={catInput} onChange={(e) => setCatInput(e.target.value)} onFocus={() => setNumpad(false)} placeholder={t("add.categoryPlaceholder")} style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.bg, color: C.text, fontSize: 12, fontFamily: font, outline: "none", boxSizing: "border-box", marginBottom: 6 }} />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                  {filteredCats.slice(0, 8).map((c) => (
                    <button key={c.id} onClick={() => { setCategoryId(c.id); setCatInput(""); setCatOpen(false); }} style={{ padding: "5px 10px", borderRadius: 8, fontSize: 11, background: C.bg, color: C.text, border: `1px solid ${C.line}`, cursor: "pointer" }}>{c.name}</button>
                  ))}
                </div>
                {/* category creation = local.createCategory — unavailable in draft (zero local.*) */}
                {!draft && catInput && !state.categories.some((c) => c.name.toLowerCase() === catInput.toLowerCase()) && (
                  <button onClick={() => { const c = local.createCategory(catInput); setCategoryId(c.id); setCatInput(""); setCatOpen(false); }} style={{ padding: "7px 10px", borderRadius: 8, fontSize: 11, background: INCOME + "1a", color: INCOME, border: `1px solid ${INCOME}44`, cursor: "pointer", width: "100%", textAlign: "left" }}>{t("add.addNewCategory", { name: catInput })}</button>
                )}
              </div>
            )}
          </div>
        )}
        {tab === "expense" && splitMode && (
          <SplitEditor items={items} setItems={setItems} envelopes={state.envelopes} total={minor} onCancel={() => setSplitMode(false)} />
        )}
        {tab === "income" && (
          <div style={{ padding: "2px 0 10px" }}>
            <button onClick={() => setShowEnv(true)} style={{ display: "flex", alignItems: "center", gap: 11, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
              <MiniEnv color={env ? env.color : SAGE_BG} icon={env?.icon ?? "moneybag"} />
              <span style={{ fontSize: 15.5, fontWeight: 600, color: C.text }}>{env ? env.name : t("start.toBeBudgeted")}</span>
              {env && <span onClick={(e) => { e.stopPropagation(); setEnvelopeId(null); }} style={{ color: C.mute, fontSize: 11, padding: 4 }}>✕</span>}
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
              <Ico d="M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z" size={14} color={C.mute} />
              <input value={name} onChange={(e) => setName(e.target.value)} onFocus={() => setNumpad(false)} placeholder={t("add.namePlaceholder")} style={{ flex: 1, minWidth: 0, background: "none", border: "none", borderBottom: `1px solid ${C.line}`, color: C.text, fontSize: 14, fontFamily: font, outline: "none", padding: "5px 0" }} />
            </div>
          </div>
        )}
        {tab === "transfer" && (
          <div style={{ padding: "4px 0 8px" }}>
            <div style={{ display: "flex", justifyContent: "center", padding: "8px 0 10px" }}>
              <div style={{ width: 34, height: 34, borderRadius: "50%", background: C.bg, border: `1px solid ${C.line}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.soft} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="4" x2="12" y2="19" /><polyline points="6 13 12 19 18 13" /></svg>
              </div>
            </div>
            <button onClick={() => setShowTo(true)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", border: `1px solid ${C.line}`, borderRadius: 10, padding: "11px 14px", background: C.bg, cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Glyph name={accounts.find((a) => a.id === toAccountId)?.icon ?? "wallet"} size={18} color={C.soft} />
                <span style={{ fontSize: 13, color: C.text }}>{accounts.find((a) => a.id === toAccountId)?.name ?? t("add.toAccount")}</span>
              </div>
              <Ico d="M6 9l6 6 6-6" size={16} color={C.soft} />
            </button>
          </div>
        )}

        <div style={{ height: 1, background: C.line, margin: "8px 0" }} />
        <button onClick={(e) => { e.stopPropagation(); setShowDate(true); setNumpad(false); }} style={{ display: "flex", justifyContent: "space-between", width: "100%", padding: "6px 0", background: "none", border: "none", cursor: "pointer" }}>
          <span style={{ color: C.text, fontSize: 12 }}>{formatDateLong(date, lang)}</span>
          {recur !== "none" ? (
            <span style={{ color: "#e0a020", fontSize: 11, fontWeight: 600, background: "#f0c84f33", padding: "2px 8px", borderRadius: 8 }}>{t("add.planned")}</span>
          ) : (
            <button onClick={(e) => { e.stopPropagation(); setConfirmed(!confirmed); }} style={{ background: "none", border: "none", cursor: "pointer", color: confirmed ? INCOME : "#e0a020", fontSize: 11, fontWeight: 500, display: "flex", alignItems: "center", gap: 3 }}>
              <Ico d="M5 13l4 4L19 7" size={13} color={confirmed ? INCOME : "#e0a020"} sw={2.4} />{confirmed ? t("add.confirmed") : t("add.unconfirmed")}
            </button>
          )}
        </button>
        {showNote && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
            <Ico d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" size={15} color={C.mute} />
            <input autoFocus placeholder={t("add.notePlaceholder")} value={note} onChange={(e) => setNote(e.target.value)} onFocus={() => setNumpad(false)} style={{ flex: 1, background: "none", border: "none", borderBottom: `1px solid ${C.line}`, color: C.text, fontSize: 12, fontFamily: font, outline: "none", padding: "4px 0" }} />
          </div>
        )}
        {showPlace && (
          <div style={{ position: "relative", padding: "6px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Ico d="M3 9l9-7 9 7v11a1 1 0 01-1 1h-4v-7H8v7H4a1 1 0 01-1-1V9z" size={15} color={placeId ? TEAL : C.mute} />
              <input autoFocus placeholder={t("add.placePlaceholder")} value={placeId ? (state.places.find((p) => p.id === placeId)?.name ?? "") : placeInput} onChange={(e) => { setPlaceInput(e.target.value); setPlaceId(null); }} onFocus={() => setNumpad(false)} style={{ flex: 1, background: "none", border: "none", borderBottom: `1px solid ${C.line}`, color: C.text, fontSize: 12, fontFamily: font, outline: "none", padding: "4px 0" }} />
              {placeId && <button onClick={() => { setPlaceId(null); setPlaceInput(""); }} style={{ background: "none", border: "none", color: C.mute, fontSize: 11, cursor: "pointer" }}>✕</button>}
            </div>
            {/* in draft the place travels by NAME to /import/apply (server creates/matches) —
                no local.createPlace button; dropdown only when there are suggestions */}
            {placeInput && !placeId && (!draft || filteredPlaces.length > 0) && (
              <div style={{ position: "absolute", top: "100%", left: 23, right: 0, background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, zIndex: 10, maxHeight: 140, overflowY: "auto", marginTop: 2, boxShadow: "0 4px 14px rgba(0,0,0,0.1)" }}>
                {filteredPlaces.map((p) => (
                  <button key={p.id} onClick={() => { setPlaceId(p.id); setPlaceInput(""); }} style={{ display: "block", width: "100%", padding: "8px 11px", background: "none", border: "none", borderBottom: `1px solid ${C.line}`, color: C.text, fontSize: 11, cursor: "pointer", textAlign: "left", fontFamily: font }}>{p.name}</button>
                ))}
                {!draft && (
                  <button onClick={() => { const p = local.createPlace(placeInput); setPlaceId(p.id); setPlaceInput(""); }} style={{ display: "block", width: "100%", padding: "8px 11px", background: "none", border: "none", color: TEAL, fontSize: 11, cursor: "pointer", textAlign: "left", fontFamily: font }}>{t("add.addNewPlace", { name: placeInput })}</button>
                )}
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "center", gap: 22, padding: "16px 0 8px" }}>
          {([
            ["add.iconNote", "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z", showNote, () => setShowNote(!showNote)] as const,
            ["add.iconPlace", "M3 9l9-7 9 7v11a1 1 0 01-1 1h-4v-7H8v7H4a1 1 0 01-1-1V9z", showPlace, () => setShowPlace(!showPlace)] as const,
            // in draft no "Planned" (import is the past) and no "From screenshot" (zero nesting)
            ...(draft ? [] : [
              ["add.iconPlanned", "M12 8v4l3 2M12 22a10 10 0 100-20 10 10 0 000 20z", recur !== "none", () => setShowRecur(true)] as const,
              ["add.iconImport", "M4 8.5A1.5 1.5 0 015.5 7H8l1.6-2.4a1 1 0 01.9-.6h3a1 1 0 01.9.6L16 7h2.5A1.5 1.5 0 0120 8.5v9a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5v-9zM12 16a3.5 3.5 0 100-7 3.5 3.5 0 000 7z", false, () => setShowImport(true)] as const,
            ]),
          ]).map((b) => (
            <button key={b[0]} onClick={b[3]} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer" }}>
              <div style={{ width: 44, height: 44, borderRadius: "50%", background: b[2] ? TEAL : C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Ico d={b[1]} size={19} color={b[2] ? "#fff" : C.soft} />
              </div>
              <span style={{ fontSize: 10, color: C.soft }}>{t(b[0])}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: `6px ${P}px 8px`, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
        {noAccount && <div style={{ fontSize: 11.5, color: CORAL, textAlign: "center" }}>{t("onb.addNeedsAccount")}</div>}
        <button onClick={submit} disabled={minor <= 0 || noAccount} style={{ padding: "13px 36px", borderRadius: 26, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", background: at, color: "#fff", opacity: minor > 0 && !noAccount ? 1 : 0.4, display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="3.5,9.5 7.5,13.5 14.5,4.5" /></svg>
          {draft ? t("import.saveItem") : editTxn ? t("add.saveChanges") : t(submitLabel)}
        </button>
      </div>

      {/* Contextual OK like on the docked pad: A⊕B → "=" (reduction, pad stays), otherwise ✓ closes */}
      {numpad && <Numpad onKey={press} onOk={() => { if (hasOpenOp(amount)) press("="); else setNumpad(false); }} okGlyph={hasOpenOp(amount) ? "equals" : "check"} />}

      <Sheet show={showAcc} onClose={() => setShowAcc(false)}>
        {(C) => (
          <>
            <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 10 }}>{t("add.pickAccount")}</div>
            {accounts.map((a) => (
              <button key={a.id} onClick={() => { setAccountId(a.id); if (toAccountId === a.id) setToAccountId(accounts.find((x) => x.id !== a.id)?.id ?? ""); setShowAcc(false); }} style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "9px 0", background: "none", border: "none", cursor: "pointer" }}>
                <div style={{ width: 22, height: 22, borderRadius: "50%", border: `2px solid ${accountId === a.id ? TEAL : C.line}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{accountId === a.id && <div style={{ width: 11, height: 11, borderRadius: "50%", background: TEAL }} />}</div>
                <div style={{ width: 38, height: 38, borderRadius: 11, background: a.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <div style={{ width: 26, height: 26, borderRadius: "50%", background: "rgba(255,255,255,0.92)", display: "flex", alignItems: "center", justifyContent: "center" }}><Glyph name={a.icon} size={14} color={accountIconColor(a.color)} /></div>
                </div>
                <span style={{ flex: 1, textAlign: "left", fontSize: 14, color: C.text, fontWeight: 500 }}>{a.name}</span>
              </button>
            ))}
          </>
        )}
      </Sheet>
      <Sheet show={showTo} onClose={() => setShowTo(false)}>
        {(C) => (
          <>
            <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 10 }}>{t("add.toAccount")}</div>
            {accounts.filter((a) => a.id !== accountId).map((a) => (
              <button key={a.id} onClick={() => { setToAccountId(a.id); setShowTo(false); }} style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "9px 0", background: "none", border: "none", cursor: "pointer" }}>
                <div style={{ width: 38, height: 38, borderRadius: 11, background: a.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <div style={{ width: 26, height: 26, borderRadius: "50%", background: "rgba(255,255,255,0.92)", display: "flex", alignItems: "center", justifyContent: "center" }}><Glyph name={a.icon} size={14} color={accountIconColor(a.color)} /></div>
                </div>
                <span style={{ flex: 1, textAlign: "left", fontSize: 14, color: toAccountId === a.id ? TEAL : C.text, fontWeight: toAccountId === a.id ? 600 : 500 }}>{a.name}</span>
              </button>
            ))}
          </>
        )}
      </Sheet>
      <DateSheet show={showDate} date={date} onClose={() => setShowDate(false)} onChange={setDate} />
      {!draft && <ImportSheet show={showImport} onClose={() => setShowImport(false)} state={state} onApplied={onDone} />}
      <Sheet show={showRecur} onClose={() => setShowRecur(false)}>
        {(C) => (
          <>
            <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 6 }}>{t("add.recurrenceTitle")}</div>
            {RECUR.map((o) => (
              <button key={o.rule} onClick={() => { setRecur(o.rule); setShowRecur(false); }} style={{ display: "block", width: "100%", padding: "13px 4px", background: recur === o.rule ? C.bg : "none", border: "none", borderBottom: `1px solid ${C.line}`, color: C.text, fontSize: 14, fontWeight: recur === o.rule ? 600 : 400, cursor: "pointer", textAlign: "left", fontFamily: font }}>{t(o.label)}</button>
            ))}
          </>
        )}
      </Sheet>
      <Sheet show={showEnv} onClose={() => setShowEnv(false)}>
        {(C) => (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 14, textAlign: "center" }}>{t("add.pickEnvelope")}</div>
            {[...state.groups].sort((a, b) => a.sort - b.sort).map((g) => {
              const list = state.envelopes.filter((e) => e.groupId === g.id && !e.archived);
              if (!list.length) return null;
              return (
                <div key={g.id} style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text, marginBottom: 8 }}>{g.name}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 7 }}>
                    {list.map((e) => <EnvTile key={e.id} e={e} onClick={() => { setEnvelopeId(e.id); setShowEnv(false); }} />)}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </Sheet>
    </div>
  );
}

/** Mini envelope tile (with flap) — like on the original's envelope list. */
function MiniEnv({ color, icon }: { color: string; icon: string }) {
  return (
    <div style={{ position: "relative", width: 54, height: 40, borderRadius: 9, background: color, overflow: "hidden", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 3px rgba(0,0,0,0.12)" }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
        <polygon points="0,0 100,0 50,44" fill="rgba(0,0,0,0.05)" />
        <line x1="0" y1="0" x2="50" y2="44" stroke="rgba(0,0,0,0.13)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <line x1="100" y1="0" x2="50" y2="44" stroke="rgba(0,0,0,0.13)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      <span style={{ position: "relative", display: "flex" }}>
        <Glyph name={icon} size={17} color={isLight(color) ? "#33312c" : "#fff"} sw={1.7} />
      </span>
    </div>
  );
}

function SplitEditor({ items, setItems, envelopes, total, onCancel }: { items: Array<{ envelopeId: string; amount: number }>; setItems: (i: Array<{ envelopeId: string; amount: number }>) => void; envelopes: StateResponse["envelopes"]; total: number; onCancel: () => void }) {
  const C = useTheme();
  const { t, lang } = useT();
  const currency = useCurrency();
  const sum = items.reduce((s, i) => s + i.amount, 0);
  const active = envelopes.filter((e) => !e.archived);
  // One numpad sheet per split editor — the item supplies the target on tap.
  const [pad, setPad] = useState<AmountPadTarget | null>(null);
  const openPad = (idx: number) => {
    const it = items[idx]!;
    setPad({
      label: envelopes.find((e) => e.id === it.envelopeId)?.name ?? t("add.splitTitle"),
      initial: it.amount,
      onCommit: (minor) => setItems(items.map((x, i) => (i === idx ? { ...x, amount: minor } : x))),
    });
  };
  // new item: first envelope UNUSED in items + auto-remainder (total − sum)
  const add = () => {
    const used = new Set(items.map((i) => i.envelopeId));
    setItems([...items, { envelopeId: active.find((e) => !used.has(e.id))?.id ?? "", amount: Math.max(0, total - sum) }]);
  };
  return (
    <div style={{ padding: "4px 0 10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{t("add.splitTitle")}</span>
        <button onClick={onCancel} style={{ background: "none", border: "none", color: C.mute, fontSize: 11, cursor: "pointer" }}>{t("add.splitCancel")}</button>
      </div>
      {items.map((it, idx) => (
        <div key={idx} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
          <select value={it.envelopeId} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, envelopeId: e.target.value } : x)))} style={{ flex: 1, padding: "9px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.bg, color: C.text, fontSize: 13, fontFamily: font }}>
            {it.envelopeId === "" && <option value="" disabled>{t("add.splitPick")}</option>}
            {active.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <input value={(it.amount / 100).toFixed(2).replace(".", ",")} readOnly onClick={() => openPad(idx)} onFocus={() => openPad(idx)} style={{ width: 80, padding: "9px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.bg, color: C.text, fontSize: 13, fontFamily: font, textAlign: "right", fontVariantNumeric: "tabular-nums", cursor: "pointer" }} />
          <button onClick={() => setItems(items.filter((_, i) => i !== idx))} style={{ background: "none", border: "none", color: CORAL, fontSize: 14, cursor: "pointer" }}>✕</button>
        </div>
      ))}
      <button onClick={add} style={{ marginTop: 4, padding: "8px 12px", borderRadius: 8, background: "var(--accent-1a)", border: `1px solid var(--accent-55)`, color: TEAL, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{t("add.splitAddItem")}</button>
      <div style={{ marginTop: 8, fontSize: 11, color: sum === total ? INCOME : CORAL }}>{t("add.splitSum", { sum: formatMoney(sum, currency, lang), total: formatMoney(total, currency, lang) })} {sum === total ? "✓" : t("add.splitMustMatch")}</div>
      <AmountPadHost target={pad} onClose={() => setPad(null)} />
    </div>
  );
}

function DateSheet({ show, date, onClose, onChange }: { show: boolean; date: string; onClose: () => void; onChange: (iso: string) => void }) {
  const { t, lang } = useT();
  const months = monthNames(lang);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const set = (day: number, monIdx: number, year: number) => {
    const maxDay = new Date(Date.UTC(year, monIdx + 1, 0)).getUTCDate();
    const dd = Math.min(day, maxDay);
    onChange(`${year}-${String(monIdx + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`);
  };
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  const years = [y - 2, y - 1, y, y + 1, y + 2].filter((v, i, a) => a.indexOf(v) === i);
  const todayIso = new Date().toISOString().slice(0, 10);
  return (
    <Sheet show={show} onClose={onClose}>
      {(C) => (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 10, borderBottom: `1px solid ${C.line}` }}>
            <button onClick={() => { const dt = new Date(`${todayIso}T00:00Z`); dt.setUTCDate(dt.getUTCDate() - 1); onChange(dt.toISOString().slice(0, 10)); onClose(); }} style={{ background: "none", border: "none", color: TEAL, fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}>{t("add.dateYesterday")}</button>
            <button onClick={() => { onChange(todayIso); onClose(); }} style={{ background: "none", border: "none", color: TEAL, fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}>{t("add.dateToday")}</button>
            <button onClick={onClose} style={{ background: "none", border: "none", color: TEAL, fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}>OK</button>
          </div>
          <div style={{ display: "flex", justifyContent: "center", marginTop: 4 }}>
            <ScrollPicker items={days} selected={d} onSelect={(v) => set(v, m - 1, y)} width="28%" />
            <ScrollPicker items={months} selected={months[m - 1]!} onSelect={(v) => set(d, months.indexOf(v), y)} width="44%" />
            <ScrollPicker items={years} selected={y} onSelect={(v) => set(d, m - 1, v)} width="28%" />
          </div>
        </>
      )}
    </Sheet>
  );
}
