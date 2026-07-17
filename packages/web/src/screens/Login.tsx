import { useEffect, useState } from "react";
import { apiErrorMessage } from "../lib/api";
import { LogoMark } from "../components/chrome";
import { fetchAuthMeta, signInEmail, signInGoogle, signUpEmail, type AuthMeta } from "../lib/auth";
import { useTheme } from "../lib/contexts";
import { cacheDeployment, setDeviceTrust } from "../lib/deviceTrust";
import { useT } from "../lib/i18n";
import { CORAL, TEAL, font } from "../lib/theme";

/**
 * Login screen — shown when the backend responded 401 (BootStatus "unauthed").
 * Accounts are mandatory, so this is also the first-run screen: /api/auth/meta
 * says whether the server has no credentialed account yet (→ "create the owner
 * account"), whether registration is still open, and whether Google is wired.
 * After a successful sign-in/sign-up the page reloads and boot starts over with
 * the session cookie — the same path the OAuth redirect takes.
 */
export function LoginScreen() {
  const C = useTheme();
  const { t } = useT();
  const [meta, setMeta] = useState<AuthMeta | null>(null);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState(true); // selfhost default until meta says otherwise

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const m = await fetchAuthMeta();
        if (!alive) return;
        setMeta(m);
        cacheDeployment(m.deployment ?? "selfhost");
        setTrust(m.deployment !== "cloud"); // cloud → untrusted by default (shared devices)
        if (m.firstRun) setMode("signup"); // no account on this server yet → owner registration
      } catch {
        /* meta unavailable (offline/old server): fall back to the plain sign-in form */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const firstRun = meta?.firstRun === true;
  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy;

  // lib/auth.ts throws a CODE (never the library's English prose); apiErrorMessage does the wording.
  const fail = (e: unknown) => setError(apiErrorMessage(e));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") await signUpEmail(email.trim(), password, trust);
      else await signInEmail(email.trim(), password, trust);
      setDeviceTrust(trust ? "trusted" : "untrusted"); // only a SUCCESSFUL login flips the flag
      location.reload(); // boot again — now with the session cookie AND the right storage backend
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };

  const doGoogle = async () => {
    setBusy(true);
    setError(null);
    try {
      // The flag must be set BEFORE the redirect — the OAuth return is a fresh boot on this
      // origin. A failed/abandoned OAuth leaves the flag flipped with no session, which is
      // harmless: no session ⇒ Login, and the next successful login rewrites it.
      setDeviceTrust(trust ? "trusted" : "untrusted");
      await signInGoogle(); // redirect to Google — the browser takes over from here
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };

  const switchMode = (next: "signin" | "signup") => {
    setMode(next);
    setError(null);
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    borderRadius: 10,
    border: `1px solid ${C.line}`,
    background: C.surface,
    color: C.text,
    fontSize: 14,
    fontFamily: font,
    outline: "none",
  };
  const linkStyle: React.CSSProperties = {
    padding: 0,
    border: "none",
    background: "transparent",
    color: C.soft,
    fontSize: 12.5,
    fontWeight: 600,
    fontFamily: font,
    cursor: "pointer",
    textDecoration: "underline",
  };

  const title = mode === "signup" ? (firstRun ? t("Create the owner account") : t("Create an account")) : t("Sign in to Enveo");

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 32, textAlign: "center" }}>
      <div style={{ marginBottom: 4 }}><LogoMark size={64} /></div>
      <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{title}</div>
      <div style={{ fontSize: 13, color: C.soft, lineHeight: 1.6, maxWidth: 280 }}>{firstRun ? t("This is the first account on this server — once it exists, registration closes.") : t("Your budget is tied to your account. Sign in to continue.")}</div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void submit();
        }}
        style={{ width: "100%", maxWidth: 280, display: "flex", flexDirection: "column", gap: 10, textAlign: "left" }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("Email")}
          aria-label={t("Email")}
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          style={inputStyle}
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("Password")}
          aria-label={t("Password")}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          style={inputStyle}
        />
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, color: C.soft, lineHeight: 1.5, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={trust}
            onChange={(e) => setTrust(e.target.checked)}
            style={{ marginTop: 2, accentColor: TEAL }}
          />
          <span>{t("Trust this device — remember my data and sign-in")}</span>
        </label>
        {!trust && (
          <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.5 }}>
            {t("Guest session: your budget is kept in memory only and disappears when you close the browser.")}
          </div>
        )}
        <button
          type="submit"
          disabled={!canSubmit}
          style={{ marginTop: 2, padding: "12px 26px", borderRadius: 11, border: "none", background: TEAL, color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: canSubmit ? "pointer" : "default", opacity: canSubmit ? 1 : 0.5, fontFamily: font }}
        >
          {mode === "signup" ? t("Create account") : t("Sign in")}
        </button>
      </form>

      {mode === "signin" && meta?.signupsOpen === true && !firstRun && (
        <button onClick={() => switchMode("signup")} disabled={busy} style={linkStyle}>{t("No account yet? Create one")}</button>
      )}
      {mode === "signup" && !firstRun && (
        <button onClick={() => switchMode("signin")} disabled={busy} style={linkStyle}>{t("Already have an account? Sign in")}</button>
      )}

      {meta?.providers.google === true && (
        <button
          onClick={() => void doGoogle()}
          disabled={busy}
          style={{ padding: "12px 26px", borderRadius: 11, border: `1px solid ${C.line}`, background: C.surface, color: C.text, fontSize: 13.5, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1, fontFamily: font }}
        >
          {t("Sign in with Google")}
        </button>
      )}
      {meta?.providers.google === true && !trust && (
        <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.5, maxWidth: 280 }}>
          {t("Google sign-in keeps you signed in until you sign out — remember to sign out when you finish.")}
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: CORAL, lineHeight: 1.5, maxWidth: 280 }}>{error}</div>}
    </div>
  );
}
