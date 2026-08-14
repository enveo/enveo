import { storageMode } from "./idb";

/** Last used account (per device, localStorage — outside sync):
 *  preselection on the Add screen and in the screenshot import. */
const KEY = "enveo.lastAccount";

export function getLastAccountId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setLastAccountId(id: string): void {
  if (storageMode() === "memory-session") return; // session-only use leaves no trace
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode / no storage — the preference simply won't be saved */
  }
}

/** Cloud sign-out: the preference leaves the device with the account. */
export function clearLastAccountId(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Preselection: the remembered account if still active, otherwise the fallback. */
export function preferredAccountId(accounts: Array<{ id: string; archived: boolean }>, fallback: string): string {
  const last = getLastAccountId();
  return last && accounts.some((a) => a.id === last && !a.archived) ? last : fallback;
}
