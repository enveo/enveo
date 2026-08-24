/**
 * Wide boot shell (PR7 Task 1) — the lazy layout host for every boot-decision surface on a
 * fold/desktop viewport: Login (unauthenticated), Unlock (E2EE locked), ForeignReplica (replica
 * stamp mismatch) and the onboarding wizard/install steps (mount B, wired by a later task). Pure
 * layout: it renders AROUND the screen the caller already decided to show — it reads no boot
 * state itself and makes no auth/tenant decision (that stays in App.tsx and each screen).
 *
 * Lazy by construction: this module (and its brand copy) lives in its OWN chunk, loaded only when
 * `mode !== "phone"` — the phone boot path never fetches it (App.tsx's mount A keeps today's
 * phone-card JSX byte-identical). TRANSFORM-FREE on purpose: AmountPadSheet/Sheet descendants
 * (rendered by Unlock's E2eeUpgradePanel and the wizard's amount pad) are `position: fixed`, and a
 * CSS transform on an ancestor breaks fixed descendants (house pitfall) — nothing in this tree
 * animates with a transform.
 */
import type { ReactNode } from "react";
import { useTheme } from "../lib/contexts";
import { getCachedDeployment } from "../lib/deviceStoragePolicy";
import { type Message, useT } from "../lib/i18n";
import { font, TEAL } from "../lib/theme";
import type { ViewMode } from "../lib/viewMode";
import { LogoMark, StyleInjector } from "./chrome";

export type BootView = "login" | "unlock" | "foreign" | "wizard" | "install";

interface BootShellWideProps {
  mode: Exclude<ViewMode, "phone">;
  view: BootView;
  /** Drives the step rail — `view === "wizard"` only. */
  wizardStep?: 0 | 1 | 2;
  /** Content column cap override (the wizard's envelope step needs a wider grid). */
  formMax?: number;
  children: ReactNode;
}

type Translate = (message: Message, params?: Record<string, string | number>) => string;

interface BrandContent {
  title: string;
  body: string;
  facts: string[];
}

/**
 * Brand copy per boot state — all inside this lazy module, so zero eager bytes. `cloud` gates the
 * ForeignReplica export-backup fact (M6): the real export button is already hidden on cloud (the
 * privacy hole that closes), so the fact describing it must not appear either.
 */
function brandContent(view: BootView, t: Translate, cloud: boolean): BrandContent {
  switch (view) {
    case "login":
      return {
        title: t("Your budget is tied to your account."),
        body: t(
          "Enveo keeps a full local copy of the budget, so it works offline and syncs when you are back. Accounts are mandatory — the copy has to belong to somebody.",
        ),
        facts: [
          t("A local copy means the app opens instantly and keeps working on a plane."),
          t("Self-hosted or cloud — the same build, the same data model."),
          t("Sign-in is per device: a shared computer can stay session-only."),
        ],
      };
    case "unlock":
      return {
        title: t("This budget is end-to-end encrypted."),
        body: t(
          "The data is encrypted on the device before it reaches the server. Only the encryption password — or a pairing code from a device that is already unlocked — can open it here.",
        ),
        facts: [
          t("The server stores ciphertext and never sees the password."),
          t("A pairing code moves the key from an unlocked device — paste only, no QR scanning."),
          t("AI through Enveo's key stays off while encryption is on — your own OpenAI key still works, straight from this device."),
        ],
      };
    case "foreign":
      return {
        title: t("This device holds someone else's budget."),
        body: t(
          "Every write to the server is already blocked. Nothing has been deleted, because the decision is yours: the copy on this device may be the last one that exists.",
        ),
        facts: [
          t("A user id can change when a self-hosted server is rebuilt — same e-mail, new account."),
          ...(cloud ? [] : [t("Export first: the JSON backup is written offline, without the server.")]),
          t("Removing the local copy is the only destructive action here."),
        ],
      };
    case "wizard":
      return {
        title: t("Three steps and the budget is yours."),
        body: t("Language, one account, a set of envelopes. Everything can be renamed, moved or archived later — nothing here is permanent."),
        facts: [],
      };
    case "install":
      return {
        title: t("Your budget is ready."),
        body: t("Language, one account, a set of envelopes. Everything can be renamed, moved or archived later — nothing here is permanent."),
        facts: [],
      };
  }
}

