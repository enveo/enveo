import { storageMode } from "./idb";



const KEY = "enveo.lastAccount";

export function getLastAccountId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setLastAccountId(id: string): void {
  if (storageMode() === "memory-session") return;  
  try {
    localStorage.setItem(KEY, id);
  } catch {
     
  }
}

/** Explicit sign-out: this account-derived device preference must not remain behind. */
export function clearLastAccountId(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
     
  }
}

/** Preselection: the remembered account if still active, otherwise the fallback. */
export function preferredAccountId(accounts: Array<{ id: string; archived: boolean }>, fallback: string): string {
  const last = getLastAccountId();
  return last && accounts.some((a) => a.id === last && !a.archived) ? last : fallback;
}
