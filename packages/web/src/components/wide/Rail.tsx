import { computeStateResponse } from "@enveo/shared";
import { useEffect, useMemo, useState } from "react";
import type { StateResponse } from "../../lib/api";
import { useLedgerVersion } from "../../lib/api";
import { authClient } from "../../lib/auth";
import { useMask, useSettings, useTheme } from "../../lib/contexts";
import { currentMonth, todayISO } from "../../lib/dates";
import { LOCALE_OF } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Ico } from "../../lib/icons";
import { isInstallable, useInstall } from "../../lib/installPrompt";
import { store } from "../../lib/store";
import { syncNow } from "../../lib/sync";
import { font, TEAL } from "../../lib/theme";
import { monthRuler, sumBalances, tbbState } from "../../lib/uiState";
import { APP_VERSION, buildLabel } from "../../lib/version";
import { RAIL_W, type ViewMode } from "../../lib/viewMode";
import { D_EYE, D_GEAR, D_MOON, LogoMark, NAV_ICONS, type ScreenId } from "../chrome";

type WideMode = Exclude<ViewMode, "phone">;

/** The five screens the rail navigates between — a strict subset of `ScreenId` (no
 *  `addExpense`/`settings`: Add lives in the band's `+ Add` button, Settings behind the user
 *  menu's gear tile — pr4-context.md §0b items 6 and 12). */
type NavScreen = "start" | "budget" | "transactions" | "reports" | "accounts";

/**
 * The signed-in user's email — read once from `lib/auth.ts`, the ONE session source of truth,
 * rather than threading it down from App (nothing else in the wide chunk needs a session
 * subscription yet). `null` while unresolved or genuinely absent; a mount that unmounts before
 * the fetch settles is guarded by `alive` the same way `hasSession()` guards its own read.
 */
function useSessionEmail(): string | null {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void authClient
      .getSession()
      .then((s) => {
        if (!alive) return;
        const e = (s as { data?: { user?: { email?: string } } })?.data?.user?.email;
        setEmail(e ?? null);
      })
      .catch(() => {
        if (alive) setEmail(null);
      });
    return () => {
      alive = false;
    };
  }, []);
  return email;
}

/** Fold: 44×44 icon-only square (existing task-4 shape). Active background is the theme's CTA
 *  alpha token — never a hardcoded hex — same idiom as Drawer's quick tiles. */
function RailButton({ active, d, label, onClick }: { active: boolean; d: string; label: string; onClick: () => void }) {
  const C = useTheme();
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      style={{
        width: 44,
        height: 44,
        minWidth: 30,
        minHeight: 30,
        flexShrink: 0,
        borderRadius: 12,
        border: "none",
        background: active ? "var(--cta-18)" : "transparent",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Ico d={d} size={20} color={active ? TEAL : C.soft} sw={1.8} />
    </button>
  );
}

/** Desktop: icon + full label, full-width row (pr4-context.md §12.1's decided reading — icon
 *  language shared with `RailButton`/`BottomNav` via `NAV_ICONS`). */
function NavRow({ active, d, label, onClick }: { active: boolean; d: string; label: string; onClick: () => void }) {
  const C = useTheme();
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        minHeight: 40,
        padding: "0 14px",
        borderRadius: 11,
        border: "none",
        background: active ? "var(--cta-18)" : "transparent",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: font,
      }}
    >
      <Ico d={d} size={19} color={active ? TEAL : C.soft} sw={1.8} />
      <span
        style={{
          fontSize: 13.5,
          fontWeight: active ? 700 : 600,
          color: active ? TEAL : C.text,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
    </button>
  );
}

/**
 * Desktop-only "To be budgeted" card (spec demo 100–133). `state.readyToAssign` is
 * month-INDEPENDENT (shared/stateResponse.ts) — reading it off whatever `state` App already
 * computed for the viewed month is not the 3.6.2 balance bug, since every month's `state` carries
 * the identical figure. `monthIncome`/`monthExpense` ARE month-scoped, matching Start's own
 * widget exactly. The embedded account list is a DIFFERENT question (an actual balance) and
 * follows the Drawer/AccountsWidget pattern: GLOBAL, recomputed at `currentMonth()`, never the
 * viewed month.
 */
