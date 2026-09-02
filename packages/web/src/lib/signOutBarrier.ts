export type SignOutPhase = "idle" | "blocking" | "local-cleared" | "server-failed";

let phase: SignOutPhase = "idle";
const listeners = new Set<() => void>();

function transition(next: SignOutPhase, allowedFrom: readonly SignOutPhase[]): void {
  if (!allowedFrom.includes(phase)) throw new Error(`sign_out_barrier_invalid_transition:${phase}->${next}`);
  phase = next;
  for (const listener of listeners) listener();
}

export function getSignOutPhase(): SignOutPhase {
  return phase;
}

export function subscribeSignOutPhase(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function beginSignOut(): void {
  transition("blocking", ["idle"]);
}

export function markLocalCleared(): void {
  transition("local-cleared", ["blocking"]);
}

export function markServerFailed(): void {
  transition("server-failed", ["local-cleared"]);
}

export function cancelSignOut(): void {
  transition("idle", ["blocking", "server-failed"]);
}

export function isSignOutBlocking(): boolean {
  return phase !== "idle";
}

export function __resetSignOutBarrierForTests(): void {
  phase = "idle";
  listeners.clear();
}
