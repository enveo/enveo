import { useEffect, useState } from "react";
import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { useInstall } from "../lib/installPrompt";
import { InstallBody } from "./InstallBody";

const FLAG = "enveo.a2hs";

/** One-time bottom prompt to install, both platforms. Dismissible; never returns once closed. */
export function InstallBanner() {
  const C = useTheme();
  const { t } = useT();
  const { state } = useInstall();
  const [show, setShow] = useState(false);

  const offerable = state === "promptable" || state === "ios-safari" || state === "ios-other";

  useEffect(() => {
    if (!offerable) return;
    if (localStorage.getItem(FLAG) === "dismissed") return;
    const id = setTimeout(() => setShow(true), 2500);
    return () => clearTimeout(id);
  }, [offerable]);

  if (!show || !offerable) return null;

  const dismiss = () => {
    localStorage.setItem(FLAG, "dismissed");
    setShow(false);
  };

  return (
    <div className="fu" style={{ position: "fixed", left: 12, right: 12, bottom: "calc(78px + env(safe-area-inset-bottom))", maxWidth: 396, margin: "0 auto", zIndex: 80, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: "14px 16px", boxShadow: "0 8px 30px rgba(0,0,0,0.18)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{t("Add Enveo to your phone")}</span>
        <button onClick={dismiss} aria-label={t("Close")} style={{ background: "none", border: "none", color: C.mute, fontSize: 16, cursor: "pointer" }}>✕</button>
      </div>
      <InstallBody onDone={dismiss} />
    </div>
  );
}
