import { useEffect, useState } from "react";
import { LogoMark } from "../components/chrome";
import { apiErrorMessage } from "../lib/api";
import { type AuthMeta, fetchAuthMeta, signInEmail, signInGoogle, signUpEmail } from "../lib/auth";
import { useTheme } from "../lib/contexts";
import { cacheDeployment, setDeviceStoragePolicy } from "../lib/deviceStoragePolicy";
import { msg, useT } from "../lib/i18n";
import { CORAL, font, TEAL } from "../lib/theme";
import { useViewMode } from "../lib/viewMode";

export const PRIVATE_DEVICE_DISCLOSURE = msg(
  "Keep me signed in and save a local copy so Enveo works without internet. Anyone who can access this browser profile may be able to read that copy.",
);
export const SHARED_DEVICE_DISCLOSURE = msg("No new local copy will be saved. This browser session ends when you close the app.");

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
  // Layout only: the brand column (BootShellWide, App.tsx mount A) already carries the logo and
  // title on fold/desktop — this screen just stops duplicating them and fills the shell's 440px
  // form column instead of centering in its own narrow one. Boot surfaces render one at a time,
  // so this screen's own listener is harmless (D1, pr7-context.md).
  const wide = useViewMode() !== "phone";
  const [meta, setMeta] = useState<AuthMeta | null>(null);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [persistent, setPersistent] = useState(true); // selfhost default until meta says otherwise

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const m = await fetchAuthMeta();
        if (!alive) return;
        setMeta(m);
        cacheDeployment(m.deployment ?? "selfhost");
        setPersistent(m.deployment !== "cloud"); // cloud defaults to a non-persistent session
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
      if (!setDeviceStoragePolicy(persistent ? "persistent" : "session")) throw new Error("device_storage_unavailable");
      if (mode === "signup") await signUpEmail(email.trim(), password, persistent);
      else await signInEmail(email.trim(), password, persistent);
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
      if (!setDeviceStoragePolicy(persistent ? "persistent" : "session")) throw new Error("device_storage_unavailable");
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
  };
  const linkStyle: React.CSSProperties = {
    // 0-padding measured ~15-16px tall — sub-floor in every mode. Deliberate exception to phone
    // pixel-identity in both modes (Q2, pr7-task-2-brief.md): 8px of spacing, no visual redesign.
    padding: "8px 4px",
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
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: wide ? "stretch" : "center",
        justifyContent: "center",
        gap: 14,
        padding: 32,
        textAlign: wide ? "left" : "center",
      }}
    >
      {!wide && (
        <div style={{ marginBottom: 4 }}>
          <LogoMark size={64} />
        </div>
      )}
      <div style={{ fontSize: wide ? 22 : 18, fontWeight: 700, color: C.text }}>{title}</div>
      <div style={{ fontSize: 13, color: C.soft, lineHeight: 1.6, maxWidth: wide ? "100%" : 280 }}>
        {firstRun
          ? t("This is the first account on this server — once it exists, registration closes.")
          : t("Your budget is tied to your account. Sign in to continue.")}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void submit();
        }}
        style={{ width: "100%", maxWidth: wide ? "100%" : 280, display: "flex", flexDirection: "column", gap: 10, textAlign: "left" }}
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
          <input type="checkbox" checked={persistent} onChange={(e) => setPersistent(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            <strong style={{ display: "block", color: C.text }}>{t("This is my private device")}</strong>
            {t(PRIVATE_DEVICE_DISCLOSURE)}
          </span>
        </label>
        {!persistent && <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.5 }}>{t(SHARED_DEVICE_DISCLOSURE)}</div>}
        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            marginTop: 2,
            padding: "12px 26px",
            borderRadius: 11,
            border: "none",
            background: TEAL,
            color: "#fff",
            fontSize: 13.5,
            fontWeight: 600,
            cursor: canSubmit ? "pointer" : "default",
            opacity: canSubmit ? 1 : 0.5,
            fontFamily: font,
          }}
        >
          {mode === "signup" ? t("Create account") : t("Sign in")}
        </button>
      </form>

      {mode === "signin" && meta?.signupsOpen === true && !firstRun && (
        <button onClick={() => switchMode("signup")} disabled={busy} style={linkStyle}>
          {t("No account yet? Create one")}
        </button>
      )}
      {mode === "signup" && !firstRun && (
        <button onClick={() => switchMode("signin")} disabled={busy} style={linkStyle}>
          {t("Already have an account? Sign in")}
        </button>
      )}

      {meta?.providers.google === true && (
        <button
          onClick={() => void doGoogle()}
          disabled={busy}
          style={{
            padding: "12px 26px",
            borderRadius: 11,
            border: `1px solid ${C.line}`,
            background: C.surface,
            color: C.text,
            fontSize: 13.5,
            fontWeight: 600,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.5 : 1,
            fontFamily: font,
          }}
        >
          {t("Sign in with Google")}
        </button>
      )}
      {meta?.providers.google === true && !persistent && (
        <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.5, maxWidth: wide ? "100%" : 280 }}>
          {t("Google sign-in keeps you signed in until you sign out — remember to sign out when you finish.")}
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: CORAL, lineHeight: 1.5, maxWidth: wide ? "100%" : 280 }}>{error}</div>}
    </div>
  );
}