/**
 * Wizard step rail (`view === "wizard"` only) — display-only: the mock has no step-jumping and
 * adding it would change wizard flow, so no touch-target requirement applies. Active step gets
 * the same white-on-accent pairing every primary button already uses.
 */
function StepRail({ fold, active }: { fold: boolean; active: 0 | 1 | 2 }) {
  const C = useTheme();
  const { t } = useT();
  const labels = [t("Language and currency"), t("Your first account"), t("Your envelopes")];
  return (
    <div style={{ display: "flex", flexDirection: fold ? "row" : "column", gap: fold ? 8 : 14 }}>
      {labels.map((label, i) => (
        <div key={label} aria-current={i === active ? "step" : undefined} style={{ display: "flex", alignItems: "center", gap: 10, flex: fold ? 1 : "none" }}>
          <div
            aria-hidden="true"
            style={{
              width: 22,
              height: 22,
              flexShrink: 0,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 700,
              background: i === active ? TEAL : "transparent",
              color: i === active ? "#fff" : C.mute,
              border: i === active ? "none" : `1px solid ${C.mute}`,
            }}
          >
            {i + 1}
          </div>
          <span style={{ fontSize: 12.5, fontWeight: i === active ? 650 : 500, color: i === active ? C.text : C.mute }}>{label}</span>
        </div>
      ))}
    </div>
  );
}

/** Marketing facts column (desktop/fold, non-wizard/install views only — Q6: matches the mock). */
function Facts({ facts }: { facts: string[] }) {
  const C = useTheme();
  if (facts.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {facts.map((f) => (
        <div key={f} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <span aria-hidden="true" style={{ width: 6, height: 6, marginTop: 5, flexShrink: 0, borderRadius: 1, background: TEAL }} />
          <span style={{ fontSize: 12, lineHeight: 1.6, color: C.soft }}>{f}</span>
        </div>
      ))}
    </div>
  );
}

/** Default export, for `React.lazy`. */
export default function BootShellWide({ mode, view, wizardStep, formMax, children }: BootShellWideProps) {
  const C = useTheme();
  const { t } = useT();
  const fold = mode === "fold";
  const cloud = getCachedDeployment() === "cloud";
  const brand = brandContent(view, t, cloud);
  return (
    // TRANSFORM-FREE on purpose: AmountPadSheet/Sheet descendants are position:fixed.
    <div
      style={{
        height: "100dvh",
        display: "flex",
        flexDirection: fold ? "column" : "row",
        background: C.bg,
        fontFamily: font,
        overflow: "hidden",
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <StyleInjector />
      {/* Brand column (desktop, 480px left) / band (fold, full-width top). border-box is
          load-bearing: content-box would render the 480px spec width PLUS this div's own
          padding+border as the actual box (measured 573px at 1440×900 before this was added). */}
      <div
        style={{
          boxSizing: "border-box",
          flex: "none",
          width: fold ? "100%" : 480,
          padding: fold ? "22px 26px" : "44px 46px",
          background: C.inset,
          borderRight: fold ? "none" : `1px solid ${C.line}`,
          borderBottom: fold ? `1px solid ${C.line}` : "none",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          gap: 18,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: fold ? 14 : 26 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <LogoMark size={26} />
            <span style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Enveo</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: fold ? 20 : 30, fontWeight: 700, lineHeight: 1.25, color: C.text, letterSpacing: "-0.01em" }}>{brand.title}</span>
            {!fold && <span style={{ fontSize: 13, lineHeight: 1.6, color: C.soft, maxWidth: 320 }}>{brand.body}</span>}
          </div>
        </div>
        {view === "wizard" && <StepRail fold={fold} active={wizardStep ?? 0} />}
        {!fold && view !== "wizard" && view !== "install" && <Facts facts={brand.facts} />}
      </div>
      {/* Content region: the ONLY scroller on wide. margin:auto centering, NOT justify-content:
          center — a centred flex child taller than the region clips its top edge and cannot be
          scrolled back; margin:auto degrades to 0 and scrolls from the top. */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: fold ? "26px 40px 40px" : "44px 56px 56px",
          paddingTop: `max(${fold ? 26 : 44}px, env(safe-area-inset-top))`,
        }}
      >
        <div style={{ width: "100%", maxWidth: formMax ?? (fold ? 480 : 440), display: "flex", flexDirection: "column", gap: 16, margin: "auto 0" }}>
          {children}
        </div>
      </div>
    </div>
  );
}
