import { useEffect, useState } from "react";
import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { storageMode } from "../lib/idb";
import { isInstallable, useInstall } from "../lib/installPrompt";
import { InstallBody } from "./InstallBody";

/**
 * One-time flag, key v2 (M8): the old `enveo.a2hs` was written by the deleted iOS-only
 * InstallHint, so reusing it kept this much richer banner permanently hidden from everyone
 * who ever dismissed that one-liner. The new key gives those users ONE more showing; the old
 * key is simply abandoned — lib/storage.ts still migrates its legacy-brand copy, harmlessly,
 * and needs no change. Semantics stay once-and-dismissed on the new key.
 */
const FLAG = "enveo.a2hs2";

/**
 * Remember that the install offer was already made, so the banner never returns. Also called by
 * the onboarding install card, which is the SAME one-time offer arriving earlier — without it the
 * banner would slide up seconds after the user skipped that card.
 * Session storage mode writes NOTHING to disk — same contract as
 * settingsPersist.ts: a guest must not leave traces, and must not eat the device owner's one
 * showing. The write is also guarded: localStorage throws in Safari private mode, and a caller
 * closing a screen on the way out must not be taken down with it.
 */
export function markInstallOffered(): void {
  if (storageMode() === "memory-session") return;
  try {
    localStorage.setItem(FLAG, "dismissed");
  } catch {
    /* private mode — the banner shows once more, which is better than a broken flow */
  }
}

/**
 * The READ is guarded too: with site data blocked, Chromium throws on `localStorage.getItem`
 * as well — unguarded inside the effect it took the whole app down (white screen) the moment
 * the state turned offerable. Degrades to "not offered yet", matching the write's choice.
 */
function installOffered(): boolean {
  try {
    return localStorage.getItem(FLAG) === "dismissed";
  } catch {
    return false;
  }
}

/** One-time bottom prompt to install, both platforms. Dismissible; never returns once closed. */
export function InstallBanner() {
  const C = useTheme();
  const { t } = useT();
  const { state } = useInstall();
  const [show, setShow] = useState(false);
  // lazy init: one guarded read at mount, not a raw read on every offerable flip
  const [dismissed, setDismissed] = useState(installOffered);

  const offerable = isInstallable(state);

  useEffect(() => {
    if (!offerable || dismissed) return;
    const id = setTimeout(() => setShow(true), 2500);
    return () => clearTimeout(id);
  }, [offerable, dismissed]);

  if (!show || !offerable || dismissed) return null;

  const dismiss = () => {
    markInstallOffered();
    setDismissed(true);
    setShow(false);
  };

  return (
    // role="dialog" + aria-live: the banner slides in 2.5 s after load — without a live
    // region a screen-reader user never hears it appear (M9)
    <div
      className="fu"
      role="dialog"
      aria-label={t("Add Enveo to your phone")}
      aria-live="polite"
      style={{
        position: "fixed",
        left: 12,
        right: 12,
        bottom: "calc(78px + env(safe-area-inset-bottom))",
        maxWidth: 396,
        margin: "0 auto",
        zIndex: 80,
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        padding: "14px 16px",
        boxShadow: "0 8px 30px rgba(0,0,0,0.18)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{t("Add Enveo to your phone")}</span>
        <button onClick={dismiss} aria-label={t("Close")} style={{ background: "none", border: "none", color: C.mute, fontSize: 16, cursor: "pointer" }}>
          ✕
        </button>
      </div>
      <InstallBody onDone={dismiss} />
    </div>
  );
}