function TbbCard({
  state,
  screen,
  onQuickAdd,
  onFillGoals,
  onNav,
}: {
  state: StateResponse;
  screen: ScreenId;
  onQuickAdd: (kind: "transfer" | "import" | "suggest") => void;
  onFillGoals: () => void;
  onNav: (s: ScreenId) => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, tp, lang } = useT();
  const [acctsOpen, setAcctsOpen] = useState(true);
  const hs = tbbState(state.readyToAssign);
  const tbbColor = hs === "negative" ? C.neg : hs === "zero" ? C.pos : "var(--cta)";
  const ruler = monthRuler(todayISO());
  const shortDay = new Intl.DateTimeFormat(LOCALE_OF[lang], { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${todayISO()}T00:00:00Z`));
  // GLOBAL balances (chrome.tsx Drawer pattern, chrome.tsx:386-397) — recomputed on every ledger
  // write, at the CURRENT month regardless of `state`'s month. Never the viewed month (3.6.2).
  const version = useLedgerVersion();
  const accountsGlobal = useMemo(() => {
    const ledger = store.getLedger();
    if (!ledger) return [];
    return computeStateResponse(ledger, currentMonth())
      .accounts.filter((a) => !a.archived)
      .sort((a, b) => a.sort - b.sort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  // The Accounts screen's primary IS the account list — the rail copy would be a duplicate
  // (mockup's `railAcctsSection`, pr4-task-5-brief.md).
  const showAccounts = screen !== "accounts";

  const pill = (primary: boolean): React.CSSProperties => ({
    flex: 1,
    minHeight: 30,
    textAlign: "center",
    borderRadius: 999,
    border: primary ? "1.5px solid var(--cta)" : `1px solid ${C.line}`,
    background: "transparent",
    color: primary ? "var(--cta)" : C.soft,
    fontSize: 11.5,
    fontWeight: primary ? 700 : 650,
    cursor: "pointer",
    fontFamily: font,
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        margin: "8px 4px 4px",
        padding: "12px 12px 10px",
        borderRadius: 14,
        background: C.inset,
      }}
    >
      <span style={{ fontSize: 10, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.mute }}>{t("To be budgeted")}</span>
      <span style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.015em", color: tbbColor, fontVariantNumeric: "tabular-nums", marginTop: 3 }}>
        {M(state.readyToAssign)}
      </span>
      <span style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, color: C.soft, fontVariantNumeric: "tabular-nums", marginTop: 5 }}>
        <span>
          <span style={{ color: C.pos }}>↑</span> {M(state.monthIncome)}
        </span>
        <span>
          <span style={{ color: C.neg }}>↓</span> {M(state.monthExpense)}
        </span>
      </span>
      <span style={{ height: 3, borderRadius: 2, background: C.line, position: "relative", display: "block", marginTop: 7 }}>
        <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${ruler.pct}%`, borderRadius: 2, background: C.mute, display: "block" }} />
      </span>
      <span style={{ fontSize: 10, color: C.mute, marginTop: 5 }}>{t("{date} · {pct}% of month", { date: shortDay, pct: String(ruler.pct) })}</span>
      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button onClick={() => onQuickAdd("suggest")} aria-label={t("Suggest a distribution")} style={pill(true)}>
          {"✨ "}
          {t("Suggest")}
        </button>
        <button onClick={onFillGoals} style={pill(false)}>
          {t("Fill by goals")}
        </button>
      </div>
      {showAccounts && (
        <>
          <button
            onClick={() => setAcctsOpen((v) => !v)}
            aria-expanded={acctsOpen}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              width: "100%",
              minHeight: 30,
              marginTop: 10,
              paddingTop: 9,
              border: "none",
              borderTop: `1px solid ${C.line}`,
              background: "none",
              cursor: "pointer",
              fontFamily: font,
            }}
          >
            <span style={{ fontSize: 10, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.mute }}>{t("Accounts")}</span>
            <span aria-hidden style={{ fontSize: 10, color: C.mute }}>
              {acctsOpen ? "▴" : "▾"}
            </span>
          </button>
          {acctsOpen && accountsGlobal.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 5, maxHeight: 168, overflowY: "auto" }}>
              {accountsGlobal.map((a) => (
                <button
                  key={a.id}
                  onClick={() => onNav("accounts")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    minHeight: 30,
                    padding: "4px 6px",
                    borderRadius: 8,
                    border: "none",
                    background: "none",
                    cursor: "pointer",
                    fontFamily: font,
                    textAlign: "left",
                  }}
                >
                  <span style={{ width: 12, height: 12, borderRadius: "50%", background: a.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {a.name}
                  </span>
                  <span style={{ flexShrink: 0, fontWeight: 650, fontSize: 12.5, color: a.balance < 0 ? C.neg : C.text, fontVariantNumeric: "tabular-nums" }}>
                    {M(a.balance)}
                  </span>
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => onNav("accounts")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              width: "100%",
              minHeight: 30,
              marginTop: 4,
              paddingTop: 8,
              border: "none",
              borderTop: `1px solid ${C.line}`,
              background: "none",
              cursor: "pointer",
              fontFamily: font,
            }}
          >
            <span style={{ fontSize: 11.5, color: C.soft, fontVariantNumeric: "tabular-nums" }}>
              {tp("{n} account · total {amount} | {n} accounts · total {amount}", accountsGlobal.length, {
                n: String(accountsGlobal.length),
                amount: M(sumBalances(accountsGlobal)),
              })}
            </span>
            <span aria-hidden style={{ fontSize: 12, color: C.mute }}>
              ›
            </span>
          </button>
        </>
      )}
    </div>
  );
}

