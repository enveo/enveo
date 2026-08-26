import { useState } from "react";
import { useSyncStatus } from "../../lib/api";
import { useBudgetPreferences, useTheme } from "../../lib/contexts";
import { relSync } from "../../lib/dates";
import { type Lang, type Message, msg, useT } from "../../lib/i18n";
import { font, TEAL, tint } from "../../lib/theme";
import { APP_VERSION, buildLabel } from "../../lib/version";
import type { ViewMode } from "../../lib/viewMode";
import { SETTINGS_CATEGORIES, type SubId } from "../../screens/Settings";
import { AiSection } from "../../screens/settings/Ai";
import { AppearanceSection } from "../../screens/settings/Appearance";
import { DataSection, useLogoutFlow } from "../../screens/settings/DataSection";
import { DictionariesSection } from "../../screens/settings/Dictionaries";
import { PrivacySection } from "../../screens/settings/PrivacySection";
import { useSessionUser } from "./Rail";

type WideMode = Exclude<ViewMode, "phone">;
/** `SETTINGS_CATEGORIES`'s 5 drill-in ids, plus the wide-only 6th section (owner rule 5): the
 *  Account identity + sign-out card the phone hub never shows as its own row (it renders
 *  `LogoutSection` inline at the bottom of the hub instead — `screens/Settings.tsx`'s `Hub`). */
type WideSection = SubId | "account";

/** Fold's short nav labels (v3:4200: `label: isFold ? g[4] : g[1]`) — the paired half of fold's
 *  column-direction row layout (below): a 142px column leaves ~106px of text room (142 - 16px
 *  outer padding - 20px button padding), which the long category titles ("Categories and places",
 *  "Artificial intelligence", "Privacy and encryption") clearly exceed. "Account" is omitted: its
 *  design short label (v3:4197, `g[4]` = "Account") is byte-identical to its long one, so the plain
 *  `t("Account")` below already matches both widths. */
const FOLD_LABEL: Record<SubId, Message> = {
  appearance: msg("Appearance"),
  dictionaries: msg("Dictionaries"),
  ai: msg("AI"),
  privacy: msg("Privacy"),
  data: msg("Data & sync"),
};

/**
 * Persistent two-column Settings (design parity wave E task 3, owner rule 5, v3:675-744): a
 * 218px left nav listing all 6 sections at once — never a drill-in, never a back arrow — and a
 * right content column that swaps in place. Replaces `WideShell`'s interim centered-column
 * wrapper around the phone `SettingsScreen`; every section body below is the SAME
 * `screens/settings/*` component the phone hub drills into (zero phone deltas — those components
 * render identically in every mode), so this file owns only the two-column frame, the nav rows'
 * own copy/badges, and the Account section (phone has no equivalent row: it renders
 * `LogoutSection` as a hub footer instead).
 *
 * Local `section` state, not App-owned: nothing outside this component needs to know which
 * Settings section is open (unlike `envView`/`acctView`/`reportsView`, which the URL/deep-link
 * machinery and the right PANEL also read) — the right panel's own account context (owner rule 1)
 * survives navigating here for free, since `App.tsx`'s `nav()` already special-cases `"settings"`
 * to leave `acctView` untouched (design parity wave A task 1) and `resolvePanel` already treats
 * `"settings"` exactly like `"accounts"` (`panel.ts`) — this component changes neither.
 */
