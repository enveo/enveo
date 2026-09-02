const PREFIX = "enveo.signOut.v1.";
const GENERATION_KEY = `${PREFIX}generation`;
const PRESENCE_PREFIX = `${PREFIX}presence.`;
const ATTEMPT_PREFIX = `${PREFIX}attempt.`;

export const SIGN_OUT_COORDINATION_ERROR = "sign_out_coordination_failed";

export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SignOutAttemptMarker {
  readonly v: 1;
  readonly ready: boolean;
  readonly attemptId: string;
  readonly sourceId: string;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly requiredSourceIds: readonly string[];
}

interface PresenceRecord {
  readonly v: 1;
  readonly sourceId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type PersistDecision = "run" | "wait" | "skip";

export interface SignOutRegistry {
  readonly sourceId: string;
  readonly pageGeneration: string;
  refreshPresence(): void;
  removePresence(): void;
  createAttempt(): SignOutAttemptMarker;
  readAttempt(attemptId: string): SignOutAttemptMarker | null;
  activeAttempts(): readonly SignOutAttemptMarker[];
  removeAttempt(attemptId: string): void;
  renewAttempt(attemptId: string): void;
  allowDrain(attemptId: string): void;
  closeDrain(attemptId: string): void;
  persistDecision(): PersistDecision;
  rotateGeneration(attemptId: string): void;
  isPageGenerationCurrent(): boolean;
  isSoleActiveAttempt(attemptId: string, sourceId: string): boolean;
}

interface RegistryOptions {
  readonly storage: StorageLike;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly ttlMs?: number;
}

function fail(): never {
  throw new Error(SIGN_OUT_COORDINATION_ERROR);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function parsePresence(value: string | null): PresenceRecord | null {
  if (!value) return null;
  try {
    const record = JSON.parse(value) as Partial<PresenceRecord>;
    if (
      record.v !== 1 ||
      !isOpaqueId(record.sourceId) ||
      typeof record.createdAt !== "number" ||
      typeof record.expiresAt !== "number" ||
      record.expiresAt < record.createdAt
    ) {
      return null;
    }
    return record as PresenceRecord;
  } catch {
    return null;
  }
}

function parseAttempt(value: string | null): SignOutAttemptMarker | null {
  if (!value) return null;
  try {
    const record = JSON.parse(value) as Partial<SignOutAttemptMarker>;
    if (
      record.v !== 1 ||
      typeof record.ready !== "boolean" ||
      !isOpaqueId(record.attemptId) ||
      !isOpaqueId(record.sourceId) ||
      typeof record.startedAt !== "number" ||
      typeof record.expiresAt !== "number" ||
      record.expiresAt < record.startedAt ||
      !Array.isArray(record.requiredSourceIds) ||
      !record.requiredSourceIds.every(isOpaqueId)
    ) {
      return null;
    }
    return record as SignOutAttemptMarker;
  } catch {
    return null;
  }
}

export function createSignOutRegistry(options: RegistryOptions): SignOutRegistry {
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const ttlMs = options.ttlMs ?? 60_000;
  const storage = options.storage;
  const sourceId = randomId();
  if (!isOpaqueId(sourceId) || !Number.isFinite(ttlMs) || ttlMs <= 0) fail();
  const draining = new Set<string>();

  const get = (key: string): string | null => {
    try {
      return storage.getItem(key);
    } catch {
      return fail();
    }
  };
  const set = (key: string, value: string): void => {
    try {
      storage.setItem(key, value);
    } catch {
      fail();
    }
  };
  const remove = (key: string): void => {
    try {
      storage.removeItem(key);
    } catch {
      fail();
    }
  };
  const keys = (): string[] => {
    try {
      return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => key !== null);
    } catch {
      return fail();
    }
  };

  let pageGeneration = get(GENERATION_KEY);
  if (!isOpaqueId(pageGeneration)) {
    pageGeneration = randomId();
    if (!isOpaqueId(pageGeneration)) fail();
    set(GENERATION_KEY, pageGeneration);
  }

  const activePresences = (): PresenceRecord[] => {
    const at = now();
    const result: PresenceRecord[] = [];
    for (const key of keys()) {
      if (!key.startsWith(PRESENCE_PREFIX)) continue;
      const record = parsePresence(get(key));
      if (!record || record.expiresAt <= at || record.expiresAt > at + ttlMs) {
        remove(key);
        continue;
      }
      result.push(record);
    }
    return result;
  };

  const registry: SignOutRegistry = {
    sourceId,
    pageGeneration,
    refreshPresence() {
      const at = now();
      const record: PresenceRecord = { v: 1, sourceId, createdAt: at, expiresAt: at + ttlMs };
      set(`${PRESENCE_PREFIX}${sourceId}`, JSON.stringify(record));
    },
    removePresence() {
      remove(`${PRESENCE_PREFIX}${sourceId}`);
    },
    createAttempt() {
      registry.refreshPresence();
      const startedAt = now();
      const attemptId = randomId();
      if (!isOpaqueId(attemptId)) fail();
      const collecting: SignOutAttemptMarker = {
        v: 1,
        ready: false,
        attemptId,
        sourceId,
        startedAt,
        expiresAt: startedAt + ttlMs,
        requiredSourceIds: [],
      };
      // Publish the blocker BEFORE taking the presence snapshot. A page that registers after
      // the snapshot must already be able to observe this marker before it starts boot/sync.
      set(`${ATTEMPT_PREFIX}${attemptId}`, JSON.stringify(collecting));
      const marker: SignOutAttemptMarker = {
        ...collecting,
        ready: true,
        requiredSourceIds: activePresences()
          .filter((presence) => presence.sourceId !== sourceId)
          .map((presence) => presence.sourceId)
          .sort(),
      };
      set(`${ATTEMPT_PREFIX}${attemptId}`, JSON.stringify(marker));
      draining.add(marker.attemptId);
      return marker;
    },
    readAttempt(attemptId) {
      const key = `${ATTEMPT_PREFIX}${attemptId}`;
      const marker = parseAttempt(get(key));
      const at = now();
      if (!marker || marker.attemptId !== attemptId || marker.expiresAt <= at || marker.expiresAt > at + ttlMs) {
        if (get(key) !== null) remove(key);
        return null;
      }
      return marker;
    },
    activeAttempts() {
      activePresences(); // bounded registry: reap invalid/expired page records on every scan
      const result: SignOutAttemptMarker[] = [];
      for (const key of keys()) {
        if (!key.startsWith(ATTEMPT_PREFIX)) continue;
        const attemptId = key.slice(ATTEMPT_PREFIX.length);
        const marker = registry.readAttempt(attemptId);
        if (marker) result.push(marker);
      }
      return result.sort((a, b) => a.attemptId.localeCompare(b.attemptId));
    },
    removeAttempt(attemptId) {
      remove(`${ATTEMPT_PREFIX}${attemptId}`);
      draining.delete(attemptId);
    },
    renewAttempt(attemptId) {
      const marker = registry.readAttempt(attemptId);
      if (!marker || marker.sourceId !== sourceId) fail();
      set(`${ATTEMPT_PREFIX}${attemptId}`, JSON.stringify({ ...marker, expiresAt: now() + ttlMs }));
    },
    allowDrain(attemptId) {
      draining.add(attemptId);
    },
    closeDrain(attemptId) {
      draining.delete(attemptId);
    },
    persistDecision() {
      if (!registry.isPageGenerationCurrent()) return "skip";
      for (const marker of registry.activeAttempts()) {
        const mayDrain = (marker.sourceId === sourceId || marker.requiredSourceIds.includes(sourceId)) && draining.has(marker.attemptId);
        if (!mayDrain) return "wait";
      }
      return "run";
    },
    rotateGeneration(attemptId) {
      if (!registry.isSoleActiveAttempt(attemptId, sourceId)) fail();
      const marker = registry.readAttempt(attemptId);
      if (!marker || marker.sourceId !== sourceId) fail();
      const nextGeneration = randomId();
      if (!isOpaqueId(nextGeneration) || nextGeneration === pageGeneration) fail();
      set(GENERATION_KEY, nextGeneration);
    },
    isPageGenerationCurrent() {
      return get(GENERATION_KEY) === pageGeneration;
    },
    isSoleActiveAttempt(attemptId, expectedSourceId) {
      if (!registry.isPageGenerationCurrent()) return false;
      const markers = registry.activeAttempts();
      return markers.length === 1 && markers[0]?.ready === true && markers[0].attemptId === attemptId && markers[0].sourceId === expectedSourceId;
    },
  };

  return registry;
}

export function browserSignOutStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export interface RegistryWriteGate {
  beforeWrite(): Promise<"run" | "skip">;
  notify(): void;
}

/** A sleeping persistence task is awakened by protocol messages and also polls for expiry. */
export function createRegistryWriteGate(registry: SignOutRegistry, pollMs = 25): RegistryWriteGate {
  let waiters = new Set<() => void>();
  return {
    async beforeWrite() {
      for (;;) {
        const decision = registry.persistDecision();
        if (decision !== "wait") return decision;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waiters.delete(wake);
            resolve();
          }, pollMs);
          const wake = () => {
            clearTimeout(timer);
            resolve();
          };
          waiters.add(wake);
        });
      }
    },
    notify() {
      const current = waiters;
      waiters = new Set();
      for (const wake of current) wake();
    },
  };
}