function MenuRow({ label, onClick }: { label: string; onClick: () => void }) {
  const C = useTheme();
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        width: "100%",
        minHeight: 30,
        padding: "6px 9px",
        borderRadius: 8,
        border: "none",
        background: "transparent",
        color: C.text,
        fontSize: 12.5,
        fontWeight: 650,
        cursor: "pointer",
        textAlign: "left",
        fontFamily: font,
      }}
    >
      {label}
    </button>
  );
}

/**
 * User block + upward-opening menu. A plain absolutely-positioned card INSIDE the rail — the
 * rail carries no CSS `transform`, so `position:fixed`/`absolute` here needs no portal (if any
 * ancestor ever gains one, this must move to `createPortal(document.body)` — house rule).
 * The same reasoning covers a SECOND hazard the transform rule doesn't name: an ancestor's
 * `overflow:hidden` clips a `position:absolute` descendant exactly like a transform-created
 * containing block does. The Rail root below carries no such clip (fixed at 68/236px per
 * `RAIL_W`, but deliberately `overflow: visible`) precisely so this menu — 236px wide on the
 * 68px fold rail — is never cut down to a sliver; if the root ever needs `overflow:hidden`
 * again (e.g. to clip something else), this menu must move to a portal at that point too.
 * The quick tiles are the Drawer's discreet/dark/settings trio VERBATIM: same keys, same
 * `aria-pressed`, same setters, same glyphs (`D_EYE`/`D_MOON`/`D_GEAR`, now exported from
 * chrome.tsx so this costs the phone bundle nothing new).
 */
