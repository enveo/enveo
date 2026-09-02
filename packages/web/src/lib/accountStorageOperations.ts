import { isSignOutBlocking, isSignOutPermitActive, type SignOutPermit } from "./signOutBarrier";

export interface AccountStorageGenerationFence {
  isCurrent(): boolean;
}

let generationFence: AccountStorageGenerationFence | null = null;
let persistenceDrainAllowed: (() => boolean) | null = null;
let persistenceAdmissionDepth = 0;
let privilegedAdmissionDepth = 0;
let nextOperationId = 0;
const activeWrites = new Set<number>();
let waiters = new Set<() => void>();

function assertGenerationCurrent(): void {
  let current = false;
  try {
    current = generationFence?.isCurrent() ?? true;
  } catch {
    current = false;
  }
  if (!current) throw new Error("stale_account_storage_generation");
}

function assertAdmission(permit?: SignOutPermit): void {
  assertGenerationCurrent();
  if (isSignOutBlocking() && persistenceAdmissionDepth === 0 && privilegedAdmissionDepth === 0 && !isSignOutPermitActive(permit)) {
    throw new Error("sign_out_in_progress");
  }
}

export function configureAccountStorageGenerationFence(fence: AccountStorageGenerationFence | null): void {
  generationFence = fence;
}

/** Installed by the coordination root; only persist.ts consumes this narrow drain adapter. */
export function configurePersistenceAccountStorageDrain(allowed: (() => boolean) | null): void {
  persistenceDrainAllowed = allowed;
}

export function runPersistenceAccountStorageWrite<T>(operation: () => Promise<T>): Promise<T> {
  assertGenerationCurrent();
  if (isSignOutBlocking()) {
    let allowed = false;
    try {
      allowed = persistenceDrainAllowed?.() ?? false;
    } catch {
      allowed = false;
    }
    if (!allowed) throw new Error("sign_out_in_progress");
  }
  persistenceAdmissionDepth++;
  try {
    // Every IDB facade starts its registered write synchronously before returning its promise.
    return operation();
  } finally {
    persistenceAdmissionDepth--;
  }
}

/** Register before the first await so sign-out quiescence cannot overtake an admitted writer. */
export async function runAccountStorageWrite<T>(operation: () => Promise<T>, permit?: SignOutPermit): Promise<T> {
  assertAdmission(permit);
  const operationId = ++nextOperationId;
  activeWrites.add(operationId);
  try {
    assertAdmission(permit);
    const inheritedPermit = isSignOutPermitActive(permit);
    if (inheritedPermit) privilegedAdmissionDepth++;
    let pending: Promise<T>;
    try {
      pending = operation();
    } finally {
      if (inheritedPermit) privilegedAdmissionDepth--;
    }
    const result = await pending;
    // Rotation waits for every registered operation. This postcondition detects a broken
    // integration instead of silently accepting a stale continuation after account clear.
    assertGenerationCurrent();
    return result;
  } finally {
    activeWrites.delete(operationId);
    if (activeWrites.size === 0) {
      const current = waiters;
      waiters = new Set();
      for (const resolve of current) resolve();
    }
  }
}

export async function awaitAccountStorageWritesQuiescent(): Promise<void> {
  while (activeWrites.size > 0) {
    await new Promise<void>((resolve) => waiters.add(resolve));
  }
}

export function __resetAccountStorageOperationsForTests(): void {
  generationFence = null;
  persistenceDrainAllowed = null;
  persistenceAdmissionDepth = 0;
  privilegedAdmissionDepth = 0;
  nextOperationId = 0;
  activeWrites.clear();
  const current = waiters;
  waiters = new Set();
  for (const resolve of current) resolve();
}