export type SignOutCoordinationMessage =
  | { readonly type: "sign-out-start"; readonly attemptId: string; readonly sourceId: string }
  | {
      readonly type: "sign-out-ack";
      readonly attemptId: string;
      readonly sourceId: string;
      readonly targetSourceId: string;
      readonly ok: boolean;
    }
  | { readonly type: "sign-out-cancel"; readonly attemptId: string; readonly sourceId: string };

export type CoordinationPermit = object;

export interface SignOutCoordinationLease<Permit = CoordinationPermit> {
  readonly attemptId: string;
  readonly sourceId: string;
  readonly permit: Permit;
}

export interface SignOutBarrierPort<Permit> {
  activate(attemptId: string, sourceId: string, kind: "local" | "remote"): void;
  release(attemptId: string): void;
  createPermit(attemptId: string): Permit;
  markLocalCleared(attemptId: string): void;
}

interface CoordinatorOptions<Permit> {
  readonly registry: SignOutRegistry;
  readonly barrier: SignOutBarrierPort<Permit>;
  readonly gate: RegistryWriteGate;
  readonly send: (message: SignOutCoordinationMessage) => void;
  readonly quiesceCycle: () => Promise<void>;
  readonly quiesceServerWrites: () => Promise<void>;
  readonly drainPersistence: () => Promise<void>;
  readonly waitForTimeout?: (ms: number) => Promise<void>;
  readonly handshakeTimeoutMs?: number;
}