function UserBlock({ mode, screen, onNav, onInstall }: { mode: WideMode; screen: ScreenId; onNav: (s: ScreenId) => void; onInstall: () => void }) {
  const C = useTheme();
  const { t } = useT();
  const { settings, setSettings } = useSettings();
  const { state: installState } = useInstall();
  const email = useSessionEmail();
  const [menuOpen, setMenuOpen] = useState(false);
  const darkOn = settings.themeMode === "dark";
  const canInstall = isInstallable(installState);
  const initial = (email?.trim()?.[0] ?? "?").toUpperCase();

  const quicks: Array<{ key: string; active: boolean; label: string; d: string; onClick: () => void }> = [
    {
      key: "discreet",
      active: settings.discreet,
      label: t("discreet"),
      d: D_EYE,
      onClick: () => setSettings({ ...settings, discreet: !settings.discreet }),
    },
    {
      key: "dark",
      active: darkOn,
      label: t("dark"),
      d: D_MOON,
      onClick: () => setSettings({ ...settings, themeMode: darkOn ? "light" : "dark" }),
    },
    {
      key: "settings",
      active: screen === "settings",
      label: t("settings"),
      d: D_GEAR,
      onClick: () => {
        setMenuOpen(false);
        onNav("settings");
      },
    },
  ];

  return (
    <div style={{ width: "100%", flexShrink: 0, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.line}`, position: "relative" }}>
      {menuOpen && (
        <>
          {/* click-away backdrop — plain fixed div (same idiom as Sheet/Drawer's own backdrop),
              no portal needed since the rail carries no CSS transform (see file header comment) */}
          <div onClick={() => setMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 15 }} />
          <div
            role="menu"
            style={{
              position: "absolute",
              bottom: "calc(100% + 6px)",
              left: 0,
              width: mode === "desktop" ? 212 : 236,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              background: C.card,
              border: `1px solid ${C.line}`,
              borderRadius: 12,
              padding: 10,
              boxShadow: "0 14px 32px rgba(0,0,0,0.18)",
              zIndex: 20,
            }}
          >
            <div style={{ display: "flex", gap: 6 }}>
              {quicks.map((q) => (
                <button
                  key={q.key}
                  onClick={q.onClick}
                  aria-label={q.label}
                  aria-pressed={q.key === "settings" ? undefined : q.active}
                  style={{
                    flex: 1,
                    minHeight: 44,
                    borderRadius: 10,
                    border: "none",
                    cursor: "pointer",
                    background: q.active ? "var(--cta-18)" : C.inset,
                    outline: q.active ? "1.5px solid var(--cta)" : "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Ico d={q.d} size={17} color={q.active ? "var(--cta)" : C.soft} sw={1.7} />
                </button>
              ))}
            </div>
            <MenuRow
              label={t("Sync now")}
              onClick={() => {
                setMenuOpen(false);
                void syncNow("manual");
              }}
            />
            {canInstall && (
              <MenuRow
                label={t("Install app")}
                onClick={() => {
                  setMenuOpen(false);
                  onInstall();
                }}
              />
            )}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                paddingTop: 8,
                borderTop: `1px solid ${C.line}`,
                fontSize: 10,
                color: C.mute,
                fontVariantNumeric: "tabular-nums",
                lineHeight: 1.5,
              }}
            >
              <span>{`v${APP_VERSION}`}</span>
              {buildLabel() ? <span style={{ opacity: 0.85 }}>{buildLabel()}</span> : null}
            </div>
          </div>
        </>
      )}
      <button
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={mode === "fold" ? t("Menu") : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: mode === "desktop" ? "flex-start" : "center",
          gap: 9,
          width: "100%",
          minHeight: 40,
          padding: mode === "desktop" ? "6px 8px" : "6px 0",
          borderRadius: 11,
          border: "none",
          cursor: "pointer",
          background: menuOpen ? C.inset : "transparent",
          fontFamily: font,
        }}
      >
        <span
          style={{
            width: 26,
            height: 26,
            flexShrink: 0,
            borderRadius: "50%",
            background: "var(--cta)",
            color: "#fff",
            fontSize: 11,
            fontWeight: 750,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {initial}
        </span>
        {mode === "desktop" && (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 10.5,
              color: C.mute,
              textAlign: "left",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {email ?? ""}
          </span>
        )}
      </button>
    </div>
  );
}

/**
 * The wide shell's navigation rail (spec §5-§10, demo lines 88-186): logo, five screen buttons,
 * a desktop-only "to be budgeted" card, and the user block/menu. Extends the task-4 skeleton
 * (`RailButton`, the plain icon-only rail) rather than replacing it — fold stays exactly what
 * task 4 shipped, desktop gains labels + the card. Entirely inside the lazy wide chunk.
 *
 * Divergence from task 4: the standalone bottom "Settings" gear button is REMOVED here. Task 4's
 * comment called it a placeholder ("a settings gear at the bottom") pending the user menu this
 * task adds; the demo's own `navItems` never included Settings as a sixth rail button (only the
 * five screens), and the user menu's "settings" quick tile (mirroring Drawer's phone pattern,
 * where Settings is likewise reachable ONLY through the Drawer's quick tile, never a BottomNav
 * tab) now covers that access without a redundant second affordance.
 */
export function Rail({
  mode,
  screen,
  onNav,
  state,
  onQuickAdd,
  onFillGoals,
  onInstall,
}: {
  mode: WideMode;
  screen: ScreenId;
  onNav: (s: ScreenId) => void;
  state: StateResponse;
  onQuickAdd: (kind: "transfer" | "import" | "suggest") => void;
  onFillGoals: () => void;
  onInstall: () => void;
}) {
  const C = useTheme();
  const { t } = useT();
  const items: ReadonlyArray<{ id: NavScreen; label: string }> = [
    { id: "start", label: t("Home") },
    { id: "budget", label: t("Budget") },
    { id: "transactions", label: t("Transactions") },
    { id: "reports", label: t("Reports") },
    { id: "accounts", label: t("Accounts") },
  ];
  return (
    // data-wide-rail: stable test hook — the verification playbook's geometry read and
    // touch-target sweep select on it (data-wide-primary/-panel/-band idiom), and PR6's plan
    // already references it by name.
    <div
      data-wide-rail
      style={{
        width: RAIL_W[mode],
        // `RAIL_W` is the rail's OUTER width — the geometry contract (geometry.ts) sums
        // rail + flexing primary + `paneWidthFor` to exactly the viewport. Without border-box,
        // desktop's 10px side padding + 1px border rendered 257px and quietly stole 21px from
        // the primary pane's `flex:1` share (fold: +1px, border only).
        boxSizing: "border-box",
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: mode === "desktop" ? "stretch" : "center",
        gap: 6,
        padding: mode === "desktop" ? "16px 10px" : "16px 0",
        background: C.surface,
        borderRight: `1px solid ${C.line}`,
        // NOT overflow:hidden — see the UserBlock comment above: an overflow-clipping ancestor
        // cuts an absolutely-positioned descendant exactly like a transform-created containing
        // block would, and this root is one (the 236px menu vs. a 68px fold rail). Task 4's
        // original icon-only skeleton carried this style with nothing that needed clipping;
        // task 5 built the real menu on top of it unchanged, which is what clipped it.
        overflow: "visible",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: mode === "desktop" ? "0 4px 8px" : "0 0 4px", marginBottom: 4 }}>
        <LogoMark size={mode === "desktop" ? 28 : 32} />
        {mode === "desktop" && <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Enveo</span>}
      </div>
      {items.map((it) =>
        mode === "desktop" ? (
          <NavRow key={it.id} active={screen === it.id} d={NAV_ICONS[it.id]} label={it.label} onClick={() => onNav(it.id)} />
        ) : (
          <RailButton key={it.id} active={screen === it.id} d={NAV_ICONS[it.id]} label={it.label} onClick={() => onNav(it.id)} />
        ),
      )}
      <div style={{ flex: 1, minHeight: 8 }} />
      {mode === "desktop" && <TbbCard state={state} screen={screen} onQuickAdd={onQuickAdd} onFillGoals={onFillGoals} onNav={onNav} />}
      <UserBlock mode={mode} screen={screen} onNav={onNav} onInstall={onInstall} />
    </div>
  );
}
