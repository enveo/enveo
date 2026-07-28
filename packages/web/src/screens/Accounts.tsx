import { useEffect, useState } from "react";
import type { StateResponse } from "../lib/api";
import { local } from "../lib/mutate";
import { fmtSignedTrim } from "../lib/amount";
import { AmountPadHost, type AmountPadTarget } from "../components/AmountPadSheet";
import { Sheet } from "../components/chrome";
import { IconColorPicker } from "../components/IconColorPicker";
import { accountIconColor } from "../components/tiles";
import { useMask, useTheme } from "../lib/contexts";
import { useDragReorder } from "../lib/dnd";
import { useT } from "../lib/i18n";
import { parseAmount } from "../lib/format";
import { Glyph, Ico } from "../lib/icons";
import { ACCOUNT_COLORS, P, TEAL, font } from "../lib/theme";

export function AccountsScreen({ state, onMenu }: { state: StateResponse; onMenu: () => void }) {
  const C = useTheme();
  const M = useMask();
  const { t } = useT();
  const accounts = [...state.accounts].filter((a) => !a.archived).sort((a, b) => a.sort - b.sort);
  const closed = [...state.accounts].filter((a) => a.archived).sort((a, b) => a.sort - b.sort);
  const total = accounts.reduce((s, a) => s + a.balance, 0);
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<StateResponse["accounts"][number] | null>(null);
  const [nm, setNm] = useState("");
  const [bl, setBl] = useState("");
  const [nmColor, setNmColor] = useState<string>(ACCOUNT_COLORS[0]!);
  const [nmIcon, setNmIcon] = useState("wallet");
  const [pad, setPad] = useState<AmountPadTarget | null>(null);
  const openAdd = () => {
    // rotating preselection like the previous auto-assignment — the user may change it
    setNmColor(ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length]!);
    setNmIcon("wallet");
    setAdd(true);
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
    local.createAccount({
      name: nm.trim(),
      initialBalance: parseAmount(bl) ?? 0,
      color: nmColor,
      icon: nmIcon,
      sort: accounts.length,
    });
    setNm("");
    setBl("");
    setAdd(false);
  };

  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `12px ${P}px 4px` }}>
        <button onClick={onMenu} aria-label={t("Menu")} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
          <Ico d="M4 6h16M4 12h16M4 18h16" size={20} />
        </button>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 18.5, fontWeight: 600, color: C.text }}>{t("Accounts")}</div>
          <div style={{ fontSize: 12, color: C.soft, marginTop: 1 }}>{t("Balance")}: <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{M(total)}</span></div>
        </div>
        <button onClick={openAdd} aria-label={t("Add account")} style={{ width: 34, height: 34, borderRadius: 10, border: "none", background: "var(--accent-1a)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Ico d="M12 5v14M5 12h14" size={18} color={TEAL} sw={2.2} />
        </button>
      </div>
      <div style={{ padding: `8px ${P}px` }}>
        {accounts.map((a, i) => {
          const b = dnd.bind(i);
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
              <span {...b} aria-label={t("Drag {name}", { name: a.name })} style={{ ...b.style, display: "flex", padding: "8px 6px", marginLeft: -6, flexShrink: 0 }}>
                <Ico d="M4 7h16M4 12h16M4 17h16" size={14} color={C.mute} />
              </span>
              <div role="button" onClick={() => setEdit(a)} style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                  <div style={{ width: 44, height: 44, borderRadius: 12, background: a.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <div style={{ width: 30, height: 30, borderRadius: "50%", background: "rgba(255,255,255,0.92)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Glyph name={a.icon} size={16} color={accountIconColor(a.color)} />
                    </div>
                  </div>
                  <span style={{ color: C.text, fontSize: 14.5, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                </div>
                <span style={{ fontSize: 15, fontWeight: 600, color: a.balance === 0 ? C.mute : C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0, marginLeft: 8 }}>{M(a.balance)}</span>
              </div>
            </div>
          );
        })}
        {closed.length > 0 && (
          <>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: C.mute, textTransform: "uppercase", letterSpacing: 0.6, margin: "16px 0 4px" }}>{t("Closed")}</div>
            {closed.map((a) => (
              <div key={a.id} role="button" onClick={() => setEdit(a)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0", opacity: 0.55, cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 34, height: 34, borderRadius: 10, background: a.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <div style={{ width: 24, height: 24, borderRadius: "50%", background: "rgba(255,255,255,0.92)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Glyph name={a.icon} size={13} color={accountIconColor(a.color)} />
                    </div>
                  </div>
                  <span style={{ color: C.soft, fontSize: 13.5 }}>{a.name}</span>
                </div>
                <span style={{ fontSize: 13, color: C.mute, fontVariantNumeric: "tabular-nums" }}>{M(a.balance)}</span>
              </div>
            ))}
          </>
        )}
      </div>

      <Sheet show={add} onClose={() => setAdd(false)}>
        {(C) => (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 14 }}>{t("New account")}</div>
            <input value={nm} onChange={(e) => setNm(e.target.value)} placeholder={t("Account name")} style={{ width: "100%", padding: "10px 12px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.bg, color: C.text, fontSize: 14, fontFamily: font, outline: "none", boxSizing: "border-box", marginBottom: 8 }} />
            <input value={bl} readOnly onClick={openBalancePad} onFocus={openBalancePad} placeholder={t("Starting balance (0)")} style={{ width: "100%", padding: "10px 12px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.bg, color: C.text, fontSize: 14, fontFamily: font, outline: "none", boxSizing: "border-box", marginBottom: 14, cursor: "pointer" }} />
            <IconColorPicker palette={ACCOUNT_COLORS} color={nmColor} icon={nmIcon} onColor={setNmColor} onIcon={setNmIcon} />
            <button onClick={submit} style={{ width: "100%", padding: 12, borderRadius: 11, border: "none", background: TEAL, color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer", opacity: nm.trim() ? 1 : 0.4 }}>{t("Add account")}</button>
          </>
        )}
      </Sheet>

      <AccountEdit account={edit} onClose={() => setEdit(null)} />
      {/* Sibling of the "New account" sheet (not a child) — the panel's transform would break the pad's position:fixed. */}
      <AmountPadHost target={pad} onClose={() => setPad(null)} />
    </div>
  );
}

/** Account editing: name + color/icon + archiving (with confirmation and an explanation of consequences). */
function AccountEdit({ account, onClose }: { account: StateResponse["accounts"][number] | null; onClose: () => void }) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(ACCOUNT_COLORS[0]!);
  const [icon, setIcon] = useState("wallet");
  const [archived, setArchived] = useState(false);
  useEffect(() => {
    if (account) { setName(account.name); setColor(account.color); setIcon(account.icon); setArchived(account.archived); }
  }, [account]);
  if (!account) return null;
  const save = () => {
    const nm = name.trim();
    if (!nm) return;
    if (archived && !account.archived) {
      const ok = window.confirm(t("The account “{name}” will disappear from the Start screen and lists (you will find it under “Closed” on the Accounts screen). Its transactions and balance still count in the budget and reports.\n\nArchive it?", { name: nm }));
      if (!ok) return;
    }
    local.updateAccount(account.id, { name: nm, color, icon, archived });
    onClose();
  };
  return (
    <Sheet show={!!account} onClose={onClose}>
      {(C) => (
        <>
          <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 14 }}>{t("Edit account")}</div>
          <div style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.6 }}>{t("Account name")}</div>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%", padding: "8px 0", border: "none", borderBottom: `1px solid ${C.line}`, background: "none", color: C.text, fontSize: 15, fontFamily: font, outline: "none", marginBottom: 18, boxSizing: "border-box" }} />
          <IconColorPicker palette={ACCOUNT_COLORS} color={color} icon={icon} onColor={setColor} onIcon={setIcon} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
            <span style={{ fontSize: 14, color: C.text }}>{t("Archived account")}</span>
            <button onClick={() => setArchived(!archived)} style={{ width: 42, height: 24, borderRadius: 12, background: archived ? TEAL : C.line, position: "relative", border: "none", cursor: "pointer", transition: "background .2s" }}>
              <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff", position: "absolute", top: 2, left: archived ? 20 : 2, transition: "left .2s", boxShadow: "0 1px 2px rgba(0,0,0,0.2)" }} />
            </button>
          </div>
          <button onClick={save} disabled={!name.trim()} style={{ width: "100%", padding: 12, borderRadius: 11, border: "none", background: TEAL, color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer", opacity: name.trim() ? 1 : 0.4 }}>{t("Save")}</button>
        </>
      )}
    </Sheet>
  );
}
