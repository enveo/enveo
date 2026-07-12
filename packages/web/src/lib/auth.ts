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
