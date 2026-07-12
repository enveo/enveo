import { useEffect, useRef, useState } from "react";
import { registerSW } from "virtual:pwa-register";
import { useT } from "../lib/i18n";
import { TEAL, font } from "../lib/theme";

/**
 * Registers the service worker in "prompt" mode and shows the "New version
 * available" banner when a new SW is waiting (onNeedRefresh). Actively polls for
 * updates (60 s interval + focus/visibilitychange), because a standalone PWA can
 * hang open with no navigation. "Refresh" = updateSW(true) → skipWaiting + reload.
 */
export function UpdatePrompt() {
  const { t } = useT();
  const [need, setNeed] = useState(false);
  const updateRef = useRef<((reload?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        setNeed(true);
      },
      onRegisteredSW(_swUrl, r) {
        if (!r) return;
        const check = () => {
          void r.update();
        };
        setInterval(check, 60_000);
        window.addEventListener("focus", check);
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") check();
        });
      },
    });
    updateRef.current = updateSW;
  }, []);

  if (!need) return null;
  return (
    <div style={{ position: "fixed", top: "calc(env(safe-area-inset-top) + 8px)", left: 0, right: 0, zIndex: 130, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
      <div style={{ pointerEvents: "auto", display: "flex", alignItems: "center", gap: 10, maxWidth: 420, width: "calc(100% - 24px)", background: TEAL, color: "#fff", borderRadius: 12, padding: "10px 12px", boxShadow: "0 6px 20px rgba(0,0,0,0.25)", fontFamily: font }}>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{t("update.newVersion")}</span>
        <button onClick={() => void updateRef.current?.(true)} style={{ border: "none", background: "#fff", color: TEAL, borderRadius: 8, padding: "6px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
          {t("update.refresh")}
        </button>
        <button onClick={() => setNeed(false)} aria-label={t("common.close")} style={{ border: "none", background: "transparent", color: "#fff", fontSize: 16, cursor: "pointer", lineHeight: 1, padding: 4 }}>
          ×
        </button>
      </div>
    </div>
  );
}
