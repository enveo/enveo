import { isSignOutBlocking, isSignOutPermitActive, type SignOutPermit } from "./signOutBarrier";

export type ServerWriteOperationKind =
  | "backup-replace"
  | "e2ee-enable"
  | "e2ee-disable"
  | "e2ee-upgrade"
  | "e2ee-rekey"
  | "e2ee-reset"
  | "e2ee-checkpoint"
  | "sync-push"
  | "direct-api-write"
  | "account-preferences"
  | "auth-session"
  | "auth-sign-out"
  | "openai-post"
  | "sync-final-flush";

let nextId = 0;
const active = new Map<number, ServerWriteOperationKind>();
let waiters = new Set<() => void>();

function assertAllowed(permit?: SignOutPermit): void {
  if (isSignOutBlocking() && !isSignOutPermitActive(permit)) throw new Error("sign_out_in_progress");
}

/** Register before the first await, so barrier activation and operation admission are ordered. */
export async function runServerWriteOperation<T>(kind: ServerWriteOperationKind, operation: () => Promise<T>, permit?: SignOutPermit): Promise<T> {
  assertAllowed(permit);
  const id = ++nextId;
  active.set(id, kind);
  try {
    // Recheck after registration. If a barrier was activated by synchronous test/instrumentation,
    // the operation still has not started its server write and must fail closed.
    assertAllowed(permit);
    return await operation();
  } finally {
    active.delete(id);
    if (active.size === 0) {
      const current = waiters;
      waiters = new Set();
      for (const resolve of current) resolve();
    }
  }
}

export async function awaitServerWriteOperationsQuiescent(): Promise<void> {
  while (active.size > 0) {
    await new Promise<void>((resolve) => waiters.add(resolve));
  }
}

export function __resetServerWriteOperationsForTests(): void {
  active.clear();
  nextId = 0;
  const current = waiters;
  waiters = new Set();
  for (const resolve of current) resolve();
}
