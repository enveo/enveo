export type SignOutPhase = "idle" | "blocking" | "local-cleared" | "cleanup-failed";
export type SignOutAttemptKind = "local" | "remote";

const LEGACY_ATTEMPT_ID = "legacy-sign-out";
const LEGACY_SOURCE_ID = "legacy-source";

interface ActiveAttempt {
  readonly sourceId: string;
  readonly kind: SignOutAttemptKind;
  phase: Exclude<SignOutPhase, "idle">;
}

/** An unforgeable capability held only by the coordinator for its live local attempt. */
export interface SignOutPermit {
  readonly __signOutPermit: unique symbol;
}

const attempts = new Map<string, ActiveAttempt>();
const permits = new Map<string, SignOutPermit>();
const permitAttempts = new WeakMap<object, string>();
const listeners = new Set<() => void>();
let sharedBlocker: (() => boolean) | null = null;
let sharedPermitValidator: ((attemptId: string) => boolean) | null = null;

export function configureSignOutSharedBlocker(blocker: (() => boolean) | null): void {
  sharedBlocker = blocker;
}

export function configureSignOutPermitValidator(validator: ((attemptId: string) => boolean) | null): void {
  sharedPermitValidator = validator;
}

function isSharedBlocking(): boolean {
  try {
    return sharedBlocker?.() ?? false;
  } catch {
    return true;
  }
}

function visiblePhase(): SignOutPhase {
  let phase: SignOutPhase = attempts.size === 0 && !isSharedBlocking() ? "idle" : "blocking";
  for (const attempt of attempts.values()) {
    if (attempt.kind !== "local") continue;
    if (attempt.phase === "cleanup-failed") return "cleanup-failed";
    if (attempt.phase === "local-cleared") phase = "local-cleared";
  }
  return phase;
}

function notifyIfChanged(before: SignOutPhase): void {
  if (visiblePhase() === before) return;
  for (const listener of listeners) listener();
}

function requireLocalAttempt(attemptId: string): ActiveAttempt {
  const attempt = attempts.get(attemptId);
  if (attempt?.kind !== "local") throw new Error("sign_out_barrier_wrong_attempt");
  return attempt;
}

export function getSignOutPhase(): SignOutPhase {
  return visiblePhase();
}

export function subscribeSignOutPhase(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Activate one independently cancellable local or remote coordination attempt. */
export function activateSignOutAttempt(attemptId: string, sourceId: string, kind: SignOutAttemptKind): void {
  const existing = attempts.get(attemptId);
  if (existing) {
    if (existing.sourceId !== sourceId || existing.kind !== kind) throw new Error("sign_out_barrier_attempt_collision");
    return;
  }
  const before = visiblePhase();
  attempts.set(attemptId, { sourceId, kind, phase: "blocking" });
  if (visiblePhase() === before) {
    for (const listener of listeners) listener();
  } else {
    notifyIfChanged(before);
  }
}

/** Release exactly one attempt; another active attempt continues to block the page. */
export function releaseSignOutAttempt(attemptId: string): void {
  const before = visiblePhase();
  attempts.delete(attemptId);
  permits.delete(attemptId);
  notifyIfChanged(before);
}

export function hasSignOutAttempt(attemptId: string): boolean {
  return attempts.has(attemptId);
}

export function createSignOutPermit(attemptId: string): SignOutPermit {
  requireLocalAttempt(attemptId);
  const existing = permits.get(attemptId);
  if (existing) return existing;
  const permit = Object.freeze({}) as SignOutPermit;
  permits.set(attemptId, permit);
  permitAttempts.set(permit, attemptId);
  return permit;
}

export function isSignOutPermitActive(permit: SignOutPermit | undefined): boolean {
  if (!permit) return false;
  const attemptId = permitAttempts.get(permit);
  if (attemptId === undefined || permits.get(attemptId) !== permit || attempts.size !== 1 || !attempts.has(attemptId)) return false;
  try {
    return sharedPermitValidator?.(attemptId) ?? true;
  } catch {
    return false;
  }
}

/** Compatibility entry point consumed by the Task 5 UI orchestration. */
export function beginSignOut(): void {
  const phase = visiblePhase();
  if (phase !== "idle") throw new Error(`sign_out_barrier_invalid_transition:${phase}->blocking`);
  activateSignOutAttempt(LEGACY_ATTEMPT_ID, LEGACY_SOURCE_ID, "local");
}

export function markLocalCleared(attemptId = LEGACY_ATTEMPT_ID): void {
  const before = visiblePhase();
  if (attemptId === LEGACY_ATTEMPT_ID && !attempts.has(attemptId)) {
    throw new Error(`sign_out_barrier_invalid_transition:${before}->local-cleared`);
  }
  const attempt = requireLocalAttempt(attemptId);
  if (attempt.phase !== "blocking" && attempt.phase !== "cleanup-failed") {
    throw new Error(`sign_out_barrier_invalid_transition:${attempt.phase}->local-cleared`);
  }
  attempt.phase = "local-cleared";
  notifyIfChanged(before);
}

export function markCleanupFailed(attemptId = LEGACY_ATTEMPT_ID): void {
  const before = visiblePhase();
  if (attemptId === LEGACY_ATTEMPT_ID && !attempts.has(attemptId)) {
    throw new Error(`sign_out_barrier_invalid_transition:${before}->cleanup-failed`);
  }
  const attempt = requireLocalAttempt(attemptId);
  if (attempt.phase !== "blocking") throw new Error(`sign_out_barrier_invalid_transition:${attempt.phase}->cleanup-failed`);
  attempt.phase = "cleanup-failed";
  notifyIfChanged(before);
}

export function cancelSignOut(): void {
  const phase = visiblePhase();
  const attempt = attempts.get(LEGACY_ATTEMPT_ID);
  if (attempt?.phase !== "blocking") {
    throw new Error(`sign_out_barrier_invalid_transition:${phase}->idle`);
  }
  releaseSignOutAttempt(LEGACY_ATTEMPT_ID);
}

export function isSignOutBlocking(): boolean {
  return attempts.size > 0 || isSharedBlocking();
}

export function __resetSignOutBarrierForTests(): void {
  attempts.clear();
  permits.clear();
  listeners.clear();
  sharedBlocker = null;
  sharedPermitValidator = null;
}
