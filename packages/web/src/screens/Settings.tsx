import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ScreenId } from "../components/chrome";
import { useBand } from "../components/kit";
import { useLedgerVersion, useSyncStatus } from "../lib/api";
import { useBudgetPreferences, useSettings, useTheme } from "../lib/contexts";
import { relSync } from "../lib/dates";
import * as e2ee from "../lib/e2ee";
import { type Message, msg, useT } from "../lib/i18n";
import { D_INSTALL, Ico } from "../lib/icons";
import { isInstallable, useInstall } from "../lib/installPrompt";
import { P, tint } from "../lib/theme";
import { APP_VERSION, buildLabel } from "../lib/version";
import { AiSection } from "./settings/Ai";
import { AppearanceSection } from "./settings/Appearance";
import { DataSection, LogoutSection } from "./settings/DataSection";
import { PrivacySection } from "./settings/PrivacySection";

/* ── Settings: four scoped categories plus a separate sign-out action ── */

export const SETTINGS_CATEGORIES = [
  { id: "appearance", title: msg("Appearance and dashboard") },
  { id: "ai", title: msg("Artificial intelligence") },
  { id: "privacy", title: msg("Privacy and encryption") },
  { id: "data", title: msg("Data and synchronization") },
] as const;

export const SETTINGS_HUB_FOOTER_ACTIONS = ["signOut"] as const;

type SubId = (typeof SETTINGS_CATEGORIES)[number]["id"];

const SUB_TITLE: Record<SubId, Message> = {
  appearance: msg("Appearance and dashboard"),
  ai: msg("Artificial intelligence"),
  privacy: msg("Privacy and encryption"),
  data: msg("Data and synchronization"),
};

/** Category glyph — 1.7px stroked SVG (patterns from the mock), stroke via style (CSS vars OK). */
function Glyph({ color, children }: { color: string; children: ReactNode }) {
  return (
    <svg
      width={19}
      height={19}
      viewBox="0 0 24 24"
      fill="none"
      style={{ stroke: color }}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * `onInstall` opens App's install sheet — App is the SOLE owner and renderer of the
 * InstallSheet host (M7): the Drawer entry and the hub card below call the same callback, so
 * at most one dialog can ever exist and the appinstalled transition closes the one host.
 * Explicit props, not a store/context: two entry points, and App already owns the lifetime.
 */
export function SettingsScreen({ onNav, onInstall }: { onNav: (s: ScreenId) => void; onInstall: () => void }) {
  const C = useTheme();
  const { t } = useT();
  const { band, hc } = useBand();
  const [sub, setSub] = useState<SubId | null>(null);
  const scRef = useRef<HTMLDivElement>(null);
  const go = (s: SubId | null) => {
    setSub(s);
    scRef.current?.scrollTo({ top: 0 });
  };

  // Swipe-back from a subscreen → hub. Same conditions as the global back-swipe in App;
  // stopPropagation in touchend swallows the gesture before it reaches App's handler
  // (React bubbling) — otherwise App would SIMULTANEOUSLY go back from Settings to Start.
  const sw = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const p = e.touches[0]!;
    sw.current = { x: p.clientX, y: p.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const st = sw.current;
    sw.current = null;
    if (!st || sub === null) return; // on the hub the gesture bubbles to App (back to Start)
    const p = e.changedTouches[0]!;
    const dx = p.clientX - st.x,
      dy = p.clientY - st.y;
    if (dx > 60 && Math.abs(dy) < 45 && (st.x < 40 || dx > 110)) {
      e.stopPropagation();
      go(null);
    }
  };

  return (
    <div ref={scRef} className="gs" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} style={{ flex: 1, overflowY: "auto", paddingBottom: 6 }}>
      <div data-band={band || undefined} style={band ? { background: C.headerBg, paddingBottom: 2 } : undefined}>
        <div style={{ display: "flex", alignItems: "center", padding: `12px ${P}px`, gap: 10 }}>
          <button
            onClick={() => (sub !== null ? go(null) : onNav("start"))}
            aria-label={t("Back")}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}
          >
            <Ico d="M19 12H5m0 0l7 7m-7-7l7-7" size={18} color={hc(C.headerInk, C.text)} />
          </button>
          <span style={{ fontSize: 17, fontWeight: 700, color: hc(C.headerInk, C.text) }}>{sub !== null ? t(SUB_TITLE[sub]) : t("Settings")}</span>
        </div>
      </div>

      {sub === null ? (
        <Hub onOpen={go} onInstall={onInstall} />
      ) : (
        <div key={sub} className="fi" style={{ padding: `0 ${P + 2}px` }}>
          {/* fi, not fu: transform on an ancestor breaks position:fixed sheets (e.g. the E2EE wizard) */}
          {sub === "appearance" && <AppearanceSection />}
          {sub === "ai" && <AiSection />}
          {sub === "privacy" && <PrivacySection />}
          {sub === "data" && <DataSection />}
        </div>
      )}
    </div>
  );
}