export interface SignOutCoordinator<Permit> {
  install(): void;
  maintain(): void;
  begin(): Promise<SignOutCoordinationLease<Permit>>;
  handleMessage(message: unknown): void;
  cancel(lease: SignOutCoordinationLease<Permit>): void;
  assertLease(lease: SignOutCoordinationLease<Permit>): void;
  runFinalFlush<T>(lease: SignOutCoordinationLease<Permit>, flush: () => Promise<T>): Promise<T>;
  markServerSucceeded(lease: SignOutCoordinationLease<Permit>): void;
  runLocalClear(lease: SignOutCoordinationLease<Permit>, clear: () => Promise<void>): Promise<void>;
  finish(lease: SignOutCoordinationLease<Permit>): void;
}

function isMessage(value: unknown): value is SignOutCoordinationMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (!isOpaqueId(message.attemptId) || !isOpaqueId(message.sourceId)) return false;
  if (message.type === "sign-out-start" || message.type === "sign-out-cancel") return true;
  return message.type === "sign-out-ack" && isOpaqueId(message.targetSourceId) && typeof message.ok === "boolean";
}

export function createSignOutCoordinator<Permit>(options: CoordinatorOptions<Permit>): SignOutCoordinator<Permit> {
  const waitForTimeout = options.waitForTimeout ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.handshakeTimeoutMs ?? 5_000;
  const remoteSources = new Map<string, string>();
  const pending = new Map<string, { readonly required: Set<string>; readonly resolve: () => void; readonly reject: () => void; failed: boolean }>();
  const liveLeases = new Map<string, SignOutCoordinationLease<Permit>>();
  const leaseStages = new Map<string, "blocking" | "server-succeeded" | "clearing" | "cleared">();

  const assertLease = (lease: SignOutCoordinationLease<Permit>, expected?: readonly string[]): void => {
    const stage = leaseStages.get(lease.attemptId);
    if (
      liveLeases.get(lease.attemptId) !== lease ||
      (expected && !expected.includes(stage ?? "")) ||
      !options.registry.isSoleActiveAttempt(lease.attemptId, lease.sourceId)
    ) {
      fail();
    }
  };

  const failPending = (attemptId: string): void => {
    const state = pending.get(attemptId);
    if (!state || state.failed) return;
    state.failed = true;
    state.reject();
  };

  const processRemoteStart = async (marker: SignOutAttemptMarker): Promise<void> => {
    const required = marker.requiredSourceIds.includes(options.registry.sourceId);
    options.barrier.activate(marker.attemptId, marker.sourceId, "remote");
    remoteSources.set(marker.attemptId, marker.sourceId);
    if (required) options.registry.allowDrain(marker.attemptId);
    options.gate.notify();
    let ok = true;
    try {
      await options.quiesceCycle();
      await options.quiesceServerWrites();
      if (required) await options.drainPersistence();
    } catch {
      ok = false;
    } finally {
      options.registry.closeDrain(marker.attemptId);
      options.gate.notify();
    }
    if (required) {
      options.send({
        type: "sign-out-ack",
        attemptId: marker.attemptId,
        sourceId: options.registry.sourceId,
        targetSourceId: marker.sourceId,
        ok,
      });
    }
  };

  const activateMarker = (marker: SignOutAttemptMarker): void => {
    if (!marker.ready) return;
    if (marker.sourceId === options.registry.sourceId) return;
    if (remoteSources.get(marker.attemptId) === marker.sourceId) return;
    void processRemoteStart(marker).catch(() => {
      // processRemoteStart converts operational failures into a negative acknowledgement.
    });
  };

  const coordinator: SignOutCoordinator<Permit> = {
    install() {
      // Synchronous barrier activation is the important part: callers may start boot immediately
      // after install, while quiescence/acknowledgement continues asynchronously.
      for (const marker of options.registry.activeAttempts()) activateMarker(marker);
      options.registry.refreshPresence();
    },
    maintain() {
      options.registry.refreshPresence();
      const markers = options.registry.activeAttempts();
      const activeIds = new Set(markers.map((marker) => marker.attemptId));
      for (const marker of markers) activateMarker(marker);
      for (const attemptId of remoteSources.keys()) {
        if (activeIds.has(attemptId)) continue;
        remoteSources.delete(attemptId);
        options.registry.closeDrain(attemptId);
        options.barrier.release(attemptId);
      }
      for (const lease of liveLeases.values()) options.registry.renewAttempt(lease.attemptId);
      options.gate.notify();
    },
    async begin() {
      let marker: SignOutAttemptMarker | null = null;
      try {
        marker = options.registry.createAttempt();
        options.barrier.activate(marker.attemptId, marker.sourceId, "local");
        const lease: SignOutCoordinationLease<Permit> = {
          attemptId: marker.attemptId,
          sourceId: marker.sourceId,
          permit: options.barrier.createPermit(marker.attemptId),
        };
        liveLeases.set(marker.attemptId, lease);
        leaseStages.set(marker.attemptId, "blocking");
        let resolveAcks!: () => void;
        let rejectAcks!: () => void;
        const acknowledgements = new Promise<void>((resolve, reject) => {
          resolveAcks = resolve;
          rejectAcks = reject;
        });
        const state = { required: new Set(marker.requiredSourceIds), resolve: resolveAcks, reject: rejectAcks, failed: false };
        pending.set(marker.attemptId, state);
        if (state.required.size === 0) state.resolve();
        options.send({ type: "sign-out-start", attemptId: marker.attemptId, sourceId: marker.sourceId });

        const localQuiescence = (async () => {
          await options.quiesceCycle();
          await options.quiesceServerWrites();
          await options.drainPersistence();
          options.registry.closeDrain(marker!.attemptId);
          options.gate.notify();
        })();
        await Promise.race([Promise.all([localQuiescence, acknowledgements]), waitForTimeout(timeoutMs).then(() => fail())]);
        pending.delete(marker.attemptId);
        return lease;
      } catch {
        if (marker) {
          pending.delete(marker.attemptId);
          liveLeases.delete(marker.attemptId);
          leaseStages.delete(marker.attemptId);
          options.registry.removeAttempt(marker.attemptId);
          options.barrier.release(marker.attemptId);
          options.gate.notify();
          options.send({ type: "sign-out-cancel", attemptId: marker.attemptId, sourceId: marker.sourceId });
        }
        return fail();
      }
    },
    handleMessage(value) {
      if (!isMessage(value)) return;
      if (value.type === "sign-out-start") {
        const marker = options.registry.readAttempt(value.attemptId);
        if (!marker?.ready || marker.sourceId !== value.sourceId) return;
        activateMarker(marker);
        return;
      }
      if (value.type === "sign-out-ack") {
        if (value.targetSourceId !== options.registry.sourceId) return;
        const marker = options.registry.readAttempt(value.attemptId);
        const state = pending.get(value.attemptId);
        if (!marker?.ready || marker.sourceId !== options.registry.sourceId || !state || !state.required.has(value.sourceId)) return;
        if (!value.ok) {
          failPending(value.attemptId);
          return;
        }
        state.required.delete(value.sourceId);
        if (state.required.size === 0) state.resolve();
        return;
      }
      if (remoteSources.get(value.attemptId) !== value.sourceId) return;
      remoteSources.delete(value.attemptId);
      options.registry.closeDrain(value.attemptId);
      options.barrier.release(value.attemptId);
      options.gate.notify();
    },
    cancel(lease) {
      if (liveLeases.get(lease.attemptId) !== lease || leaseStages.get(lease.attemptId) !== "blocking") fail();
      liveLeases.delete(lease.attemptId);
      leaseStages.delete(lease.attemptId);
      pending.delete(lease.attemptId);
      options.registry.removeAttempt(lease.attemptId);
      options.barrier.release(lease.attemptId);
      options.gate.notify();
      options.send({ type: "sign-out-cancel", attemptId: lease.attemptId, sourceId: lease.sourceId });
    },
    assertLease(lease) {
      assertLease(lease);
    },
    async runFinalFlush(lease, flush) {
      assertLease(lease, ["blocking"]);
      options.registry.allowDrain(lease.attemptId);
      options.gate.notify();
      try {
        assertLease(lease, ["blocking"]);
        const result = await flush();
        await options.drainPersistence();
        assertLease(lease, ["blocking"]);
        return result;
      } finally {
        options.registry.closeDrain(lease.attemptId);
        options.gate.notify();
      }
    },
    markServerSucceeded(lease) {
      assertLease(lease, ["blocking"]);
      leaseStages.set(lease.attemptId, "server-succeeded");
    },
    async runLocalClear(lease, clear) {
      assertLease(lease, ["server-succeeded"]);
      leaseStages.set(lease.attemptId, "clearing");
      options.registry.allowDrain(lease.attemptId);
      options.gate.notify();
      try {
        // The marker/generation check is immediately adjacent to the destructive callback.
        assertLease(lease, ["clearing"]);
        await clear();
        assertLease(lease, ["clearing"]);
        options.registry.rotateGeneration(lease.attemptId);
        options.barrier.markLocalCleared(lease.attemptId);
        leaseStages.set(lease.attemptId, "cleared");
      } catch (error) {
        if (leaseStages.get(lease.attemptId) === "clearing") leaseStages.set(lease.attemptId, "server-succeeded");
        throw error;
      } finally {
        options.registry.closeDrain(lease.attemptId);
        options.gate.notify();
      }
    },
    finish(lease) {
      const stage = leaseStages.get(lease.attemptId);
      if (liveLeases.get(lease.attemptId) !== lease || stage !== "cleared") fail();
      liveLeases.delete(lease.attemptId);
      leaseStages.delete(lease.attemptId);
      pending.delete(lease.attemptId);
      options.registry.removeAttempt(lease.attemptId);
      options.gate.notify();
      // Deliberately keep this page's barrier active. Task 5 broadcasts terminal wipe next.
    },
  };

  return coordinator;
}
