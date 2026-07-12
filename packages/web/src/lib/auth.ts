/**
 * better-auth client (same origin — the backend mounts /api/auth/* only in
 * AUTH_MODE=multi). In the none mode these functions are never called on the
 * critical path: LoginScreen appears only after a 401, and LogoutRow only when
 * hasSession() returns true (in none the endpoint doesn't exist → false).
 */
import { createAuthClient } from "better-auth/client";

export const authClient = createAuthClient();

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

/** Does the backend have a session at all (AUTH_MODE=multi)? In the none mode → false. */
export async function hasSession(): Promise<boolean> {
  try {
    const s = await authClient.getSession();
    return !!(s as { data?: { user?: unknown } })?.data?.user;
  } catch {
    return false;
  }
}
