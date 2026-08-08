/**
 * PWA install exposure. The browser fires `beforeinstallprompt` when the app is
 * installable (Android + desktop Chromium); we capture it so a custom button can
 * trigger the native install dialog. iOS has no such API — the UI falls back to
 * "Share → Add to Home Screen" instructions. All platform branching flows from the
 * single pure `installState()`; the rest is a tiny useSyncExternalStore store.
 */
import { useSyncExternalStore } from "react";

export type InstallState = "installed" | "promptable" | "ios-safari" | "ios-other" | "unavailable";

/** The non-standard event Chromium fires; minimal shape we rely on. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Pure platform verdict. `deferred` truthy = a captured beforeinstallprompt event.
 * NOTE: iPadOS 13+ Safari reports a desktop-Mac UA and lands in "unavailable"
 * (no beforeinstallprompt on desktop Safari) — accepted; those users can still add
 * via Share manually, we just don't detect them.
 */
export function installState(deferred: unknown, userAgent: string, standalone: boolean): InstallState {
  if (standalone) return "installed";
  if (deferred) return "promptable";
  if (/iphone|ipad|ipod/i.test(userAgent)) {
    const otherBrowser = /crios|fxios|edgios|opios/i.test(userAgent);
    const isSafari = !otherBrowser && /safari/i.test(userAgent);
    return isSafari ? "ios-safari" : "ios-other";
  }
  return "unavailable";
}

/** Fire the native install dialog and report the user's choice. */
export async function runPrompt(e: BeforeInstallPromptEvent): Promise<"accepted" | "dismissed"> {
  await e.prompt();
  return (await e.userChoice).outcome;
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

let deferred: BeforeInstallPromptEvent | null = null;
let snapshot: InstallState = "unavailable";
let initialized = false;
const listeners = new Set<() => void>();

function recompute(): void {
  const next = installState(deferred, typeof navigator === "undefined" ? "" : navigator.userAgent, isStandalone());
  if (next === snapshot) return;
  snapshot = next;
  for (const fn of listeners) fn();
}

/** Register the capture listeners. Call once, as early as possible (main.tsx). */
export function initInstallPrompt(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    recompute();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    recompute();
  });
  recompute(); // initial (e.g. already standalone)
}

/** Fire the native dialog if we hold an event; "unavailable" otherwise. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const e = deferred;
  if (!e) return "unavailable";
  const outcome = await runPrompt(e);
  deferred = null; // single-use
  recompute();
  return outcome;
}

const getSnapshot = (): InstallState => snapshot;
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useInstall(): { state: InstallState; promptInstall: typeof promptInstall } {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  return { state, promptInstall };
}
