import { useState } from "react";
import { apiErrorMessage } from "../lib/api";
import { LogoMark } from "../components/chrome";
import { signInGoogle } from "../lib/auth";
import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { CORAL, TEAL, font } from "../lib/theme";

/**
 * Login screen (AUTH_MODE=multi) — shown when the backend responded 401
 * (BootStatus "unauthed"). Simple, centered: the Enveo mini-mark + a single
 * Google button. The OAuth redirect returns to the origin → the page reloads
 * and boot starts over with the session cookie.
 */
export function LoginScreen() {
  const C = useTheme();
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doGoogle = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInGoogle(); // redirect to Google — the browser takes over from here
    } catch (e) {
      setError(apiErrorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 32, textAlign: "center" }}>
      <div style={{ marginBottom: 4 }}><LogoMark size={64} /></div>
      <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{t("auth.title")}</div>
      <div style={{ fontSize: 13, color: C.soft, lineHeight: 1.6, maxWidth: 280 }}>{t("auth.body")}</div>
      <button
        onClick={() => void doGoogle()}
        disabled={busy}
        style={{ marginTop: 8, padding: "12px 26px", borderRadius: 11, border: "none", background: TEAL, color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1, fontFamily: font }}
      >
        {t("auth.google")}
      </button>
      {error && <div style={{ fontSize: 12, color: CORAL, lineHeight: 1.5, maxWidth: 280 }}>{error}</div>}
    </div>
  );
}