export function WideSettings({ mode }: { mode: WideMode }) {
  const C = useTheme();
  const { t, lang } = useT();
  const { name, email } = useSessionUser();
  const { preferences } = useBudgetPreferences();
  const { lastSyncAt } = useSyncStatus();
  const [section, setSection] = useState<WideSection>("appearance");
  const isFold = mode === "fold";

  // Badge sources (direction: "read the same sources the phone hub cards read") — the SAME
  // ternary `AiBadge` uses and the SAME `relSync` feed `SyncStatusBadge` uses, `screens/Settings.tsx`.
  const aiBadge = t(preferences.aiProvider === "enveo" ? msg("server") : preferences.aiProvider === "openai" ? msg("own key") : msg("rules"));
  const dataBadge = relSync(lastSyncAt, lang);

  const rows: Array<{ id: WideSection; label: string; sub: string; badge: string | null }> = [
    ...SETTINGS_CATEGORIES.map((c) => ({
      id: c.id,
      // v3:4200 — fold swaps to the short label (`FOLD_LABEL`); desktop keeps the full title.
      label: isFold ? t(FOLD_LABEL[c.id]) : t(c.title),
      sub: t(c.desc),
      // v3:4196/4198 — only AI and Data & sync carry a badge; Appearance shows none (no dot).
      badge: c.id === "ai" ? aiBadge : c.id === "data" ? dataBadge : null,
    })),
    { id: "account", label: t("Account"), sub: email ? t("Signed in as {email}", { email }) : "", badge: null },
  ];
  const active = rows.find((r) => r.id === section)!;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
      <div
        data-wide-settings-nav
        style={{
          width: isFold ? 142 : 218,
          // border-box (the same fix `Rail.tsx`'s own `RAIL_W` needed, its own comment): without
          // it, the 8px side padding + 1px border render 235px instead of the design's literal
          // 218 — content-box is the browser default and this file sets no global reset.
          boxSizing: "border-box",
          flexShrink: 0,
          borderRight: `1px solid ${C.line}`,
          padding: "12px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 3,
          overflowY: "auto",
        }}
      >
        {rows.map((row) => {
          const on = row.id === section;
          return (
            <button
              key={row.id}
              onClick={() => setSection(row.id)}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                width: "100%",
                textAlign: "left",
                padding: "9px 10px",
                borderRadius: 10,
                background: on ? C.accentSoft : "transparent",
                border: `1px solid ${on ? TEAL : "transparent"}`,
                cursor: "pointer",
                fontFamily: font,
              }}
            >
              <span
                style={{
                  display: "flex",
                  flexDirection: isFold ? "column" : "row",
                  alignItems: isFold ? "flex-start" : "center",
                  gap: isFold ? 3 : 7,
                  width: "100%",
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12.5,
                    fontWeight: on ? 700 : 600,
                    color: on ? C.text : C.soft,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.label}
                </span>
                {row.badge && (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      flexShrink: 0,
                      fontSize: 9.5,
                      color: C.soft,
                      background: C.bg,
                      borderRadius: 999,
                      padding: "2px 7px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.badge}
                  </span>
                )}
              </span>
              {/* v3:4166/684 — fold drops the sub-line to a bare label; desktop keeps it. */}
              {!isFold && row.sub && (
                <span style={{ fontSize: 10.5, color: C.mute, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.sub}</span>
              )}
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: isFold ? "12px 12px 20px" : "16px 18px 22px" }}>
        <div style={{ maxWidth: 620, display: "flex", flexDirection: "column", gap: 14 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{active.label}</span>
          {section === "appearance" && <AppearanceSection />}
          {section === "dictionaries" && <DictionariesSection />}
          {section === "ai" && <AiSection />}
          {section === "privacy" && <PrivacySection />}
          {section === "data" && <DataSection />}
          {section === "account" && <AccountSection name={name} email={email} lang={lang} lastSyncAt={lastSyncAt} />}
        </div>
      </div>
    </div>
  );
}

/**
 * The wide-only 6th section (v3:916-934): identity card, sync/version line, bordered sign-out
 * card. The band caption above already carries "Enveo v{ver} · build {ts}" (design parity wave A
 * task A5) — this line pairs it with the sync freshness the design's own `syncLine` shows here.
 */
function AccountSection({ name, email, lang, lastSyncAt }: { name: string | null; email: string | null; lang: Lang; lastSyncAt: string | null }) {
  const C = useTheme();
  const { t } = useT();
  const displayName = name ?? email ?? t("Account");
  // One-letter avatar, matching the rail's OWN identity avatar (`UserBlock`, `Rail.tsx`) rather
  // than the design's two-initial "ŁN" — the same identity rendered twice in one app reads best
  // sharing one convention; `C.logo` for the same reason `UserBlock`'s avatar uses it over a
  // literal accent (Duet's `logo` is its own static coral, not the navy accent — that token's own
  // doc comment, `lib/theme.ts`).
  const initial = (displayName.trim()[0] ?? "?").toUpperCase();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 11, background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 13px" }}
      >
        <span
          style={{
            width: 34,
            height: 34,
            flexShrink: 0,
            borderRadius: "50%",
            background: C.logo,
            color: C.railBg,
            fontSize: 13,
            fontWeight: 750,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {initial}
        </span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ fontSize: 13.5, fontWeight: 650, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {displayName}
          </span>
          {email && <span style={{ fontSize: 11.5, color: C.mute, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</span>}
        </span>
      </div>
      <span style={{ fontSize: 12, color: C.soft }}>
        {t("Last sync: {rel}.", { rel: relSync(lastSyncAt, lang) })} {`Enveo v${APP_VERSION}${buildLabel() ? ` · ${buildLabel()}` : ""}`}
      </span>
      <LogoutCard />
    </div>
  );
}

/**
 * The design's bordered "Log out" card (v3:926-932: `border: T.negLine`, 13/700 neg title,
 * description, bordered neg button) — built directly from `lib/signOut.ts`'s
 * `completeExplicitSignOut`/`ExplicitSignOutPendingError` (the same handler design parity wave A
 * task A3 already reuses for the rail popover's `LogoutMenuRow`) via the shared
 * `useLogoutFlow` hook (`screens/settings/DataSection.tsx`) — the phone row's OWN presentation
 * (`LogoutSection`, an icon+shadow-card `ActionRow`) stays untouched; only the state machine is
 * shared. Copy reuses the phone row's exact, already-translated sentences (confirm dialogs, the
 * pending-changes recovery choices) rather than the design's synonymous "Log out" wording, so no
 * second near-duplicate key was needed for this card.
 */
function LogoutCard() {
  const C = useTheme();
  const { t } = useT();
  const { session, busy, error, pending, finish } = useLogoutFlow();
  if (!session) return null;
  const negLine = tint(C.neg, 0.32);

  const doLogout = () => {
    if (!window.confirm(t("Sign out and remove this account's local data from this device? Your data already on the server will stay there."))) return;
    void finish("retry");
  };
  const discardPending = () => {
    if (!window.confirm(t("Discard the unsent changes and sign out? This cannot be undone."))) return;
    void finish("discard");
  };

  const pendingBtn = {
    minHeight: 30,
    textAlign: "left",
    padding: "7px 10px",
    borderRadius: 8,
    border: `1px solid ${C.line}`,
    background: "transparent",
    color: C.text,
    fontSize: 11.5,
    fontWeight: 650,
    cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.6 : 1,
    fontFamily: font,
  } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          background: C.card,
          border: `1px solid ${negLine}`,
          borderRadius: 12,
          padding: "12px 13px",
        }}
      >
        <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.neg }}>{t("Sign out")}</span>
          <span style={{ fontSize: 11.5, color: C.mute, lineHeight: 1.5 }}>
            {t("Signs you out and removes this account's local copy, encryption keys, and credentials from the device.")}
          </span>
        </span>
        <button
          onClick={doLogout}
          disabled={busy}
          style={{
            flexShrink: 0,
            minHeight: 30,
            fontSize: 12,
            fontWeight: 650,
            color: C.neg,
            background: "none",
            border: `1px solid ${C.neg}`,
            borderRadius: 9,
            padding: "0 13px",
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1,
            fontFamily: font,
          }}
        >
          {busy ? t("Signing out…") : t("Sign out")}
        </button>
      </div>
      {pending && (
        <div style={{ padding: 12, borderRadius: 11, border: `1px solid ${negLine}`, display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 12, color: C.neg, lineHeight: 1.55 }}>
            {t("{count} unsent changes are still on this device. Retry when online, export a backup, or explicitly discard them.", { count: pending.count })}
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button onClick={() => void finish("retry")} disabled={busy} style={pendingBtn}>
              {t("Retry sending changes")}
            </button>
            {pending.kind === "pending" && (
              <button onClick={() => void finish("export")} disabled={busy} style={pendingBtn}>
                {t("Export backup and sign out")}
              </button>
            )}
            <button onClick={discardPending} disabled={busy} style={{ ...pendingBtn, color: C.neg, border: `1px solid ${C.neg}` }}>
              {t("Discard unsent changes and sign out")}
            </button>
          </div>
        </div>
      )}
      {error && <span style={{ fontSize: 12, color: C.neg, lineHeight: 1.5 }}>{error}</span>}
    </div>
  );
}