/* ── Hub: category cards with statuses (per mock S2) ────────────────── */

function Hub({ onOpen, onInstall }: { onOpen: (s: SubId) => void; onInstall: () => void }) {
  const C = useTheme();
  const { t } = useT();
  const { settings } = useSettings();
  const { state: installState } = useInstall();
  const isDark =
    settings.themeMode === "auto" ? typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches : settings.themeMode === "dark";

  // category colors (glyph + tint); lighter shades in dark mode
  const catAppearance = isDark ? "#ff8d7d" : "#f0685c";
  const catAi = isDark ? "#e0aa58" : "#d99a3f";
  const catPrivacy = isDark ? "#8fa2cc" : "#1d2a47";
  const catData = isDark ? "#6cbf9b" : "#4fa583";
  // one color per category is the hub's visual language — install gets its OWN token
  // (violet), not a reuse of the Data navy (M10)
  const catInstall = isDark ? "#a89bdd" : "#6f5bb5";

  return (
    <div className="fi" style={{ padding: "2px 14px", display: "flex", flexDirection: "column", gap: 9 }}>
      {isInstallable(installState) && (
        <HubCard
          tint={tint(catInstall, 0.1)}
          icon={
            <Glyph color={catInstall}>
              <path d={D_INSTALL} />
            </Glyph>
          }
          title={t("Install app")}
          desc={t("Add Enveo to your home screen")}
          status={null}
          onClick={onInstall}
        />
      )}
      <HubCard
        tint={tint(catAppearance, 0.1)}
        icon={
          <Glyph color={catAppearance}>
            <circle cx="13.5" cy="6.5" r="1" />
            <circle cx="17.5" cy="10.5" r="1" />
            <circle cx="8.5" cy="7.5" r="1" />
            <circle cx="6.5" cy="12" r="1" />
            <path d="M12 2a10 10 0 000 20 2 2 0 002-2v-1a2 2 0 012-2h1a5 5 0 005-5c0-5.5-4.5-10-10-10z" />
          </Glyph>
        }
        title={t("Appearance and dashboard")}
        desc={t("Theme, language, currency, privacy display, and widgets")}
        status={
          <span
            aria-hidden
            style={{ width: 16, height: 16, borderRadius: "50%", background: "var(--cta)", outline: `2px solid ${C.line}`, outlineOffset: 2, flexShrink: 0 }}
          />
        }
        onClick={() => onOpen("appearance")}
      />
      <HubCard
        tint={tint(catAi, 0.12)}
        icon={
          <Glyph color={catAi}>
            <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
            <path d="M19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9z" />
          </Glyph>
        }
        title={t("Artificial intelligence")}
        desc={t("Provider, model, and secure credential status")}
        status={<AiBadge />}
        onClick={() => onOpen("ai")}
      />
      <HubCard
        tint={tint(catPrivacy, 0.08)}
        icon={
          <Glyph color={catPrivacy}>
            <path d="M12 2l8 3v6c0 5-3.5 9.4-8 11-4.5-1.6-8-6-8-11V5z" />
            <path d="M9 12l2 2 4-4" />
          </Glyph>
        }
        title={t("Privacy and encryption")}
        desc={t("End-to-end encryption, password, and device pairing")}
        status={<E2eeBadge color={catPrivacy} />}
        onClick={() => onOpen("privacy")}
      />
      <HubCard
        tint={tint(catData, 0.12)}
        icon={
          <Glyph color={catData}>
            <path d="M21 12a9 9 0 11-2.6-6.4" />
            <path d="M21 3v6h-6" />
          </Glyph>
        }
        title={t("Data and synchronization")}
        desc={t("Sync, backup, repair, diagnostics, and reset")}
        status={<SyncStatusBadge okColor={catData} />}
        onClick={() => onOpen("data")}
      />

      <div style={{ marginTop: 12 }}>
        <LogoutSection />
      </div>

      <div style={{ textAlign: "center", fontSize: 10, color: C.mute, fontVariantNumeric: "tabular-nums", margin: "22px 0 12px" }}>
        {`Enveo v${APP_VERSION}`}
        {buildLabel() ? ` · ${buildLabel()}` : ""}
      </div>
    </div>
  );
}

