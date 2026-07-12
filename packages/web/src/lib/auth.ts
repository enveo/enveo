/**
 * better-auth client (same origin — the backend always mounts /api/auth/*).
 * Accounts are MANDATORY: every /api/* call except /api/auth/* and /api/health
 * needs a session, so a boot without one lands on LoginScreen.
 */
import { createAuthClient } from "better-auth/client";

export const authClient = createAuthClient();

/** What the login screen must render — from the public GET /api/auth/meta. */
export type AuthMeta = { signupsOpen: boolean; firstRun: boolean; providers: { google: boolean } };

export async function fetchAuthMeta(): Promise<AuthMeta> {
  const r = await fetch("/api/auth/meta");
  if (!r.ok) throw new Error("auth_meta_failed");
  return (await r.json()) as AuthMeta;
}

/** Email+password sign-in; throws with better-auth's message on failure. */
export async function signInEmail(email: string, password: string): Promise<void> {
  const { error } = await authClient.signIn.email({ email, password });
  if (error) throw new Error(error.message ?? "sign_in_failed");
}

/** Registration — the server gate (signupsOpen) decides; a closed gate answers 403 signups_closed. */
export async function signUpEmail(email: string, password: string): Promise<void> {
  const { error } = await authClient.signUp.email({ email, password, name: email.split("@")[0] ?? email });
  if (error) throw new Error(error.message ?? "sign_up_failed");
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
 * Sign-out + removal of the local replica (a shared device: the local copy of
 * the budget must not remain after sign-out). `wipe` = sync.wipeLocalData
 * (clears the IDB stores, broadcasts to tabs, reloads the page).
 */
export async function signOutAndForget(wipe: () => Promise<void>): Promise<void> {
  await authClient.signOut();
  await wipe(); // shared device: the local replica must not remain
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
