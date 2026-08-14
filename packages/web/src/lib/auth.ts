/**
 * better-auth client (same origin — the backend always mounts /api/auth/*).
 * Accounts are MANDATORY: every /api/* call except /api/auth/* and /api/health
 * needs a session, so a boot without one lands on LoginScreen.
 */
import { createAuthClient } from "better-auth/client";
import { accountPreferences } from "./accountPreferences";
import { devicePreferences } from "./devicePreferences";
import { clearEphemeralOpenAiCredential } from "./settingsPersist";

export const authClient = createAuthClient();

/** What the login screen must render — from the public GET /api/auth/meta. */
export type AuthMeta = {
  signupsOpen: boolean;
  firstRun: boolean;
  providers: { google: boolean };
  /** Absent on pre-2.3 servers → the client assumes selfhost. */
  deployment?: "selfhost" | "cloud";
};

export async function fetchAuthMeta(): Promise<AuthMeta> {
  const r = await fetch("/api/auth/meta");
  if (!r.ok) throw new Error("auth_meta_failed");
  return (await r.json()) as AuthMeta;
}

/**
 * better-auth answers with an English `message` and a machine `code` (e.g.
 * INVALID_EMAIL_OR_PASSWORD). The message must never reach the UI — it would print English
 * at a Polish user on the very first screen. Same contract as everywhere else in lib/*:
 * throw a snake_case CODE, let lib/api.ts (ERROR_KEYS) own the wording per locale.
 * An unmapped code falls back to a generic per-action key rather than the library's prose.
 */
function authErrorCode(error: { code?: string; message?: string } | null | undefined, fallback: "sign_in_failed" | "sign_up_failed"): string {
  const code = error?.code?.toLowerCase();
  return code && AUTH_CODES.has(code) ? code : fallback;
}

/** better-auth codes we translate; anything else degrades to the generic per-action message. */
const AUTH_CODES = new Set([
  "invalid_email_or_password",
  "user_already_exists",
  "password_too_short",
  "password_too_long",
  "invalid_email",
  "signups_closed", // our own gate (auth.ts before-create hook)
]);

/** Email+password sign-in; persistent=false means a browser-session cookie. */
export async function signInEmail(email: string, password: string, persistent: boolean): Promise<void> {
  const { error } = await authClient.signIn.email({ email, password, rememberMe: persistent });
  if (error) throw new Error(authErrorCode(error, "sign_in_failed"));
}

/** Registration — the server gate (signupsOpen) decides; a closed gate answers 403 signups_closed. */
export async function signUpEmail(email: string, password: string, persistent: boolean): Promise<void> {
  // better-auth's client TYPE for this one route (InferSignUpEmailCtx) hand-overrides the
  // otherwise-generic inference and forgets rememberMe, even though the server route schema
  // has it (dist/api/routes/sign-up.d.mts) and the client runtime spreads whatever body
  // properties it's given. Binding to a variable first avoids the excess-property check on
  // the object literal without widening anything else — a TS quirk, not a behavior change.
  const body = { email, password, name: email.split("@")[0] ?? email, rememberMe: persistent };
  const { error } = await authClient.signUp.email(body);
  if (error) throw new Error(authErrorCode(error, "sign_up_failed"));
}

/** Google sign-in — an OAuth redirect; returning to the origin → a normal boot. */
export const signInGoogle = () => authClient.signIn.social({ provider: "google" });

/**
 * Identity of the CURRENT session, straight from the server: the signed-in user's id,
 * or null when there is no session. The sync engine calls this before it writes anything
 * (see the multi-tenant guard in sync.ts), so the two failure modes must stay strictly
 * apart:
 *  - "no session" (401 / empty body) → null → the caller shows Login,
 *  - network failure → THROWS → the caller retries with backoff.
 * Mixing them up would either sign a phone in a tunnel out of the app, or (worse) let a
 * replica of unknown ownership push while offline-ish. `/api/auth/*` is exempt from the
 * session middleware, so this endpoint answers without a cookie too.
 */
export async function fetchSessionUserId(): Promise<string | null> {
  const r = await fetch("/api/auth/get-session", { headers: { accept: "application/json" } });
  if (r.status === 401) return null;
  if (!r.ok) throw new Error(`get-session: ${r.status}`); // 5xx/network → retry, NOT "signed out"
  const body = (await r.json().catch(() => null)) as { user?: { id?: string } } | null;
  return body?.user?.id ?? null; // better-auth answers 200 + `null` when there is no session
}

/**
 * Sign-out for SELFHOST deployments — it KEEPS the local replica (spec §3, binding owner
 * decision; the CLOUD path is signOutSessionOnly + discardLocalReplica, see LogoutRow).
 * Used by BOTH exits: Settings → Sign out, and ForeignReplicaScreen (where
 * the replica belongs to a DIFFERENT account than the session and is certainly not this session's
 * to delete). `enterLogin` = sync.enterLoginKeepingReplica (Login screen; signing back in resumes
 * the ledger and every queued op exactly where they stopped).
 *
 * Wiping here would be a data-loss path with no undo: the replica can be the LAST copy of the
 * budget and the outbox can hold ops the
 * server has never seen (offline, or a failing push) — a window.confirm is not consent to destroy
 * them. The NEXT account to sign in on this device is protected by the multi-tenant guard in
 * sync.ts (a foreign replica is neither rendered nor written anywhere), not by a wipe. Deleting
 * the local copy on purpose is still one tap away: Settings → Clear local data.
 */
export async function signOutKeepingReplica(enterLogin: () => void): Promise<void> {
  await authClient.signOut();
  clearEphemeralOpenAiCredential();
  await Promise.all([accountPreferences.clear(), devicePreferences.clear()]);
  enterLogin();
}

/**
 * Bare session sign-out — the CLOUD path. The caller (LogoutRow) wipes the replica AFTER this
 * succeeds: flush outbox → signOut → discardLocalReplica. Kept separate from
 * signOutKeepingReplica so auth.ts never imports sync.ts (import cycle — sync.ts imports this
 * module), and so the wipe cannot run when the sign-out itself failed.
 */
export async function signOutSessionOnly(): Promise<void> {
  await authClient.signOut();
  clearEphemeralOpenAiCredential();
  await Promise.all([accountPreferences.clear(), devicePreferences.clear()]);
}

/** Does the backend have a session at all? */
export async function hasSession(): Promise<boolean> {
  try {
    const s = await authClient.getSession();
    return !!(s as { data?: { user?: unknown } })?.data?.user;
  } catch {
    return false;
  }
}
