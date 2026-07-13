import { useEffect, useState } from "react";
import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { Ico } from "../lib/icons";
import { TEAL } from "../lib/theme";

/** One-time "Add to Home Screen" hint on iOS Safari. */
export function InstallHint() {
  const C = useTheme();
  const { t } = useT();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (localStorage.getItem("enveo.a2hs") === "dismissed") return;
    const nav = window.navigator as Navigator & { standalone?: boolean };
    const standalone = nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIOS && !standalone) {
      const t = setTimeout(() => setShow(true), 2500);
      return () => clearTimeout(t);
    }
  }, []);

  if (!show) return null;
  const dismiss = () => {
    localStorage.setItem("enveo.a2hs", "dismissed");
    setShow(false);
  };
  return (
    <div className="fu" style={{ position: "fixed", left: 12, right: 12, bottom: "calc(78px + env(safe-area-inset-bottom))", maxWidth: 396, margin: "0 auto", zIndex: 80, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: "12px 14px", boxShadow: "0 8px 30px rgba(0,0,0,0.18)", display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ width: 36, height: 36, borderRadius: 9, background: TEAL, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Ico d="M12 5v10m0 0l-4-4m4 4l4-4M5 19h14" size={18} color="#fff" sw={2} />
      </div>
      <div style={{ flex: 1, fontSize: 11.5, color: C.text, lineHeight: 1.4 }}>
        {t("Install as an app:")} <b>{t("Share")}</b> → <b>{t("Add to Home Screen")}</b>.
      </div>
      <button onClick={dismiss} aria-label={t("Close")} style={{ background: "none", border: "none", color: C.mute, fontSize: 16, cursor: "pointer" }}>✕</button>
    </div>
  );
}
