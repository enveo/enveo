import { useEffect, useMemo, useState, type ReactNode } from "react";
import { upcomingPayments } from "@enveo/shared";
import { Glyph, Ico } from "../lib/icons";
import { useCurrency, useMask, useTheme } from "../lib/contexts";
import { useT, type Lang } from "../lib/i18n";
import { CORAL, INCOME, P, SAGE_BG, SAGE_TX, TEAL, font } from "../lib/theme";
import { AccCard, accountIconColor, EnvTile } from "../components/tiles";
import { AmountPadHost, type AmountPadTarget } from "../components/AmountPadSheet";
import { Header, Sheet, type ScreenId } from "../components/chrome";
import { useLedgerVersion, type AccountView, type StateResponse } from "../lib/api";
import { todayISO } from "../lib/dates";
import { local } from "../lib/mutate";
import { store } from "../lib/store";
import { useDragReorder } from "../lib/dnd";
import { currencySymbol, isLight, LOCALE_OF, parseAmount } from "../lib/format";
import { fmtSignedTrim } from "../lib/amount";

const shortDate = (iso: string, lang: Lang): string =>
  new Intl.DateTimeFormat(LOCALE_OF[lang], { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

export function StartScreen({
  state,
  month,
  onOpenTxns,
  onOpenEnvelope,
  onMenu,
  onPrev,
  onNext,
  onNav,
  onSeeUpcoming,
}: {
  state: StateResponse;
  month: string;
  onOpenTxns: (f?: { envId?: string; accId?: string }) => void;
  onOpenEnvelope: (envId: string, month: string) => void;
  onMenu: () => void;
  onPrev: () => void;
  onNext: () => void;
  onNav: (s: ScreenId) => void;
  onSeeUpcoming: () => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, lang } = useT();
  const version = useLedgerVersion();
  // 3 nearest planned payments (30-day horizon) — computed locally from the replica
  const upcoming = useMemo(() => {
    const l = store.getLedger();
    return l ? upcomingPayments(l, todayISO(), 30).slice(0, 3) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  // month summary without the fractional part (strips e.g. ",00" / ".00" from the formatted amount), with the discreet mask
  const MW = (minor: number) => M(minor).replace(/[.,]\d\d(?!\d)/, "");
  const [selAcc, setSelAcc] = useState<AccountView | null>(null);
  const [reconcile, setReconcile] = useState<AccountView | null>(null);
  const [editLayout, setEditLayout] = useState(false);

  const accounts = [...state.accounts].filter((a) => !a.archived).sort((a, b) => a.sort - b.sort);
  const envelopes = [...state.envelopes].filter((e) => !e.archived).sort((a, b) => a.sort - b.sort);

  // Layout editing: tile drag & drop; sort = global flat index 0..n;
  // ops per drop — the debounce in sync.poke() coalesces the burst into one push
  const commitMove = (kind: "acc" | "env", arr: Array<{ id: string; sort: number }>) => (from: number, to: number) => {
    const order = [...arr];
    const [m] = order.splice(from, 1);
    order.splice(to, 0, m!);
    const ch = order.map((x, i) => ({ kind, id: x.id, sort: i })).filter((c, i) => order[i]!.sort !== i);
    for (const c of ch) {
      if (c.kind === "acc") local.updateAccount(c.id, { sort: c.sort });
      else local.updateEnvelope(c.id, { sort: c.sort });
    }
  };
  const accDnd = useDragReorder(commitMove("acc", accounts));
  const envDnd = useDragReorder(commitMove("env", envelopes));

  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: 6 }}>
      <Header month={month} onMenu={onMenu} onPrev={onPrev} onNext={onNext} onRight={() => setEditLayout((v) => !v)} rightIcon="pencil" />
      {editLayout && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: `0 ${P}px 8px`, padding: "7px 12px", background: "var(--accent-14)", border: `1px solid var(--accent-44)`, borderRadius: 10 }}>
          <span style={{ flex: 1, fontSize: 11, color: C.soft }}>{t("start.editLayoutHint")}</span>
          <button onClick={() => setEditLayout(false)} style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: TEAL, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{t("common.done")}</button>
        </div>
      )}
      {/* Empty states (backstop outside the wizard): missing accounts OR envelopes → CTA below the header */}
      {(accounts.length === 0 || envelopes.length === 0) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: `0 ${P}px 10px`, padding: "12px 14px", background: "var(--accent-14)", border: `1px solid var(--accent-44)`, borderRadius: 12 }}>
          {accounts.length === 0 && (
            <button onClick={() => onNav("accounts")} style={{ padding: "10px 0", borderRadius: 10, border: "none", background: TEAL, color: "#fff", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: font }}>
              {t("onb.ctaAccounts")}
            </button>
          )}
          {envelopes.length === 0 && (
            <button onClick={() => onNav("budget")} style={{ padding: "10px 0", borderRadius: 10, border: `1px solid ${TEAL}`, background: "transparent", color: TEAL, fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: font }}>
              {t("onb.ctaEnvelopes")}
            </button>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, padding: `2px ${P}px 8px`, alignItems: "stretch" }}>
        <div style={{ flex: 1, display: "flex", gap: 16, alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 10.5, color: C.soft }}>
              <span style={{ color: INCOME }}>↑</span> {t("start.income")}
            </div>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{MW(state.monthIncome)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10.5, color: C.soft }}>
              <span style={{ color: CORAL }}>↓</span> {t("start.expense")}
            </div>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{MW(state.monthExpense)}</div>
          </div>
        </div>
        <div style={{ background: state.toBeBudgeted < 0 ? CORAL : SAGE_BG, borderRadius: 12, padding: "6px 12px", display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 150 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Glyph name="moneybag" size={14} color={state.toBeBudgeted < 0 ? "#fff" : SAGE_TX} sw={1.6} />
            <span style={{ fontSize: 14, fontWeight: 700, color: state.toBeBudgeted < 0 ? "#fff" : SAGE_TX, fontVariantNumeric: "tabular-nums" }}>{M(state.toBeBudgeted)}</span>
          </div>
          <div style={{ fontSize: 10, color: state.toBeBudgeted < 0 ? "#fff" : SAGE_TX, opacity: 0.85 }}>{t("start.toBeBudgeted")}</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: editLayout ? 10 : 7, padding: `4px ${P}px 12px` }}>
        {accounts.map((a, i) =>
          editLayout ? (
            <DragWrap key={a.id} dnd={accDnd} i={i}>
              <AccCard a={a} onClick={() => {}} />
            </DragWrap>
          ) : (
            <AccCard key={a.id} a={a} onClick={() => setSelAcc(a)} />
          ),
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: editLayout ? 10 : 7, padding: `0 ${P}px 10px` }}>
        {envelopes.map((e, i) =>
          editLayout ? (
            <DragWrap key={e.id} dnd={envDnd} i={i}>
              <EnvTile e={e} onClick={() => {}} />
            </DragWrap>
          ) : (
            <EnvTile key={e.id} e={e} onClick={() => onOpenEnvelope(e.id, month)} />
          ),
        )}
      </div>

      {/* Upcoming payments (planned transactions only) — 3 nearest + link to Reports→Subscriptions */}
      {upcoming.length > 0 && (
        <div style={{ padding: `0 ${P}px 10px` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{t("subs.upcoming")}</span>
            <button onClick={onSeeUpcoming} style={{ background: "none", border: "none", padding: 0, color: TEAL, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: font }}>{t("subs.seeAll")}</button>
          </div>
          {upcoming.map((u) => {
            const env = u.txn.envelopeId ? state.envelopes.find((e) => e.id === u.txn.envelopeId) : undefined;
            return (
              <div key={u.txn.id} style={{ display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.line}`, padding: "8px 0" }}>
                <span style={{ fontSize: 11.5, color: C.soft, width: 52, flexShrink: 0 }}>{shortDate(u.txn.date, lang)}</span>
                <span style={{ width: 28, height: 28, borderRadius: 8, background: env?.color ?? C.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {env && <Glyph name={env.icon} size={14} color={isLight(env.color) ? "#33312c" : "#fff"} />}
                </span>
                <span style={{ flex: 1, fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.label}</span>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{M(u.txn.amount)}</span>
              </div>
            );
          })}
        </div>
      )}

      <Sheet show={!!selAcc} onClose={() => setSelAcc(null)}>
        {(C) => selAcc && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                <div style={{ width: 42, height: 42, borderRadius: 11, background: selAcc.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Glyph name={selAcc.icon} size={20} color={accountIconColor(selAcc.color)} />
                </div>
                <span style={{ fontSize: 18, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selAcc.name}</span>
              </div>
              <span style={{ fontSize: 18, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{M(selAcc.balance)}</span>
            </div>
            <div style={{ height: 1, background: C.line, margin: "0 0 12px" }} />
            {(
              [
                [t("start.balance"), M(selAcc.balance), C.text],
                [t("start.cleared"), M(selAcc.cleared), C.text],
                [t("start.uncleared"), M(selAcc.uncleared), selAcc.uncleared !== 0 ? CORAL : C.text],
              ] as const
            ).map((r) => (
              <div key={r[0]} style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
                <span style={{ fontSize: 13.5, color: C.soft }}>{r[0]}:</span>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: r[2], fontVariantNumeric: "tabular-nums" }}>{r[1]}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-evenly", marginTop: 16 }}>
              {(
                [
                  ["M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2", t("nav.transactions"), () => { const a = selAcc; setSelAcc(null); onOpenTxns({ accId: a.id }); }],
                  ["M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4", t("start.reconcile"), () => { const a = selAcc; setSelAcc(null); setReconcile(a); }],
                ] as const
              ).map(([d, label, onClick]) => (
                <button key={label} onClick={onClick} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 7, padding: 0 }}>
                  <span style={{ width: 52, height: 52, borderRadius: "50%", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Ico d={d} size={20} color={C.text} sw={1.5} />
                  </span>
                  <span style={{ fontSize: 12, color: C.text }}>{label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </Sheet>

      <ReconcileSheet account={reconcile} onClose={() => setReconcile(null)} />
    </div>
  );
}

/* ── Tile wrapper in layout-edit mode (drag & drop) ─────────────────── */
function DragWrap({ dnd, i, children }: { dnd: ReturnType<typeof useDragReorder>; i: number; children: ReactNode }) {
  const C = useTheme();
  const b = dnd.bind(i);
  return (
    <div
      ref={dnd.itemRef(i)}
      {...b}
      style={{
        ...b.style,
        position: "relative",
        display: "grid",
        borderRadius: 12,
        outline: dnd.over === i && dnd.dragging !== i ? `2px dashed ${TEAL}` : `1px dashed ${C.line}`,
        outlineOffset: 2,
      }}
    >
      <div style={{ display: "grid", animation: dnd.dragging === i ? undefined : "wg .22s ease-in-out infinite alternate" }}>{children}</div>
    </div>
  );
}

/* ── Account balance reconciliation (reconcile) ─────────────────────── */
function ReconcileSheet({ account, onClose }: { account: AccountView | null; onClose: () => void }) {
  const M = useMask();
  const { t, lang } = useT();
  const currency = useCurrency();
  const [val, setVal] = useState("");
  const [pad, setPad] = useState<AmountPadTarget | null>(null);
  useEffect(() => { if (account) setVal((account.balance / 100).toFixed(2).replace(".", ",")); }, [account]);
  if (!account) return null;
  const openPad = () =>
    setPad({
      label: t("start.realBalance"),
      initial: parseAmount(val) ?? 0,
      allowNegative: true, // the real account balance may be negative (e.g. a credit card)
      onCommit: (minor) => setVal(fmtSignedTrim(minor)),
    });
  const real = parseAmount(val);
  const diff = real === null ? 0 : real - account.balance;
  const submit = () => {
    if (real === null || diff === 0) { onClose(); return; }
    local.createTxn({
      type: diff > 0 ? "income" : "expense",
      accountId: account.id,
      amount: Math.abs(diff),
      date: new Date().toISOString().slice(0, 10),
      confirmed: true,
      envelopeId: null,
      // the note is transaction DATA — saved in the language active at creation time
      note: t("start.reconcileNote"),
    });
    onClose();
  };
  return (
    <>
    <Sheet show={!!account} onClose={onClose}>
      {(C) => (
        <>
          <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{t("start.reconcileTitle")}</div>
          <div style={{ fontSize: 12.5, color: C.soft, marginBottom: 16 }}>{account.name}</div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
            <span style={{ fontSize: 13, color: C.soft }}>{t("start.balanceInApp")}</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(account.balance)}</span>
          </div>
          <div style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>{t("start.realBalance")}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
            <input value={val} readOnly onClick={openPad} onFocus={openPad} style={{ flex: 1, padding: "9px 11px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.surface, color: C.text, fontSize: 16, fontWeight: 600, fontFamily: font, outline: "none", fontVariantNumeric: "tabular-nums", cursor: "pointer" }} />
            <span style={{ color: C.mute, fontSize: 13 }}>{currencySymbol(currency, lang)}</span>
          </div>
          {real !== null && diff !== 0 && (
            <div style={{ fontSize: 12.5, marginBottom: 12, color: diff > 0 ? INCOME : CORAL }}>
              {t("start.reconcileDiff", {
                sign: diff > 0 ? "+" : "−",
                amount: M(Math.abs(diff)),
                kind: t(diff > 0 ? "start.reconcileKindIncome" : "start.reconcileKindExpense"),
              })}
            </div>
          )}
          <button onClick={submit} disabled={real === null || diff === 0} style={{ width: "100%", padding: "12px 0", borderRadius: 12, border: "none", background: TEAL, color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer", opacity: real === null || diff === 0 ? 0.5 : 1 }}>
            {real !== null && diff === 0 ? t("start.balanceMatches") : t("start.reconcile")}
          </button>
        </>
      )}
    </Sheet>
    {/* Sibling of the Sheet (not a child) — the panel's transform would break the pad's position:fixed. */}
    <AmountPadHost target={pad} onClose={() => setPad(null)} />
    </>
  );
}