function HubCard({
  tint,
  icon,
  title,
  desc,
  status,
  onClick,
}: {
  tint: string;
  icon: ReactNode;
  title: string;
  desc: string;
  status: ReactNode;
  onClick: () => void;
}) {
  const C = useTheme();
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 13,
        width: "100%",
        background: C.card,
        border: "none",
        borderRadius: 14,
        padding: "13px 14px",
        cursor: "pointer",
        textAlign: "left",
        boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
      }}
    >
      <span
        style={{ width: 38, height: 38, borderRadius: 11, background: tint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
      >
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 14, fontWeight: 700, color: C.text }}>{title}</span>
        <span style={{ display: "block", fontSize: 11, color: C.mute, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {desc}
        </span>
      </span>
      {status}
      <Ico d="M9 5l7 7-7 7" size={14} color={C.mute} sw={2} />
    </button>
  );
}

/** AI provider badge — a budget preference. */
function AiBadge() {
  const C = useTheme();
  const { t } = useT();
  const { preferences } = useBudgetPreferences();
  const key: Message = preferences.aiProvider === "enveo" ? msg("server") : preferences.aiProvider === "openai" ? msg("own key") : msg("rules");
  return (
    <span style={{ fontSize: 10.5, fontWeight: 700, color: C.mute, background: C.inset, borderRadius: 8, padding: "3px 8px", flexShrink: 0 }}>{t(key)}</span>
  );
}

/** "E2EE" badge — only when the budget is on the e2ee tier (lib/e2ee). */
function E2eeBadge({ color }: { color: string }) {
  const { t } = useT();
  // a tier flip bumps the mirror version — the badge also refreshes on a flip from another device
  useLedgerVersion();
  if (e2ee.getTierMeta().tier !== "e2ee") return null;
  return (
    <span style={{ fontSize: 10.5, fontWeight: 700, color, background: tint(color, 0.08), borderRadius: 8, padding: "3px 8px", flexShrink: 0 }}>
      {t("E2EE")}
    </span>
  );
}

/** Dot + relative time of the last sync from the existing engine state. */
function SyncStatusBadge({ okColor }: { okColor: string }) {
  const C = useTheme();
  const { lang } = useT();
  const { state, lastSyncAt, ownerUnproven } = useSyncStatus();

  // refresh the relative time every ~30 s while the hub is open
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // An unproven replica reads as a healthy green dot unless it is called out here — and it is the
  // one state the user has to FIND (the section behind this card is the only place it is
  // explained). The STICKY flag, not SyncState "unverified": a re-proof cycle passes through
  // "syncing", and the dot would flip back to the healthy colour every time it ran.
  const attention = state === "offline" || state === "error" || ownerUnproven;
  const color = attention ? C.neg : okColor;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, color, fontWeight: 700, flexShrink: 0 }}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: color }} />
      {relSync(lastSyncAt, lang)}
    </span>
  );
}
