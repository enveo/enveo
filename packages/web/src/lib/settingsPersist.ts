/**
 * Settings persistence — the localStorage half of the Settings context,
 * extracted from contexts.tsx so the device-trust gate is testable without
 * React.
 *
 * GUEST MODE (storageMode() "memory-forced") is gated in BOTH directions:
 *  - load: a guest must not INHERIT the previous (trusted) user's on-disk
 *    settings — the BYOK OpenAI key lives here (settings.openaiKey), and
 *    reading it would hand a guest a stranger's billing credential. Fresh
 *    defaults instead.
 *  - persist: nothing a guest changes may touch the disk — a key they enter
 *    lives in React state until the tab closes, like the replica.
 * The device-POLICY flags (enveo.deviceTrust, enveo.deployment) stay in
 * localStorage — they carry no user data and boot reads them before any
 * choice exists.
 */
import { storageMode } from "./idb";

const SETTINGS_KEY = "enveo.settings";

 
export function loadPersistedSettings(): Record<string, unknown> | null {
  if (storageMode() === "memory-forced") return null;  
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

 
export function persistSettings(s: unknown): void {
  if (storageMode() === "memory-forced") return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
     
  }
}

 
export function clearPersistedSettings(): void {
  try {
    localStorage.removeItem(SETTINGS_KEY);
  } catch {
     
  }
}
