import { computeStateResponse } from "@enveo/shared";
import { useEffect, useMemo, useState } from "react";
import type { StateResponse } from "../../lib/api";
import { apiErrorMessage, useLedgerVersion, useSyncStatus } from "../../lib/api";
import { authClient } from "../../lib/auth";
import { useMask, useSettings, useTheme } from "../../lib/contexts";
import { currentMonth, relSync, todayISO } from "../../lib/dates";
import { LOCALE_OF } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Ico } from "../../lib/icons";
import { isInstallable, useInstall } from "../../lib/installPrompt";
import { completeExplicitSignOut, ExplicitSignOutPendingError } from "../../lib/signOut";
import { store } from "../../lib/store";
import type { SyncStatus } from "../../lib/sync";
import { syncNow } from "../../lib/sync";
import type { Theme } from "../../lib/theme";
import { font, TEAL, tint } from "../../lib/theme";
import { monthRuler, sumBalances, tbbState } from "../../lib/uiState";
import { APP_VERSION, buildLabel } from "../../lib/version";
import { RAIL_W, type ViewMode } from "../../lib/viewMode";
import { D_EYE, D_GEAR, D_MOON, LogoMark, NAV_ICONS, type ScreenId } from "../chrome";
import { checkForUpdate, useAppUpdate } from "../UpdatePrompt";

type WideMode = Exclude<ViewMode, "phone">;

/** The five screens the rail navigates between — a strict subset of `ScreenId` (no
 *  `addExpense`/`settings`: Add lives in the band's `+ Add` button, Settings behind the user
 *  menu's gear tile — pr4-context.md §0b items 6 and 12). */
type NavScreen = "start" | "budget" | "transactions" | "reports" | "accounts";

/**
 * The signed-in user's name + email — read once from `lib/auth.ts`, the ONE session source of
 * truth, rather than threading it down from App (nothing else in the wide chunk needs a session
 * subscription yet). Both `null` while unresolved or genuinely absent; a mount that unmounts
 * before the fetch settles is guarded by `alive` the same way `hasSession()` guards its own read.
 * `name` defaults to the email's local part at sign-up (`lib/auth.ts` `signUpEmail`), so it is
 * never empty for an account created after that default landed — still guarded here in case an
 * older/imported account row has a blank one.
 */
