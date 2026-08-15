import {
  type AccountPreferenceField,
  type AccountPreferences,
  type AccountPreferencesPatch,
  accountPreferencesSchema,
  createDefaultAccountPreferences,
} from "@enveo/shared";
import { getAccountPreferencesRemote, patchAccountPreferencesRemote } from "./accountPreferencesRemote";
import { idbDelete, idbGet, idbPut } from "./idb";

const CACHE_KEY = "accountPreferences";
const FIELDS = ["lang", "themeMode", "accentTheme"] as const satisfies readonly AccountPreferenceField[];

export type AccountPreferencesRemote = AccountPreferences & { revision: number };

export interface AccountPreferencesCache {
  userId: string;
  value: AccountPreferences;
  revision: number;
  dirty: Partial<Record<AccountPreferenceField, true>>;
  editGeneration: Partial<Record<AccountPreferenceField, number>>;
}

export interface AccountPreferencesStoreDeps {
  load(): Promise<unknown>;
  save(value: AccountPreferencesCache): Promise<void>;
  remove(): Promise<void>;
  getRemote(): Promise<AccountPreferencesRemote>;
  patchRemote(userId: string, patch: AccountPreferencesPatch): Promise<AccountPreferencesRemote>;
  onPersist?(): void;
}

let broadcastPersisted = (): void => {};

export function configureAccountPreferencesBroadcast(broadcast: () => void): void {
  broadcastPersisted = broadcast;
}

function readFieldMap<T>(raw: unknown, valid: (value: unknown) => value is T): Partial<Record<AccountPreferenceField, T>> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (Object.keys(source).some((key) => !FIELDS.includes(key as AccountPreferenceField))) return null;
  const result: Partial<Record<AccountPreferenceField, T>> = {};
  for (const field of FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    if (!valid(value)) return null;
    result[field] = value;
  }
  return result;
}

function parseCache(raw: unknown): AccountPreferencesCache | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const value = accountPreferencesSchema.safeParse(source.value);
  const dirty = readFieldMap(source.dirty, (candidate): candidate is true => candidate === true);
  const editGeneration = readFieldMap(
    source.editGeneration,
    (candidate): candidate is number => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0,
  );
  if (
    typeof source.userId !== "string" ||
    source.userId.length === 0 ||
    !value.success ||
    typeof source.revision !== "number" ||
    !Number.isSafeInteger(source.revision) ||
    source.revision < 0 ||
    !dirty ||
    !editGeneration
  )
    return null;
  return { userId: source.userId, value: value.data, revision: source.revision, dirty, editGeneration };
}

function parseRemote(raw: AccountPreferencesRemote): AccountPreferencesRemote {
  const value = accountPreferencesSchema.parse({
    schemaVersion: raw.schemaVersion,
    lang: raw.lang,
    themeMode: raw.themeMode,
    accentTheme: raw.accentTheme,
  });
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 0) throw new Error("invalid_account_preferences_revision");
  return { ...value, revision: raw.revision };
}

function freshCache(userId: string): AccountPreferencesCache {
  return { userId, value: createDefaultAccountPreferences(), revision: 0, dirty: {}, editGeneration: {} };
}

/** Identity-scoped, offline-first account preferences with field-level race reconciliation. */
export function createAccountPreferencesStore(deps: AccountPreferencesStoreDeps) {
  let cache: AccountPreferencesCache | null = null;
  let snapshot = createDefaultAccountPreferences();
  let hydratedFor: string | null = null;
  let persistChain = Promise.resolve();
  let syncFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  function publish(value: AccountPreferences): void {
    snapshot = value;
    for (const listener of listeners) listener();
  }

  function persistCurrent(): Promise<void> {
    if (!cache) return Promise.resolve();
    const value = structuredClone(cache);
    persistChain = persistChain.then(() => deps.save(value));
    return persistChain.then(() => deps.onPersist?.());
  }

  async function hydrateForUser(userId: string): Promise<void> {
    if (hydratedFor === userId) return;
    const stored = parseCache(await deps.load().catch(() => undefined));
    cache = stored?.userId === userId ? stored : freshCache(userId);
    hydratedFor = userId;
    publish(cache.value);
  }

  async function update(patch: AccountPreferencesPatch): Promise<void> {
    if (!cache || !hydratedFor) throw new Error("account_preferences_not_hydrated");
    const parsed = accountPreferencesSchema.parse({ ...cache.value, ...patch });
    for (const field of FIELDS) {
      if (patch[field] === undefined) continue;
      cache.dirty[field] = true;
      cache.editGeneration[field] = (cache.editGeneration[field] ?? 0) + 1;
    }
    cache.value = parsed;
    publish(cache.value);
    await persistCurrent();
  }

  function mergeRemote(remoteRaw: AccountPreferencesRemote, sent?: AccountPreferencesPatch, sentGeneration?: Partial<Record<AccountPreferenceField, number>>) {
    if (!cache) return;
    const remote = parseRemote(remoteRaw);
    const next = { ...cache.value };
    for (const field of FIELDS) {
      const wasSent = sent?.[field] !== undefined;
      const sentStillCurrent = wasSent && cache.editGeneration[field] === sentGeneration?.[field];
      if (sentStillCurrent) delete cache.dirty[field];
      if (!cache.dirty[field]) next[field] = remote[field] as never;
    }
    cache.value = next;
    cache.revision = Math.max(cache.revision, remote.revision);
    publish(cache.value);
  }

  async function runSync(userId: string): Promise<void> {
    await hydrateForUser(userId);
    if (!cache || cache.userId !== userId) return;
    const patch: AccountPreferencesPatch = {};
    const generations: Partial<Record<AccountPreferenceField, number>> = {};
    for (const field of FIELDS) {
      if (!cache.dirty[field]) continue;
      (patch as Record<AccountPreferenceField, unknown>)[field] = cache.value[field];
      generations[field] = cache.editGeneration[field];
    }
    const remote = Object.keys(patch).length > 0 ? await deps.patchRemote(userId, patch) : await deps.getRemote();
    if (!cache || cache.userId !== userId) return;
    mergeRemote(remote, patch, generations);
    await persistCurrent();
  }

  function sync(userId: string): Promise<void> {
    if (!syncFlight) syncFlight = runSync(userId).finally(() => (syncFlight = null));
    return syncFlight;
  }

  async function rehydrateCurrent(): Promise<void> {
    if (!hydratedFor || !cache) return;
    const stored = parseCache(await deps.load().catch(() => undefined));
    if (!stored || stored.userId !== hydratedFor) return;
    cache = stored;
    publish(cache.value);
  }

  async function clear(): Promise<void> {
    cache = null;
    hydratedFor = null;
    syncFlight = null;
    publish(createDefaultAccountPreferences());
    await persistChain.catch(() => {});
    await deps.remove();
  }

  function dehydrate(): void {
    cache = null;
    hydratedFor = null;
    publish(createDefaultAccountPreferences());
  }

  return {
    hydrateForUser,
    rehydrateCurrent,
    getSnapshot: () => snapshot,
    getCacheForTests: () => cache,
    migrationState: () => cache,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update,
    sync,
    clear,
    dehydrate,
  };
}

export const accountPreferences = createAccountPreferencesStore({
  load: () => idbGet("meta", CACHE_KEY),
  save: (value) => idbPut("meta", value, CACHE_KEY),
  remove: () => idbDelete("meta", CACHE_KEY),
  getRemote: getAccountPreferencesRemote,
  patchRemote: patchAccountPreferencesRemote,
  onPersist: () => broadcastPersisted(),
});