function useSessionUser(): { name: string | null; email: string | null } {
  const [user, setUser] = useState<{ name: string | null; email: string | null }>({ name: null, email: null });
  useEffect(() => {
    let alive = true;
    void authClient
      .getSession()
      .then((s) => {
        if (!alive) return;
        const u = (s as { data?: { user?: { name?: string; email?: string } } })?.data?.user;
        setUser({ name: u?.name?.trim() || null, email: u?.email ?? null });
      })
      .catch(() => {
        if (alive) setUser({ name: null, email: null });
      });
    return () => {
      alive = false;
    };
  }, []);
  return user;
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

/**
 * Desktop: icon + full label, full-width row (pr4-context.md §12.1's decided reading — icon
 * language shared with `RailButton`/`BottomNav` via `NAV_ICONS`).
 *
 * Design parity wave A, task A2 (demo 94, 2439-2440): the selected row is `railActive`
 * (accent@18%) with INK text/icon (`headerInk` — equals `C.text` on every Cisza theme, but the
 * only token that also reads correctly on Duet's navy rail) — NOT an accent-tinted background
 * with accent-colored text.
 */
function NavRow({ active, d, label, onClick }: { active: boolean; d: string; label: string; onClick: () => void }) {
  const C = useTheme();
  // demo 2439-2440: `fg: active ? T.railTitle : T.railOn` — ONE color for icon+label either way.
  // `headerInk` equals `C.text` on every Cisza theme but is the only token that ALSO reads
  // correctly on Duet's navy rail; `railOn` is its inactive-tier counterpart (added alongside it
  // — `C.text`/`C.soft` are NOT Duet-overridden and rendered illegible dark text on the navy rail,
  // caught live during verification).
  const fg = active ? C.headerInk : C.railOn;
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
        background: active ? C.railActive : "transparent",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: font,
      }}
    >
      <Ico d={d} size={19} color={fg} sw={1.8} />
      <span
        style={{
          fontSize: 13.5,
          fontWeight: active ? 700 : 600,
          color: fg,
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
  onOpenAccount,
}: {
  state: StateResponse;
  screen: ScreenId;
  onQuickAdd: (kind: "transfer" | "import" | "suggest") => void;
  onFillGoals: () => void;
  onNav: (s: ScreenId) => void;
  /** PR6b Task 3: each account row deep-links straight into the account pane (nav + select in one
   *  batch) — the summary row and the collapsed-section header below keep `onNav("accounts")`. */
  onOpenAccount: (id: string) => void;
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

  // Design parity wave A, task A2 (demo 110-111): Suggest is a FILLED ink pill (background =
  // `headerInk`, text = the rail's OWN background, so it inverts correctly on Duet's navy rail);
  // Fill-by-goals stays the plain outline it already was — its border is `railRuler` (design's
  // `T.railRuler`, demo 111), not the content-surface `line` (fix-review: `line`'s opaque Duet
  // cream rendered a visible tan outline on the near-navy rail card).
  const pill = (primary: boolean): React.CSSProperties => ({
    flex: 1,
    minHeight: 30,
    textAlign: "center",
    borderRadius: 999,
    border: primary ? `1.5px solid ${C.headerInk}` : `1px solid ${C.railRuler}`,
    background: primary ? C.headerInk : "transparent",
    color: primary ? C.railBg : C.railOn,
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
        padding: "12px 12px 10px",
        borderRadius: 14,
        background: C.railCard,
      }}
    >
      <span style={{ fontSize: 10, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.railMute }}>{t("To be budgeted")}</span>
      <span style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.015em", color: tbbColor, fontVariantNumeric: "tabular-nums", marginTop: 3 }}>
        {M(state.readyToAssign)}
      </span>
      {/* Design parity wave A, task A2 (demo 101-104): one neutral tone for the whole line — no
          red/green on these arrows (that reading lives on the ledger, not this summary). */}
      <span
        style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, color: C.railOn, fontVariantNumeric: "tabular-nums", marginTop: 5 }}
      >
        <span>↑ {M(state.monthIncome)}</span>
        <span>↓ {M(state.monthExpense)}</span>
      </span>
      {/* Track is `railRuler` (design's `T.railRuler`, demo 105) — fix-review: was `line`, whose
          opaque Duet cream rendered a visible tan track on the near-navy rail card; the fill was
          already correctly `railMute` before this fix. */}
      <span style={{ height: 3, borderRadius: 2, background: C.railRuler, position: "relative", display: "block", marginTop: 7 }}>
        <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${ruler.pct}%`, borderRadius: 2, background: C.railMute, display: "block" }} />
      </span>
      <span style={{ fontSize: 10, color: C.railMute, marginTop: 5 }}>{t("{date} · {pct}% of month", { date: shortDay, pct: String(ruler.pct) })}</span>
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
              marginTop: 12,
              paddingTop: 10,
              border: "none",
              // `railRuler` (design's `T.railRuler`, demo 114) — fix-review, see the pill/ruler
              // comments above for why `line` was wrong here.
              borderTop: `1px solid ${C.railRuler}`,
              background: "none",
              cursor: "pointer",
              fontFamily: font,
            }}
          >
            <span style={{ fontSize: 10, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.railMute }}>{t("Accounts")}</span>
            <span aria-hidden style={{ fontSize: 10, color: C.railMute }}>
              {acctsOpen ? "▴" : "▾"}
            </span>
          </button>
          {acctsOpen && accountsGlobal.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 5, maxHeight: 168, overflowY: "auto" }}>
              {accountsGlobal.map((a) => (
                <button
                  key={a.id}
                  onClick={() => onOpenAccount(a.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    minHeight: 30,
                    padding: "5px 6px",
                    borderRadius: 8,
                    border: "none",
                    background: "none",
                    cursor: "pointer",
                    fontFamily: font,
                    textAlign: "left",
                  }}
                >
                  <span style={{ width: 14, height: 14, borderRadius: "50%", background: a.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.railOn, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {a.name}
                  </span>
                  <span
                    style={{
                      flexShrink: 0,
                      fontWeight: 650,
                      fontSize: 12.5,
                      color: a.balance < 0 ? C.neg : a.balance === 0 ? C.railMute : C.railOn,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
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
              // `railRuler` (design's `T.railRuler`, demo 129) — NOT `railBorder`: demo 129 is the
              // 'view all accounts' row (matched by its own `acctCountLine` content below), the
              // SAME token as the 'Accounts' header divider two rows up; `railBorder` is a
              // different, unrelated divider (demo 135, outside this card, above the user block —
              // see `UserBlock`'s own top border below). Design parity wave A close, item 1: an
              // earlier fix-review pass mis-cited demo 129 as `railBorder` and applied the wrong
              // token, leaving this divider transparent on Duet while its sibling above read
              // `railRuler` correctly.
              borderTop: `1px solid ${C.railRuler}`,
              background: "none",
              cursor: "pointer",
              fontFamily: font,
            }}
          >
            {/* Design parity wave A, task A2 (demo 129): the whole summary row reads `railMute`. */}
            <span style={{ fontSize: 11.5, color: C.railMute, fontVariantNumeric: "tabular-nums" }}>
              {tp("{n} account · total {amount} | {n} accounts · total {amount}", accountsGlobal.length, {
                n: String(accountsGlobal.length),
                amount: M(sumBalances(accountsGlobal)),
              })}
            </span>
            <span aria-hidden style={{ fontSize: 12, color: C.railMute }}>
              ›
            </span>
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Update notification, desktop only (design-parity wave A, task A4; owner-requirements.md #3,
 * screenshot-backed): a card in the rail between the TBB card and the user block, shown only
 * while a waiting service worker has been detected — not a floating toast, not primary-pane
 * anchored (that treatment stays on fold via `UpdatePrompt`'s own anchored banner; `Rail`'s
 * caller only mounts this when `mode === "desktop"`). Styled on the same `railCard` grammar as
 * `TbbCard` above it (14px radius, white/`railCard` surface).
 */
function RailUpdateCard({ version, onRefresh, onDismiss }: { version: string; onRefresh: () => void; onDismiss: () => void }) {
  const C = useTheme();
  const { t } = useT();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", borderRadius: 14, background: C.railCard }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--cta)", flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700, color: C.railOn }}>{t("New version ready")}</span>
        <button
          onClick={onDismiss}
          aria-label={t("Close")}
          style={{
            flexShrink: 0,
            minWidth: 30,
            minHeight: 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            background: "transparent",
            color: C.railMute,
            fontSize: 16,
            lineHeight: 1,
            cursor: "pointer",
          }}
        >
          ×
        </button>
      </div>
      <span style={{ fontSize: 11, lineHeight: 1.4, color: C.railMute }}>
        {t("Currently v{version} · refreshing takes a second, nothing is lost.", { version })}
      </span>
      <button
        onClick={onRefresh}
        style={{
          alignSelf: "flex-start",
          minHeight: 30,
          padding: "0 11px",
          display: "flex",
          alignItems: "center",
          borderRadius: 8,
          border: `1px solid ${TEAL}`,
          background: "transparent",
          color: TEAL,
          fontSize: 11.5,
          fontWeight: 700,
          cursor: "pointer",
          fontFamily: font,
        }}
      >
        {t("Refresh now")}
      </button>
    </div>
  );
}

/**
 * A `userMenu` list row (design v3:158-163): label left, an optional muted `hint` right
 * (design's `m.hint`, e.g. "clears local copy" on Log out) — `justify-content: space-between`,
 * not two independent spans, so the hint stays pinned to the row's own right edge regardless of
 * label length. `color` overrides the label's tone (design's `m.color`, e.g. `T.neg` for Log out).
 */
function MenuRow({ label, hint, color, disabled, onClick }: { label: string; hint?: string; color?: string; disabled?: boolean; onClick: () => void }) {
  const C = useTheme();
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        width: "100%",
        minHeight: 30,
        padding: "8px 9px",
        borderRadius: 8,
        border: "none",
        background: "transparent",
        color: color ?? C.text,
        fontSize: 12.5,
        fontWeight: 650,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        textAlign: "left",
        fontFamily: font,
        whiteSpace: "nowrap",
      }}
    >
      <span>{label}</span>
      {hint && (
        <span aria-hidden style={{ fontSize: 11, color: C.mute, whiteSpace: "nowrap" }}>
          {hint}
        </span>
      )}
    </button>
  );
}

type TFn = ReturnType<typeof useT>["t"];

/**
 * Dot + short label, shared by the persistent rail sync row (design v3:178-182) AND the
 * popover's `SyncCard` header (v3:145-149) — the SAME precedence `SyncBadge`
 * (`components/SyncBadge.tsx`) uses for its own dot (dead letters, then the sticky
 * `ownerUnproven`, then `SyncState`), so all three surfaces never disagree about which state
 * the user is looking at.
 */
function syncBrief(status: SyncStatus, C: Theme, t: TFn): { dot: string; label: string } {
  if (status.deadLetters > 0) return { dot: C.neg, label: t("Sync failed") };
  if (status.state === "unauthed") return { dot: C.mute, label: t("Session expired") };
  if (status.ownerUnproven) return { dot: C.mute, label: t("Not sending") };
  if (status.state === "syncing") return { dot: "var(--cta)", label: t("Syncing…") };
  if (status.state === "offline") return { dot: C.mute, label: t("Offline") };
  if (status.state === "error") return { dot: C.neg, label: t("Sync failed") };
  return { dot: C.pos, label: t("Synced") };
}

/**
 * Full sync-status card (design v3:145-157): dot + label + a short description + one action
 * button. Reads the SAME `useSyncStatus()` the header's `SyncBadge` reads — one sync source of
 * truth, no second poll. `onNav`+`onClose` let the action route to Settings for the two states a
 * blind retry cannot fix (a rejected op needs a human "Discard" decision there; an unproven
 * replica needs the recheck flow there) — SyncBadge's own `onOpenSync` already treats "unauthed"
 * the same way, so this reuses that exact convention rather than inventing a fourth outcome.
 *
 * Design parity wave A close, item 5: the design's `sync.queueLine`/`queueDisplay` (a
 * right-aligned "{n} changes waiting" count in this same header row) is deliberately NOT
 * implemented — this card's `detail` text below already carries the identical pending-change
 * count in prose for every state that has one (offline, idle-with-pending), so a second, terser
 * copy of the same number in the header would only duplicate it, not add information.
 */
function SyncCard({ onNav, onClose }: { onNav: (s: ScreenId) => void; onClose: () => void }) {
  const C = useTheme();
  const { t, tp, lang } = useT();
  const status = useSyncStatus();
  const { state, pending, deadLetters, lastSyncAt, ownerUnproven } = status;
  const { dot, label } = syncBrief(status, C, t);
  // Design parity fix (v3:145, `sync.border2`): the card's OUTLINE turns danger-toned in lockstep
  // with the dot for the two states that need a human decision (a rejected op, or a hard sync
  // error) — the SAME precedence the dot above already uses, so the border never disagrees with
  // it. `tint(C.neg, 0.32)` (design's `negLine`, e.g. Cisza `rgba(209,75,62,0.32)`) — NOT the
  // global `CORAL` constant, which is a single brand-danger swatch identical across every accent
  // theme and so drifted from the dot's own `C.neg` (design parity wave A close, item 5: the
  // border and the dot rendered two visibly different reds).
  const cardBorder = deadLetters > 0 || state === "error" ? tint(C.neg, 0.32) : C.line;

  let detail = t("Last sync: {rel}.", { rel: relSync(lastSyncAt, lang) });
  let action: "sync" | "review" = "sync";

  if (deadLetters > 0) {
    // Reuses SyncBadge's exact aria-label copy (already carries "— tap to open settings",
    // which now literally describes the button below) rather than adding a near-duplicate key.
    detail = tp("The server rejected {n} change — tap to open settings | The server rejected {n} changes — tap to open settings", deadLetters);
    action = "review";
  } else if (state === "unauthed") {
    detail = t("Local changes stay safe until you sign in again.");
    action = "review";
  } else if (ownerUnproven) {
    detail = t("This device's data has not been matched to your account — nothing is being sent to the server. Tap to open settings");
    action = "review";
  } else if (state === "syncing") {
    detail = t("Sending local changes. The app stays usable while it runs.");
  } else if (state === "offline") {
    detail =
      pending > 0
        ? `${tp("{n} change is waiting to be sent | {n} changes are waiting to be sent", pending)}. ${t("We will send them once the server is reachable.")}`
        : t("No connection — changes are queued and will send automatically.");
  } else if (state === "error") {
    detail = t("Server temporarily unreachable — your data is safe, we will retry.");
  } else if (pending > 0) {
    detail = `${detail} ${tp("{n} change is waiting to be sent | {n} changes are waiting to be sent", pending)}.`;
  }

  const busy = state === "syncing";
  const doAction = () => {
    onClose();
    if (action === "review") onNav("settings");
    else void syncNow("manual");
  };

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 7, padding: "9px 10px", borderRadius: 10, background: C.bg, border: `1px solid ${cardBorder}` }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{label}</span>
      </div>
      <span style={{ fontSize: 11, lineHeight: 1.45, color: C.soft }}>{detail}</span>
      <button
        onClick={doAction}
        disabled={busy}
        style={{
          alignSelf: "flex-start",
          minHeight: 30,
          display: "flex",
          alignItems: "center",
          fontSize: 11,
          fontWeight: 700,
          color: action === "review" ? "#fff" : TEAL,
          background: action === "review" ? "var(--cta)" : "transparent",
          border: action === "review" ? "none" : `1px solid ${TEAL}`,
          borderRadius: 8,
          padding: "0 11px",
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.7 : 1,
          fontFamily: font,
        }}
      >
        {action === "review" ? t("Open Settings") : t("Sync now")}
      </button>
    </div>
  );
}

/**
 * The popover's "Log out" row. Reuses the EXACT explicit-sign-out routine Settings uses
 * (`lib/signOut.ts` — pending-write recovery, replica/DEK cleanup, the multi-tenant guard) rather
 * than re-implementing it: `completeExplicitSignOut`/`ExplicitSignOutPendingError` already ARE
 * the shared lib entry (`screens/settings/DataSection.tsx`'s `LogoutSection` calls the same two).
 * Unsent changes need a human decision (retry/export/discard) that already has a full surface in
 * Settings → Data & sync — rather than rebuilding that recovery UI inside a 212px popover, this
 * routes there and lets the human choose (the confirm dialog above is IDENTICAL copy either way,
 * so nothing about the decision itself changes, only where the recovery choices are presented).
 */
function LogoutMenuRow({ onNav, onClose }: { onNav: (s: ScreenId) => void; onClose: () => void }) {
  const C = useTheme();
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doLogout = () => {
    if (!window.confirm(t("Sign out and remove this account's local data from this device? Your data already on the server will stay there."))) return;
    setBusy(true);
    setError(null);
    void completeExplicitSignOut("retry").catch((e: unknown) => {
      if (e instanceof ExplicitSignOutPendingError) {
        onClose();
        onNav("settings");
        return;
      }
      setError(apiErrorMessage(e));
      setBusy(false);
    });
    // On success `completeExplicitSignOut` reloads the page itself — nothing to do here.
  };

  return (
    <>
      <MenuRow label={t("Sign out")} hint={t("clears local copy")} color={C.neg} onClick={doLogout} disabled={busy} />
      {error && <div style={{ fontSize: 10.5, color: C.neg, padding: "0 9px", lineHeight: 1.4 }}>{error}</div>}
    </>
  );
}

/**
 * User block + upward-opening menu. A plain absolutely-positioned card INSIDE the rail — the
 * rail carries no CSS `transform`, so `position:fixed`/`absolute` here needs no portal (if any
 * ancestor ever gains one, this must move to `createPortal(document.body)` — house rule).
 * The same reasoning covers a SECOND hazard the transform rule doesn't name: an ancestor's
 * `overflow:hidden` clips a `position:absolute` descendant exactly like a transform-created
 * containing block does. The Rail root below carries no such clip (fixed at 68/236px per
 * `RAIL_W`, but deliberately `overflow: visible`) precisely so this menu — 232px wide even on the
 * 68px fold rail — is never cut down to a sliver; if the root ever needs `overflow:hidden`
 * again (e.g. to clip something else), this menu must move to a portal at that point too.
 * The quick tiles are the Drawer's discreet/dark/settings trio VERBATIM: same keys, same
 * `aria-pressed`, same setters, same glyphs (`D_EYE`/`D_MOON`/`D_GEAR`, now exported from
 * chrome.tsx so this costs the phone bundle nothing new) — now with the design's visible text
 * label under each icon (v3:138-143) and its on/off coloring (`accentSoft`/accent border+fg vs.
 * plain `bg`/`line`/`soft`, v3:4269-4276), not the app's own `--cta-18`/`inset` treatment used
 * elsewhere in the rail: these tiles read status (on/off), not selection, and the design keys
 * that reading to the SAME accent family the rest of the rail already uses for accent state.
 *
 * Design parity wave A, task A3 (gaps-rail-band.md #1, owner-requirements.md — every "Wybierz…"-
 * style placeholder is a defect, and a missing "Log out" is the same class of defect): the
 * identity row grows a display-name line + trailing gear glyph, a persistent sync line sits
 * below it (desktop only, v3:178-182), and the popover gains the full sync-status card
 * (`SyncCard`), the real "Log out" (`LogoutMenuRow`, reusing Settings' own sign-out routine —
 * see that component's header comment) and a "Check for updates" link next to the version line
 * (v3:164-166) — `checkForUpdate` reads the SAME live `ServiceWorkerRegistration` `UpdatePrompt`
 * already keeps (one registration, no second `registerSW()` call).
 */
function UserBlock({ mode, screen, onNav, onInstall }: { mode: WideMode; screen: ScreenId; onNav: (s: ScreenId) => void; onInstall: () => void }) {
  const C = useTheme();
  const { t } = useT();
  const { settings, setSettings } = useSettings();
  const { state: installState } = useInstall();
  const { name, email } = useSessionUser();
  const syncStatus = useSyncStatus();
  const [menuOpen, setMenuOpen] = useState(false);
  const darkOn = settings.themeMode === "dark";
  const canInstall = isInstallable(installState);
  const displayName = name ?? email ?? t("Account");
  const initial = (displayName.trim()[0] ?? "?").toUpperCase();
  const closeMenu = () => setMenuOpen(false);
  const { dot: syncDot, label: syncLabel } = syncBrief(syncStatus, C, t);
  // Design parity wave A close, item 4 (v3:3135-3137): the persistent row's own error treatment —
  // SAME precedence `syncBrief`'s dot already uses (dead letters, then a hard sync error), so the
  // row's background/ink never disagree with the dot sitting right next to them.
  const isSyncError = syncStatus.deadLetters > 0 || syncStatus.state === "error";

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
    <div
      style={{
        width: "100%",
        flexShrink: 0,
        marginTop: 10,
        paddingTop: 10,
        // `railBorder` (design's `T.railBorder`, demo 135 — the divider above the user block,
        // outside the TbbCard) — design parity wave A close, item 1.
        borderTop: `1px solid ${C.railBorder}`,
        position: "relative",
      }}
    >
      {menuOpen && (
        <>
          {/* click-away backdrop — plain fixed div (same idiom as Sheet/Drawer's own backdrop),
              no portal needed since the rail carries no CSS transform (see file header comment) */}
          <div onClick={closeMenu} style={{ position: "fixed", inset: 0, zIndex: 15 }} />
          <div
            role="menu"
            style={{
              position: "absolute",
              bottom: "calc(100% + 6px)",
              left: 0,
              width: mode === "desktop" ? 212 : 232,
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
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                    padding: "9px 4px",
                    borderRadius: 10,
                    background: q.active ? C.accentSoft : C.bg,
                    border: `1px solid ${q.active ? TEAL : C.line}`,
                    cursor: "pointer",
                  }}
                >
                  <Ico d={q.d} size={15} color={q.active ? TEAL : C.soft} sw={1.7} />
                  <span style={{ fontSize: 10, color: C.mute, fontFamily: font }}>{q.label}</span>
                </button>
              ))}
            </div>
            <SyncCard onNav={onNav} onClose={closeMenu} />
            {canInstall && (
              <MenuRow
                label={t("Install app")}
                onClick={() => {
                  closeMenu();
                  onInstall();
                }}
              />
            )}
            <LogoutMenuRow onNav={onNav} onClose={closeMenu} />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                paddingTop: 8,
                borderTop: `1px solid ${C.line}`,
                fontSize: 10.5,
                color: C.mute,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {/* Design parity fix (v3:165, derivation 4189): the popover footer's own field is the
                  literal `appVersion` — brand + bare version, NEVER the build stamp. The combined
                  "v{version} · build …" string belongs to the persistent rail row below (v3:181,
                  derivation 4354) — the two were swapped in the first pass of this task. */}
              <span>{`Enveo v${APP_VERSION}`}</span>
              <button
                onClick={() => {
                  closeMenu();
                  checkForUpdate();
                }}
                style={{
                  flexShrink: 0,
                  minHeight: 30,
                  display: "flex",
                  alignItems: "center",
                  border: "none",
                  background: "none",
                  padding: "0 2px",
                  color: TEAL,
                  fontSize: 10.5,
                  fontWeight: 650,
                  cursor: "pointer",
                  fontFamily: font,
                }}
              >
                {t("Check for updates")}
              </button>
            </div>
          </div>
        </>
      )}
      <button
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={mode === "desktop" ? t("Account, settings and sign out") : undefined}
        aria-label={mode === "fold" ? t("Account, settings and sign out") : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: mode === "desktop" ? "flex-start" : "center",
          gap: 9,
          width: "100%",
          minHeight: 40,
          padding: mode === "desktop" ? "8px 9px" : "9px 0",
          borderRadius: 11,
          border: "none",
          cursor: "pointer",
          background: menuOpen ? C.railActive : "transparent",
          fontFamily: font,
        }}
      >
        <span
          style={{
            width: 26,
            height: 26,
            flexShrink: 0,
            borderRadius: "50%",
            // `logo`/`railBg` (design's `T.logo`/`T.railBg`, demo 172) — NOT the CTA coral, which
            // showed regardless of the user's actual accent (design parity wave A close, item 2).
            background: C.logo,
            color: C.railBg,
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
          <>
            <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", textAlign: "left" }}>
              <span style={{ fontSize: 12.5, fontWeight: 650, color: C.headerInk, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {displayName}
              </span>
              {email && <span style={{ fontSize: 10.5, color: C.railMute, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</span>}
            </span>
            <span aria-hidden style={{ fontSize: 12, color: C.railMute, flexShrink: 0 }}>
              ⚙
            </span>
          </>
        )}
      </button>
      {/* Persistent sync line (design v3:178-182) — always visible on desktop, never inside the
          popover: the one status a user should see without opening anything. Clicking it opens
          the SAME popover (design's `sync.onToggle` is literally `onToggleUserMenu`). */}
      {mode === "desktop" && (
        <button
          onClick={() => setMenuOpen((v) => !v)}
          title={t("Account, settings and sign out")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
            minHeight: 30,
            marginTop: 4,
            padding: "0 9px",
            borderRadius: 8,
            border: "none",
            // Design parity wave A close, item 4 (v3:3136): a flat literal, not per-theme — the
            // design keeps this exact tint regardless of Cisza/Duet (unlike the ink just below,
            // which IS per-theme), so it stays a bare constant rather than a new token.
            background: isSyncError ? "rgba(209,75,62,0.16)" : "none",
            cursor: "pointer",
          }}
        >
          <span aria-hidden style={{ width: 5, height: 5, borderRadius: "50%", background: syncDot, flexShrink: 0 }} />
          {/* Design parity wave A close, item 4 (v3:3137, `T.negBandInk`): the label's ink flips to
              the theme's own error-ink for this row (Duet's is deliberately lighter than
              `headerInk`/`headerNeg` — see the token's own doc comment). */}
          <span
            style={{
              flexShrink: 0,
              fontSize: 9.5,
              fontWeight: 650,
              letterSpacing: "0.02em",
              color: isSyncError ? C.negBandInk : C.headerInk,
              fontFamily: font,
            }}
          >
            {syncLabel}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              textAlign: "right",
              fontSize: 9.5,
              color: C.railMute,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {/* Design parity fix (v3:181, derivation 4354): `buildLine` is version-ALWAYS-prefixed
                ("v3.8.0 · build 2026-08-16 13:34") — this is the one row the owner needs to read
                his build off without opening anything, so it must never degrade to the build stamp
                ALONE (which drops the version the instant a build stamp exists — the normal case). */}
            {`v${APP_VERSION}${buildLabel() ? ` · ${buildLabel()}` : ""}`}
          </span>
        </button>
      )}
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
  onOpenAccount,
}: {
  mode: WideMode;
  screen: ScreenId;
  onNav: (s: ScreenId) => void;
  state: StateResponse;
  onQuickAdd: (kind: "transfer" | "import" | "suggest") => void;
  onFillGoals: () => void;
  onInstall: () => void;
  /** PR6b Task 3: threaded straight to `TbbCard`'s account rows — see that prop's own comment. */
  onOpenAccount: (id: string) => void;
}) {
  const C = useTheme();
  const { t } = useT();
  // Design-parity wave A, task A4: the ONE shared update-state consumer (`UpdatePrompt.tsx`) —
  // called unconditionally (rules of hooks; `mode` can change under this same component across
  // a fold↔desktop resize) but only rendered below when `mode === "desktop"`; fold keeps its
  // existing anchored `<UpdatePrompt/>` banner (mounted by `WideShell`), not this card.
  const { needRefresh, version, refresh, dismiss } = useAppUpdate();
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
        // Design parity wave A, task A2 (demo 87): the rail's five top-level sections (logo,
        // nav group, spacer, TBB card, user block) are spaced by ONE gap of 10px on desktop —
        // fold keeps its existing 6px (its own layout gate is a later, separate audit pass).
        gap: mode === "desktop" ? 10 : 6,
        padding: mode === "desktop" ? "16px 12px" : "16px 0",
        // Desktop only: fold's icon-only rail (`RailButton`) still colors its active/inactive
        // icons off `TEAL`/`C.soft` (task 4's original skeleton, unchanged here — fold's own
        // layout gate is a later, separate audit pass), which read correctly against the
        // existing `C.surface`. Painting `C.railBg` there too would go navy under Duet while
        // those icon colors stay Cisza-calibrated — invisible-icon regression, not a fold gap.
        background: mode === "desktop" ? C.railBg : C.surface,
        // `railBorder` (design's `T.railBorder`, demo 87 — the rail's OWN outer separator, not
        // the content surface's `line`) — design parity wave A close, item 1.
        borderRight: `1px solid ${C.railBorder}`,
        // NOT overflow:hidden — see the UserBlock comment above: an overflow-clipping ancestor
        // cuts an absolutely-positioned descendant exactly like a transform-created containing
        // block would, and this root is one (the 236px menu vs. a 68px fold rail). Task 4's
        // original icon-only skeleton carried this style with nothing that needed clipping;
        // task 5 built the real menu on top of it unchanged, which is what clipped it.
        overflow: "visible",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: mode === "desktop" ? "0 4px 4px" : "0 0 4px",
          marginBottom: mode === "desktop" ? 0 : 4,
        }}
      >
        <LogoMark size={mode === "desktop" ? 28 : 32} />
        {/* `headerInk` (design's `T.railTitle`, demo 90) — NOT `text`, which is calibrated for
            Cisza's cream content surfaces and read as near-illegible dark text on Duet's navy
            rail (design parity wave A close, item 3; same reasoning as `NavRow`'s `fg` above). */}
        {mode === "desktop" && <span style={{ fontSize: 15, fontWeight: 700, color: C.headerInk }}>Enveo</span>}
      </div>
      {/* Design parity wave A, task A2 (demo 92): the nav rows form their OWN column, 3px apart
          on desktop — a distinct gap from the 10px separating the rail's top-level sections. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: mode === "desktop" ? 3 : 6,
          alignItems: mode === "desktop" ? "stretch" : "center",
          width: "100%",
        }}
      >
        {items.map((it) =>
          mode === "desktop" ? (
            <NavRow key={it.id} active={screen === it.id} d={NAV_ICONS[it.id]} label={it.label} onClick={() => onNav(it.id)} />
          ) : (
            <RailButton key={it.id} active={screen === it.id} d={NAV_ICONS[it.id]} label={it.label} onClick={() => onNav(it.id)} />
          ),
        )}
      </div>
      <div style={{ flex: 1, minHeight: 8 }} />
      {mode === "desktop" && (
        <TbbCard state={state} screen={screen} onQuickAdd={onQuickAdd} onFillGoals={onFillGoals} onNav={onNav} onOpenAccount={onOpenAccount} />
      )}
      {mode === "desktop" && needRefresh && <RailUpdateCard version={version} onRefresh={() => refresh(true)} onDismiss={dismiss} />}
      <UserBlock mode={mode} screen={screen} onNav={onNav} onInstall={onInstall} />
    </div>
  );
}
