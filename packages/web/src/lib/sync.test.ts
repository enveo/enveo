/**
 * Sync engine — multi-tenant + re-auth guard (mandatory accounts).
 *
 * Two invariants, both about what happens BEFORE anything is written to the server:
 *  - a 401 (expired/revoked session) must reach the LOGIN screen (BootStatus "unauthed"),
 *    not just a muted badge — otherwise the outbox grows forever with no way to sign in,
 *  - a replica belonging to ANOTHER account must never write into the signed-in user's
 *    budget. Every server-write channel is guarded, not just the push loop: the durable
 *    REPLACE obligation (/sync/replace, /sync2/reset) and the E2EE enable/disable buttons
 *    (assertOwnReplica, called from Settings) overwrite the session user's budget wholesale,
 *    and the REPLACE obligation is set by an import that CLEARS the outbox — so "the outbox is
 *    empty" means nothing. The session is re-read every cycle, because the cookie is shared by
 *    all tabs and can be swapped under a long-lived tab without it ever seeing a 401.
 *
 * NOTHING is destroyed unattended. Only the userId STAMP can prove a replica FOREIGN, and even
 * that verdict merely BLOCKS every server write and hands the decision to the human (BootStatus
 * "foreign" → ForeignReplicaScreen: export a backup / remove and continue): the replica can be
 * the last copy of that budget, and a user id does not survive a server rebuild (same e-mail,
 * new uuid). A failed proof for an UNSTAMPED replica — a
 * budgetId that differs, a checkpoint its DEK cannot open — is merely inconclusive (budgetId is
 * the epoch marker and the session's budget may have just been lazily created), so it refuses
 * every write too. And an UNBOUND replica (no budgetId at all) is adopted only where adoption
 * cannot destroy anything: against a session budget that is provably empty.
 *
 * Under bun there is no window/indexedDB, so idb.ts runs in its in-memory mode and sync.ts
 * installs no triggers — the cycle can be driven directly with syncNow().
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type ClientLedger, createDefaultAccountPreferences, type SyncOp } from "@enveo/shared";
import { accountPreferences } from "./accountPreferences";
import { decryptPayload, generateDek, opAadContext } from "./crypto";
import * as e2ee from "./e2ee";
import { clearLocalData, idbGet, idbPut } from "./idb";
import * as outbox from "./outbox";
import * as persist from "./persist";
import { store } from "./store";
import {
  __resetBackoff,
  __resetIdentity,
  __resetObligations,
  assertOwnReplica,
  discardLocalReplica,
  enterLoginKeepingReplica,
  flushOutboxForSignOut,
  getSyncStatus,
  hasPendingE2eeUpgrade,
  markReplacePending,
  pushLocalToServer,
  recheckReplicaOwner,
  resetServerE2ee,
  retryBoot,
  subscribeSyncStatus,
  syncNow,
  upgradeServerE2eeV2,
} from "./sync";

const BUDGET_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BUDGET_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const emptyLedger = (): ClientLedger => ({
  accounts: [],
  groups: [],
  envelopes: [],
  transactions: [],
  allocations: [],
  categories: [],
  places: [],
  budgets: [],
});

const catOp = (): SyncOp =>
  ({
    opId: crypto.randomUUID(),
    kind: "category.create",
    payload: { id: crypto.randomUUID(), name: "Food" },
  }) as SyncOp;

const pushed = (): string[] => calls.filter((u) => u.startsWith("/api/sync/push"));
const called = (prefix: string): boolean => calls.some((u) => u.startsWith(prefix));

/* ── Server + browser stubs ───────────────────────────────────────────── */

let calls: string[] = [];
let session: { user: { id: string } } | null = null;
let reloads = 0;
/** Which budget the SESSION owns (v1 and v2 channels) — the replica is budget A's. */
let serverBudget = BUDGET_A;
/** The session's budget is PLAIN → every /api/sync2/* call answers 409 tier_mismatch. */
let serverIsPlain = false;
/** The e2ee checkpoint the session's budget holds (null = none yet). */
let serverBlob: string | null = null;
/** Does the session's budget hold data? (an EMPTY one has nothing a bad write could destroy) */
let serverHasData = false;
/** Where the session's e2ee journal ends (the client's cursor starts at 0). */
let serverE2eeCursor = 0;
/** No session endpoint at all — the device is OFFLINE (≠ "signed out": get-session THROWS). */
let offline = false;
/** What actually got WRITTEN, per budget: the whole point of the guard. */
let writes: Record<string, string[]> = {};
/** Runs when a push request arrives — lets a test swap the session mid-cycle. */
let onPush: (() => void) | null = null;
/** Runs when a PULL arrives — lets a test swap the session mid-cycle with an EMPTY outbox (the
 *  steady state: the push loop is skipped entirely, so its per-request assertion never fires). */
let onPull: (() => void) | null = null;
/** Runs when a full-budget OVERWRITE request arrives — lets a test swap the session mid-upload. */
let onOverwrite: (() => void) | null = null;
/** The `userId` each full-budget OVERWRITE named in its body (the per-request owner assertion). */
let overwriteOwners: (string | undefined)[] = [];
/** The bodies POSTed to /sync2/snapshot (the e2ee checkpoint — a whole-budget overwrite too). */
let snapshotUploads: { userId?: string; uptoSeq: number; blob?: string }[] = [];
/** Journal rows served by /api/sync2/pull (v2 ciphertext rows; empty = journal caught up). */
let serverPullOps: Array<{ seq: number; opId: string; ciphertext: string }> = [];
/** The v2 rows each /sync2/push carried — lets a test verify the encryption context. */
let pushedCipherOps: Array<{ opId: string; ciphertext: string }> = [];
/** LEGACY v1-format budget: every normal /api/sync2/* call answers 409 e2ee_upgrade_required. */
let serverUpgradeRequired = false;
/** The e2ee epoch the SESSION's budget currently sits at (the fake's tier_mismatch guard). */
let serverEpoch = 1;
/** Raw JSON bodies POSTed to /budget/e2ee/upgrade-v2 — F2 asserts retry bodies byte-identical. */
let upgradeCalls: string[] = [];
/** Simulate a network failure on the upgrade endpoint (fetch never completes). */
let upgradeNetworkFail = false;
/** Runs INSIDE the fake upgrade endpoint before it answers — a "second tab edits mid-ceremony". */
let onUpgrade: (() => void) | null = null;
let serverAccountPreferences = createDefaultAccountPreferences();
let serverAccountPreferencesRevision = 0;
const upgradeRequired = (): Response => conflict({ error: "e2ee_upgrade_required", tier: "e2ee", epoch: 1, cipherVersion: 1, budgetId: serverBudget });
const realFetch = globalThis.fetch;
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const conflict = (body: unknown): Response => new Response(JSON.stringify(body), { status: 409, headers: { "content-type": "application/json" } });
const tierMismatch = (): Response => conflict({ error: "tier_mismatch", tier: "plain", epoch: 0 });
/** The server's PER-REQUEST tenant assertion: the pushed budget must be the session's. */
const budgetMismatch = (claimed: string | undefined): Response | null =>
  claimed !== undefined && claimed !== serverBudget ? conflict({ error: "budget_mismatch", budgetId: serverBudget }) : null;
/**
 * The server's PER-REQUEST OWNER assertion on the full-budget OVERWRITE routes (api
 * ownerAssertionFails): the body names the tenant the client verified, and the server compares it
 * with the session IT resolves for THIS request — a cookie swapped mid-upload is refused.
 */
const ownerMismatch = (claimed: string | undefined): Response | null =>
  claimed !== undefined && claimed !== session?.user.id ? conflict({ error: "budget_mismatch", budgetId: serverBudget }) : null;
const wrote = (budgetId: string): string[] => writes[budgetId] ?? [];

/** A ledger with one account — the session's budget "holds data" (something to destroy). */
const nonEmptyLedger = (): ClientLedger => ({
  ...emptyLedger(),
  accounts: [
    {
      id: "acc-1",
      name: "Konto",
      color: "#fff",
      icon: "wallet",
      type: "checking",
      onBudget: true,
      initialBalance: 0,
      archived: false,
      sort: 0,
    },
  ] as ClientLedger["accounts"],
});

beforeEach(async () => {
  calls = [];
  reloads = 0;
  session = null;
  serverBudget = BUDGET_A;
  serverIsPlain = false;
  serverBlob = null;
  serverHasData = false;
  serverE2eeCursor = 0;
  offline = false;
  writes = {};
  onPush = null;
  onPull = null;
  onOverwrite = null;
  overwriteOwners = [];
  snapshotUploads = [];
  serverPullOps = [];
  pushedCipherOps = [];
  serverUpgradeRequired = false;
  serverEpoch = 1;
  upgradeCalls = [];
  upgradeNetworkFail = false;
  onUpgrade = null;
  serverAccountPreferences = createDefaultAccountPreferences();
  serverAccountPreferencesRevision = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (offline) throw new TypeError("offline"); // network failure — NOT a "signed out" answer
    if (url.startsWith("/api/auth/get-session")) return json(session); // 200 + `null` = no session
    if (url.startsWith("/api/preferences/account")) {
      if (!session) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body ?? "{}")) as { userId?: string; patch?: Partial<typeof serverAccountPreferences> };
        const refused = ownerMismatch(body.userId);
        if (refused) return refused;
        serverAccountPreferences = { ...serverAccountPreferences, ...body.patch };
        serverAccountPreferencesRevision++;
      }
      return json({ ...serverAccountPreferences, revision: serverAccountPreferencesRevision });
    }
    if (url.startsWith("/api/sync2/")) {
      if (serverIsPlain) return tierMismatch();
      if (serverUpgradeRequired) return upgradeRequired();
      if (url.startsWith("/api/sync2/snapshot")) {
        // POST = the CHECKPOINT UPLOAD: it overwrites the resolved budget's whole checkpoint
        // (blob + uptoSeq), so it carries the owner assertion just like /sync2/reset.
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body ?? "{}")) as { userId?: string; uptoSeq: number; blob?: string; epoch?: number };
          if (body.epoch !== serverEpoch) return conflict({ error: "tier_mismatch", tier: "e2ee", epoch: serverEpoch, cipherVersion: 2 });
          snapshotUploads.push(body);
          const refused = ownerMismatch(body.userId);
          if (refused) return refused;
          writes[serverBudget] = [...wrote(serverBudget), "snapshot"];
          return json({ epoch: serverEpoch, uptoSeq: body.uptoSeq });
        }
        return json({ budgetId: serverBudget, epoch: serverEpoch, wrappedDek: null, kdfParams: null, uptoSeq: 0, blob: serverBlob });
      }
      if (url.startsWith("/api/sync2/push")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          budgetId?: string;
          epoch?: number;
          ops: Array<{ opId: string; ciphertext: string }>;
        };
        // the REAL route checks the epoch BEFORE anything is written or recorded
        if (body.epoch !== serverEpoch) return conflict({ error: "tier_mismatch", tier: "e2ee", epoch: serverEpoch, cipherVersion: 2 });
        pushedCipherOps.push(...body.ops);
        const refused = budgetMismatch(body.budgetId);
        if (refused) return refused;
        writes[serverBudget] = [...wrote(serverBudget), ...body.ops.map((o) => o.opId)];
        onPush?.(); // a session swap lands BETWEEN two batches of the same push loop
        return json({ cursor: 1, epoch: serverEpoch });
      }
      if (url.startsWith("/api/sync2/pull")) {
        onPull?.(); // a session swap lands between the identity check and the pull's answer
        const reqEpoch = Number(new URLSearchParams(url.split("?")[1] ?? "").get("epoch"));
        if (reqEpoch !== serverEpoch) return conflict({ error: "tier_mismatch", tier: "e2ee", epoch: serverEpoch, cipherVersion: 2 });
        if (serverPullOps.length > 0) {
          const cursor = serverPullOps[serverPullOps.length - 1]!.seq;
          return json({ cursor, epoch: serverEpoch, ops: serverPullOps });
        }
        return json({ cursor: serverE2eeCursor, epoch: serverEpoch, ops: [] });
      }
      if (url.startsWith("/api/sync2/reset")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { userId?: string };
        overwriteOwners.push(body.userId);
        onOverwrite?.(); // a sign-in elsewhere completes while the ciphertext is uploading
        const refused = ownerMismatch(body.userId);
        if (refused) return refused;
        writes[serverBudget] = [...wrote(serverBudget), "reset"];
        return json({ epoch: 1, uptoSeq: 0 });
      }
    }
    if (url.startsWith("/api/budget/e2ee/upgrade-v2")) {
      const rawBody = String(init?.body ?? "{}");
      upgradeCalls.push(rawBody); // recorded BEFORE any simulated failure — F2 compares bodies
      if (upgradeNetworkFail) throw new TypeError("network failure mid-ceremony");
      const body = JSON.parse(rawBody) as { expectedEpoch: number; userId?: string };
      if (body.expectedEpoch !== serverEpoch) return conflict({ error: "tier_mismatch", tier: "e2ee", epoch: serverEpoch, cipherVersion: 2 });
      const refused = ownerMismatch(body.userId);
      if (refused) return refused;
      onUpgrade?.(); // a second tab edits while the ceremony's request is in flight
      serverEpoch = body.expectedEpoch + 1; // the fake commits: new generation
      writes[serverBudget] = [...wrote(serverBudget), "upgrade-v2"];
      return json({ budgetId: serverBudget, epoch: serverEpoch, cipherVersion: 2, uptoSeq: 0 });
    }
    if (url.startsWith("/api/sync/push")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { budgetId?: string; ops: SyncOp[] };
      const refused = budgetMismatch(body.budgetId);
      if (refused) return refused;
      writes[serverBudget] = [...wrote(serverBudget), ...body.ops.map((o) => o.opId)];
      const res = json({
        budgetId: serverBudget,
        results: body.ops.map((o) => ({ opId: o.opId, status: "applied" })),
      });
      onPush?.(); // a session swap lands BETWEEN two batches of the same push loop
      return res;
    }
    if (url.startsWith("/api/sync/snapshot")) {
      return json({ budgetId: serverBudget, cursor: 0, ...(serverHasData ? nonEmptyLedger() : emptyLedger()) });
    }
    if (url.startsWith("/api/sync/pull")) {
      onPull?.(); // a session swap lands between the identity check and the pull's answer
      return json({ budgetId: serverBudget, cursor: 0, resetRequired: false, changes: [] });
    }
    if (url.startsWith("/api/sync/replace")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { userId?: string };
      overwriteOwners.push(body.userId);
      onOverwrite?.(); // a sign-in elsewhere completes while the ledger is uploading
      const refused = ownerMismatch(body.userId);
      if (refused) return refused;
      writes[serverBudget] = [...wrote(serverBudget), "replace"];
      return json({ budgetId: serverBudget, cursor: 1 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  (globalThis as { location?: { reload: () => void } }).location = {
    reload: () => {
      reloads++;
    },
  };

  __resetIdentity();
  __resetObligations();
  __resetBackoff();
  outbox.clearAll();
  e2ee.__resetDekForTests();
  e2ee.clearDek();
  e2ee.resetOpsCounter(); // the checkpoint counter is module state — it outlives clearLocalData
  e2ee.setTierMeta({ tier: "plain", epoch: 0 });
  e2ee.setCipherVersion(2); // module state — a previous test's recorded legacy format must not leak
  await accountPreferences.clear();
  await clearLocalData(); // no stamp, no ledger blob — each test sets up its own
  store.replace(emptyLedger(), 0, BUDGET_A); // a booted replica of budget A
  store.setBootStatus("ready");
  void persist.persistLedger(store.snapshotForPersist()); // durable, so a wipe is observable
  await persist.flushed();
});

afterEach(() => {
  __resetBackoff(); // a scheduled retry would fire into the NEXT test's stub (and its `calls`)
  globalThis.fetch = realFetch;
  delete (globalThis as { location?: unknown }).location;
});

/* ── Pure decision: decideIdentity moved to sync/identity.test.ts with its module ── */

/* ── The cycle ────────────────────────────────────────────────────────── */

describe("sync cycle: session guard before the push", () => {
  it("no session → Login screen, nothing pushed, the outbox is preserved", async () => {
    await idbPut("meta", "user-A", "userId");
    outbox.add(catOp());
    session = null;

    await syncNow("test");

    expect(called("/api/auth/get-session")).toBe(true);
    expect(called("/api/sync/push")).toBe(false);
    expect(store.getBootStatus()).toBe("unauthed"); // App renders LoginScreen
    expect(outbox.size()).toBe(1); // the queued op survives the re-auth
  });

  it("a DIFFERENT account signed in → no push at all; the replica is BLOCKED, not destroyed", async () => {
    await idbPut("meta", "user-A", "userId"); // the replica belongs to user A
    outbox.add(catOp()); // …and carries A's unsent op
    session = { user: { id: "user-B" } }; // …but user B is signed in now

    await syncNow("test");

    expect(called("/api/sync/push")).toBe(false); // A's op NEVER reaches B's budget
    expect(store.getBootStatus()).toBe("foreign"); // App renders ForeignReplicaScreen
    expect(reloads).toBe(0); // nothing is destroyed unattended — the human decides
    await persist.flushed();
    expect(await idbGet("meta", "ledger")).toBeDefined(); // A's replica (maybe its last copy) stays
    expect(await idbGet<string>("meta", "userId")).toBe("user-A"); // …still stamped as A's
    expect(outbox.size()).toBe(1); // …and A's unsent op with it
  });

  it("the previous owner can sign back in — the sign-out KEEPS the replica", async () => {
    // The non-destructive way off ForeignReplicaScreen (and the reason "destroy nothing" is not a
    // dead end): the app is not rendered there, so Settings → sign out is unreachable.
    await idbPut("meta", "user-A", "userId");
    outbox.add(catOp());
    session = { user: { id: "user-B" } };
    await expect(assertOwnReplica()).rejects.toThrow();
    expect(store.getBootStatus()).toBe("foreign");

    session = null; // auth.signOutKeepingReplica ends the session, then calls this:
    enterLoginKeepingReplica();

    expect(store.getBootStatus()).toBe("unauthed"); // Login — A can sign back in
    expect(await idbGet("meta", "ledger")).toBeDefined(); // …with the replica untouched
    expect(outbox.size()).toBe(1);

    session = { user: { id: "user-A" } }; // A signs back in
    await syncNow("test");

    expect(pushed().length).toBe(1); // …and the queued op finally goes out, into A's own budget
    expect(store.getBootStatus()).toBe("ready");
  });

  it("only the human's explicit choice destroys a foreign replica", async () => {
    await idbPut("meta", "user-A", "userId");
    outbox.add(catOp());
    session = { user: { id: "user-B" } };
    await assertOwnReplica().catch(() => {}); // …B tries to write → "foreign"
    expect(store.getBootStatus()).toBe("foreign");

    await discardLocalReplica(); // ForeignReplicaScreen → [Remove and continue]

    expect(reloads).toBe(1);
    expect(await idbGet("meta", "ledger")).toBeUndefined(); // now, and only now, it is gone
    expect(await idbGet("meta", "userId")).toBeUndefined();
    expect(outbox.size()).toBe(0);
  });

  it("same account → the cycle runs and the owner stamp is (re)written", async () => {
    await idbPut("meta", "user-A", "userId");
    outbox.add(catOp());
    session = { user: { id: "user-A" } };

    await syncNow("test");

    expect(called("/api/sync/push")).toBe(true);
    expect(outbox.size()).toBe(0); // applied → acked
    await persist.flushed();
    expect(await idbGet<string>("meta", "userId")).toBe("user-A");
    expect(store.getBootStatus()).toBe("ready");
  });

  it("an offline attempt keeps the outbox and a later trigger retries it", async () => {
    await idbPut("meta", "user-A", "userId");
    const op = catOp();
    outbox.add(op);
    session = { user: { id: "user-A" } };
    offline = true;

    await syncNow("offline-attempt");

    expect(outbox.snapshot().map((queued) => queued.op.opId)).toEqual([op.opId]);
    expect(wrote(BUDGET_A)).toEqual([]);

    offline = false;
    await syncNow("online-trigger");

    expect(outbox.size()).toBe(0);
    expect(wrote(BUDGET_A)).toContain(op.opId);
  });

  it("syncs an offline account preference only after the replica owner is verified", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    await accountPreferences.hydrateForUser("user-A");
    await accountPreferences.update({ lang: "pl" });

    await syncNow("test");

    expect(serverAccountPreferences.lang).toBe("pl");
    expect(called("/api/preferences/account")).toBe(true);
    expect(accountPreferences.getCacheForTests()?.dirty).toEqual({});
  });

  it("server replace outside a cycle is guarded too", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-B" } };

    await expect(pushLocalToServer()).rejects.toThrow(); // aborted, not applied to B's budget
    expect(called("/api/sync/replace")).toBe(false);
    expect(store.getBootStatus()).toBe("foreign");
    expect(await idbGet("meta", "ledger")).toBeDefined(); // …and A's data is still here
  });
});

/* ── The session can change UNDER a running tab (shared cookie) ────────── */

describe("sync cycle: the session is re-verified every cycle", () => {
  it("sign-in as another user in ANOTHER tab → the long-lived tab pushes nothing", async () => {
    // The other tab reloads only ITSELF; this one keeps its replica, its outbox and (until
    // this fix) its once-per-page-load verdict, while the shared cookie now belongs to B.
    // No 401 ever happens — the new cookie is perfectly valid.
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    await syncNow("boot"); // verified as A

    outbox.add(catOp()); // A's op, queued while the tab was idle
    session = { user: { id: "user-B" } }; // B signed in elsewhere; same cookie jar

    await syncNow("interval");

    expect(called("/api/sync/push")).toBe(false); // A's op does NOT land in B's budget
    expect(store.getBootStatus()).toBe("foreign"); // …and A's data is blocked, not destroyed
    expect(reloads).toBe(0);
  });

  it("a 401 forgets the verdict — the next (different) session cannot inherit it", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    outbox.add(catOp());
    await syncNow("boot"); // A's op goes out under A's session
    expect(pushed().length).toBe(1);

    outbox.add(catOp()); // a new op waits
    session = null; // A's cookie expired
    await syncNow("interval");
    expect(store.getBootStatus()).toBe("unauthed"); // → Login screen

    session = { user: { id: "user-B" } }; // …and B signs in on this device
    await syncNow("interval");

    expect(pushed().length).toBe(1); // still only A's push under A's session
    expect(store.getBootStatus()).toBe("foreign"); // A's replica blocked before B's budget is touched
    expect(outbox.size()).toBe(1); // A's queued op is preserved, not thrown away
  });
});

/* ── Replicas with NO owner stamp (upgrades from a pre-guard version) ──── */

describe("sync cycle: replica with no owner stamp", () => {
  it("the session's budget IS the replica's → adopted and pushed", async () => {
    outbox.add(catOp());
    session = { user: { id: "user-C" } };
    serverBudget = BUDGET_A; // the session owns the very budget this replica mirrors

    await syncNow("test");

    expect(called("/api/sync/push")).toBe(true);
    await persist.flushed();
    expect(await idbGet<string>("meta", "userId")).toBe("user-C");
  });

  it("a pending REPLACE with an EMPTY outbox never overwrites the session's budget", async () => {
    // importBackup() sets the durable replace obligation and CLEARS the outbox, so an
    // outbox-triggered probe misses this path entirely: the imported ledger would be pushed
    // with /sync/replace, destroying the signed-in user's budget.
    markReplacePending(); // the replica is canonical and owes the server a full replace
    session = { user: { id: "user-B" } };
    serverBudget = BUDGET_B; // …but the session's budget is a DIFFERENT one

    await syncNow("test");

    expect(outbox.size()).toBe(0); // the state this test is about
    expect(called("/api/sync/replace")).toBe(false); // B's budget is NOT overwritten
  });

  it("pushLocalToServer (backup import) proves ownership as well", async () => {
    session = { user: { id: "user-B" } };
    serverBudget = BUDGET_B;

    await expect(pushLocalToServer()).rejects.toThrow();
    expect(called("/api/sync/replace")).toBe(false);
  });

  it("assertOwnReplica guards the writes made outside sync.ts (E2EE enable/disable)", async () => {
    // Settings → enable/disable E2EE upload the WHOLE replica to /api/e2ee/* and rebuild the
    // session budget from it: the same overwrite class as /sync/replace, but issued straight
    // from the UI. The stamp says user A, the cookie now says user B (a sign-in in another tab).
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-B" } };

    await expect(assertOwnReplica()).rejects.toThrow(); // the UI never reaches api.e2eeEnable/Disable
    expect(store.getBootStatus()).toBe("foreign"); // provably foreign (stamp) → blocked, not wiped
    expect(reloads).toBe(0);
  });
});

/* ── An UNBOUND replica (no budgetId) may only be adopted where it can destroy nothing ──
 *
 * "No budgetId" points at no account — neither this one nor another. Adopting it authorizes
 * /sync/replace, which WIPES the session user's budget and re-inserts this replica; such a
 * replica is reachable after local data is cleared and an offline start fills it again, so the
 * proof must be about what a wrong answer would
 * COST: an empty session budget has nothing to lose, one that holds data has everything. */

describe("sync: an UNBOUND replica (no budgetId)", () => {
  it("is refused against a session budget that HOLDS DATA (no cross-tenant overwrite)", async () => {
    // The chain: A's device clears its mirror, owner stamp and budgetId, then creates data offline
    // again → an unbound, unstamped, NON-empty replica. A's session lapses and B signs in.
    store.replace(nonEmptyLedger(), 0, ""); // data bound to no budget, stamped by nobody
    await persist.persistLedger(store.snapshotForPersist());
    session = { user: { id: "user-B" } };
    serverHasData = true; // …and B's budget is NOT empty

    await expect(pushLocalToServer()).rejects.toThrow(); // unprovable → refused

    expect(called("/api/sync/replace")).toBe(false); // B's budget is NOT wiped and overwritten
    expect(reloads).toBe(0); // …and nothing local is destroyed either
    await persist.flushed();
    expect(await idbGet("meta", "userId")).toBeUndefined(); // NOT adopted on a guess
    expect(await idbGet("meta", "ledger")).toBeDefined(); // …and the data is still here
  });

  it("is adopted when the session's budget is provably EMPTY (nothing to destroy)", async () => {
    store.replace(nonEmptyLedger(), 0, ""); // the same replica…
    session = { user: { id: "user-B" } };
    serverHasData = false; // …but now B's budget is empty (fresh account / onboarding)

    await pushLocalToServer();

    expect(wrote(BUDGET_A)).toEqual(["replace"]); // the offline data lands in the empty budget
    await persist.flushed();
    expect(await idbGet<string>("meta", "userId")).toBe("user-B");
  });
});

/* ── An UNPROVEN replica is not a foreign one: refuse writes, destroy NOTHING ──
 *
 * budgetId is the replica EPOCH marker, not a tenant id: /api/sync/pull LAZILY CREATES an
 * empty budget for a user who has none, and a reseed/DB restore rotates the id. So "the
 * session's budget id ≠ mine" is precisely what the 2.0 upgrade looks like on a pre-guard
 * device — wiping there would silently destroy the ledger AND every queued op.
 *
 * The state it lands in is its OWN (SyncState "unverified"), not "error": nothing is broken, the
 * server is reachable, and the situation can last as long as the upgrade does. It is what the badge
 * and Settings → Sync read to tell the user the truth (nothing is being sent) and to offer the ways
 * out — check again / export a backup / discard the copy. Reusing "error" made the badge fall
 * through to the reassuring "⇄ N" pill ("changes are waiting to be sent"), which was a lie. */

describe("sync: an unproven replica is refused, never wiped", () => {
  it("2.0 upgrade path: the owner's budget is lazily created (new id) → no write, no data loss", async () => {
    outbox.add(catOp()); // ops queued before the upgrade
    session = { user: { id: "user-owner" } }; // freshly registered owner…
    serverBudget = BUDGET_B; // …whose budget was lazily created empty (the old one is not attached yet)

    await syncNow("test");

    expect(called("/api/sync/push")).toBe(false); // nothing written into the new empty budget
    expect(getSyncStatus().state).toBe("unverified"); // …and the UI can SAY so (not a red "error")
    expect(reloads).toBe(0); // NOT wiped — the mismatch proves nothing about the account
    expect(outbox.size()).toBe(1); // the queued op survives (a later cycle re-proves)
    expect(store.getBootStatus()).toBe("ready"); // the app keeps working — it just cannot send
    await persist.flushed();
    expect(await idbGet("meta", "ledger")).toBeDefined(); // the replica is still there
    expect(await idbGet("meta", "userId")).toBeUndefined(); // …and NOT adopted on a guess
  });

  it("the same replica is pushed once the owner's budget is reattached — and the state clears", async () => {
    outbox.add(catOp());
    session = { user: { id: "user-owner" } };
    serverBudget = BUDGET_B;
    await syncNow("test"); // unproven → refused (above)
    expect(getSyncStatus().state).toBe("unverified");

    serverBudget = BUDGET_A; // operator reattaches the pre-2.0 budget to the owner account
    await syncNow("test");

    expect(called("/api/sync/push")).toBe(true); // the preserved op finally goes out
    expect(getSyncStatus().state).toBe("synced"); // …and the badge goes quiet again
    await persist.flushed();
    expect(await idbGet<string>("meta", "userId")).toBe("user-owner");
  });

  it("“Check again” re-runs the proof: still unproven ⇒ still no write, nothing destroyed", async () => {
    outbox.add(catOp());
    session = { user: { id: "user-owner" } };
    serverBudget = BUDGET_B;
    await syncNow("test");

    await recheckReplicaOwner(); // Settings → Sync → [Check again], while the budget is not reattached

    expect(called("/api/sync/push")).toBe(false); // the button cannot write either
    expect(getSyncStatus().state).toBe("unverified"); // …and it says the same thing again
    expect(outbox.size()).toBe(1);
    expect(reloads).toBe(0);
    await persist.flushed();
    expect(await idbGet("meta", "userId")).toBeUndefined();
  });

  it("“Check again” adopts the replica the moment the proof succeeds", async () => {
    outbox.add(catOp());
    session = { user: { id: "user-owner" } };
    serverBudget = BUDGET_B;
    await syncNow("test");
    expect(getSyncStatus().state).toBe("unverified");

    serverBudget = BUDGET_A; // the operator has just reattached the budget…
    await recheckReplicaOwner(); // …and the human taps "Check again" instead of waiting

    expect(wrote(BUDGET_A)).toHaveLength(1); // the held-up op goes out
    expect(getSyncStatus().state).toBe("synced");
    await persist.flushed();
    expect(await idbGet<string>("meta", "userId")).toBe("user-owner");
  });

  it("the human may discard the unproven copy — and only the human", async () => {
    outbox.add(catOp());
    session = { user: { id: "user-owner" } };
    serverBudget = BUDGET_B;
    await syncNow("test");
    await persist.flushed();
    expect(await idbGet("meta", "ledger")).toBeDefined(); // the engine kept it (it may be the last copy)

    await discardLocalReplica(); // Settings → Sync → [Remove this data and continue]

    expect(reloads).toBe(1); // …now, and only now, boot bootstraps the account's own budget
    expect(await idbGet("meta", "ledger")).toBeUndefined();
    expect(outbox.size()).toBe(0);
  });

  it("an unproven replica is refused by the out-of-cycle writers too, with no wipe", async () => {
    session = { user: { id: "user-owner" } };
    serverBudget = BUDGET_B;

    await expect(pushLocalToServer()).rejects.toThrow();
    await expect(assertOwnReplica()).rejects.toThrow();
    expect(called("/api/sync/replace")).toBe(false);
    expect(getSyncStatus().state).toBe("unverified");
    expect(reloads).toBe(0);
    expect(await idbGet("meta", "ledger")).toBeDefined();
  });
});

/* ── "The owner is unproven" is a STICKY FACT, not a momentary state ─────
 *
 * SyncState is transient: EVERY re-proof is an ordinary cycle, and doCycle flips the state to
 * "syncing" BEFORE ensureIdentity runs — so it dips out of "unverified" and back on every trigger
 * (the 60 s interval, focus/visibility, a local edit's poke and, absurdly, the human's own "Check
 * again"). A UI keyed on the state would therefore, for the whole duration of each network proof:
 * tear down the notice that is the ONE place this state is explained (with its "Checking…" label
 * and any open discard confirmation), swap in "Sync now" / "Download everything anew" and — with
 * anything queued — the "N changes waiting to be sent" pill, i.e. exactly the reassuring lie this
 * state exists to remove. Hence SyncStatus.ownerUnproven: true until the proof succeeds. */

describe("sync status: ownerUnproven is sticky across the re-proof", () => {
  const record = (): { seen: { state: string; unproven: boolean }[]; stop: () => void } => {
    const seen: { state: string; unproven: boolean }[] = [];
    const stop = subscribeSyncStatus(() => {
      const s = getSyncStatus();
      seen.push({ state: s.state, unproven: s.ownerUnproven });
    });
    return { seen, stop };
  };

  it("stays true through the 'syncing' of a cycle that re-proves and fails again", async () => {
    outbox.add(catOp()); // …and a queued op, which is when the flicker turned into a LIE
    session = { user: { id: "user-owner" } };
    serverBudget = BUDGET_B;
    await syncNow("test");
    expect(getSyncStatus().ownerUnproven).toBe(true);

    const { seen, stop } = record();
    await syncNow("test"); // the 60 s interval / focus / poke — or "Check again" (recheckReplicaOwner)
    await recheckReplicaOwner();
    stop();

    expect(seen.some((s) => s.state === "syncing")).toBe(true); // the state DOES dip (as designed)
    expect(seen.every((s) => s.unproven)).toBe(true); // …the fact the UI reads does NOT
    expect(getSyncStatus().state).toBe("unverified");
    expect(getSyncStatus().ownerUnproven).toBe(true);
  });

  it("clears the moment the proof succeeds", async () => {
    session = { user: { id: "user-owner" } };
    serverBudget = BUDGET_B;
    await syncNow("test");
    expect(getSyncStatus().ownerUnproven).toBe(true);

    serverBudget = BUDGET_A; // the operator reattached the budget
    await recheckReplicaOwner();

    expect(getSyncStatus().ownerUnproven).toBe(false); // badge quiet, notice gone, actions back
    expect(getSyncStatus().state).toBe("synced");
  });

  it("clears on sign-out — the Login screen owns the story from there", async () => {
    session = { user: { id: "user-owner" } };
    serverBudget = BUDGET_B;
    await syncNow("test");
    expect(getSyncStatus().ownerUnproven).toBe(true);

    enterLoginKeepingReplica(); // the replica stays; the next session proves it from scratch

    expect(getSyncStatus().ownerUnproven).toBe(false);
    expect(getSyncStatus().state).toBe("unauthed");
  });
});

/* ── The session can also change BETWEEN two batches of ONE push loop ────
 *
 * The identity guard runs once per CYCLE, but a cycle makes N server writes, and POST
 * /sync/push carries only { clientId, ops } — the server resolves the target budget from the
 * session cookie alone. So every push NAMES the budget it is for, and the server refuses a
 * mismatch (409 budget_mismatch) BEFORE writing anything. The client then re-proves its
 * identity instead of resyncing blindly: a fullResync would bootstrap the OTHER user's budget
 * and replay this replica's outbox onto it. */

describe("sync push: the per-request tenant assertion", () => {
  it("the cookie is swapped BETWEEN batches → the rest of the outbox never lands in B's budget", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    for (let i = 0; i < 150; i++) outbox.add(catOp()); // two batches (PUSH_BATCH = 100)
    // …during the FIRST batch the user signs out and signs in as B in another tab: the shared
    // cookie now belongs to B, and the server resolves B's budget for every further request.
    onPush = () => {
      session = { user: { id: "user-B" } };
      serverBudget = BUDGET_B;
      onPush = null;
    };

    await syncNow("test");

    expect(pushed().length).toBe(2); // batch 1 (still A's budget) + batch 2, which is REFUSED
    expect(wrote(BUDGET_A)).toHaveLength(100); // A's own ops, into A's own budget
    expect(wrote(BUDGET_B)).toEqual([]); // …and NOTHING of A's into B's budget
    expect(store.getBootStatus()).toBe("foreign"); // the re-proof finds another account's stamp
    expect(reloads).toBe(0); // …which blocks every further write and destroys nothing
  });

  it("same user, budget rotated (reseed / restore / reattach) → resync, then the ops go out", async () => {
    // The very same 409, from the legitimate cause: it must NOT become a permanent refusal.
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    serverBudget = BUDGET_B; // the user's budget id changed under the replica…
    store.replace(emptyLedger(), 0, BUDGET_A); // …which still names the old one
    outbox.add(catOp());

    await syncNow("test");

    expect(wrote(BUDGET_B)).toHaveLength(1); // re-bootstrapped from the new budget, then pushed
    expect(store.getBudgetId()).toBe(BUDGET_B);
    expect(outbox.size()).toBe(0);
    expect(reloads).toBe(0); // same account — nothing was destroyed
  });
});

/* ── The PULL side of the same swap: a resync REPLACES the mirror ─────────
 *
 * The push loop's per-request assertion is skipped ENTIRELY when the outbox is empty — the steady
 * state of a synced device. Then the first thing a cycle asks the server is the pull, and a pull
 * answered for another budget sets the durable resync obligation. Its consumer bootstraps a fresh
 * snapshot of the budget the SESSION owns and REPLACES the local mirror with it (mirror + IDB),
 * then replays this replica's outbox on top. Under a cookie swapped in another tab that destroys
 * A's replica and hands B's ledger to A's device — so the consumer re-proves the session first
 * (resyncVerified), exactly as handleBudgetMismatch does on the push side. */

describe("sync pull: a resync never replaces the mirror on an unverified session", () => {
  it("the cookie is swapped mid-cycle (EMPTY outbox) → A's replica is NOT overwritten by B's", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    expect(outbox.size()).toBe(0); // the steady state this test is about: nothing to push
    // …between ensureIdentity() and the pull, the shared cookie becomes B's (sign-out + sign-in
    // in another tab). The pull is answered for B's budget — a valid session, so no 401 either.
    onPull = () => {
      session = { user: { id: "user-B" } };
      serverBudget = BUDGET_B;
      onPull = null;
    };

    await syncNow("interval");

    expect(called("/api/sync/snapshot")).toBe(false); // B's ledger is never even fetched…
    expect(store.getBudgetId()).toBe(BUDGET_A); // …so A's mirror still is A's
    expect(store.getBootStatus()).toBe("foreign"); // the re-proof finds another account's stamp
    expect(reloads).toBe(0); // nothing destroyed unattended — the human decides
    await persist.flushed();
    expect(await idbGet<string>("meta", "budgetId")).toBe(BUDGET_A); // …and the DURABLE replica is A's
    expect(await idbGet<string>("meta", "userId")).toBe("user-A");
  });

  it("same user, budget rotated (reseed / restore) → the pull-side resync still runs", async () => {
    // The very same signal from the legitimate cause: it must NOT become a permanent refusal.
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    serverBudget = BUDGET_B; // the user's own budget id changed under the replica (new data epoch)

    await syncNow("interval");

    expect(called("/api/sync/snapshot")).toBe(true); // fresh snapshot of the SAME user's budget
    expect(store.getBudgetId()).toBe(BUDGET_B);
    expect(store.getBootStatus()).toBe("ready");
    expect(reloads).toBe(0);
  });
});

/* ── BOOT is the READ side: the app must not render a foreign replica ─────
 *
 * boot() hydrates from IDB and sets BootStatus "ready" BEFORE the first cycle runs, so the guard
 * that protects writes cannot protect the screen. The ways a device changes hands are routine (a
 * 90-day cookie expires → Login; sign-out keeps the replica → Login; the next account signs in). */

describe("sync boot: the replica's owner is checked BEFORE it is rendered", () => {
  it("another account signed in → ForeignReplicaScreen, not the previous owner's budget", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-B" } };

    await retryBoot();

    expect(store.getBootStatus()).toBe("foreign"); // App never renders A's ledger to B
    expect(called("/api/sync/snapshot")).toBe(false); // …and B's data is not bootstrapped over it
    expect(reloads).toBe(0);
    expect(await idbGet("meta", "ledger")).toBeDefined(); // A's replica (maybe its last copy) stays
  });

  it("the session expired → Login BEFORE the data is on screen (replica + outbox preserved)", async () => {
    await idbPut("meta", "user-A", "userId");
    outbox.add(catOp());
    session = null; // a routine 90-day expiry

    await retryBoot();

    expect(store.getBootStatus()).toBe("unauthed"); // LoginScreen
    expect(outbox.size()).toBe(1); // signing back in resumes the push
    expect(await idbGet("meta", "ledger")).toBeDefined();
  });

  it("the same account → the replica boots normally (the check is not a new refusal)", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };

    await retryBoot();

    expect(store.getBootStatus()).toBe("ready");
  });

  it("no owner stamp (a fresh install / pre-guard replica) → boot is untouched", async () => {
    session = { user: { id: "user-A" } };

    await retryBoot();

    expect(store.getBootStatus()).toBe("ready");
    expect(called("/api/auth/get-session")).toBe(true); // (only from the cycle — nothing to compare)
  });

  it("OFFLINE: the owner cannot be verified → local-first wins, the replica is shown", async () => {
    // Being offline is not being somebody else. A boot that refuses to show the replica would be
    // its own kind of data loss (it can be the last copy) — the first cycle that REACHES the
    // server enforces the verdict instead.
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    offline = true; // get-session THROWS (network), it does not answer "no session"

    await retryBoot();
    await syncNow("drain"); // join the cycle boot fired, so its backoff timer is deterministic

    expect(store.getBootStatus()).toBe("ready");
  });
});

/* ── Legacy `planned` rows are swept client-side (the e2ee gap in migration 0018) ──
 *
 * Migration 0018 deletes `planned = true` transactions server-side before dropping the column.
 * On a PLAIN-tier budget that DELETE is real and replicates via the `changes` journal. On an
 * E2EE-tier budget the server only ever held ciphertext, so that DELETE was a no-op there — a
 * replica that already had `planned` rows would keep them, and since the `planned` filter is
 * gone from every computation, they'd start counting as real money. sweepLegacyPlanned() (called
 * from every boot exit path, right after the outbox replay and before "ready") closes that gap
 * client-side, via the normal local.deleteTxn → applyOp+outbox path. */

const PLANNED_TXN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

describe("sync boot: a leftover `planned` transaction is swept before the replica reaches the UI", () => {
  it("a pre-3.2 planned=true row (raw JSON, past the current Transaction type) is deleted, and the delete goes out through the normal push", async () => {
    const legacyPlannedTxn = {
      id: PLANNED_TXN_ID,
      type: "expense",
      accountId: "acc-1",
      toAccountId: null,
      amount: 500,
      date: "2026-01-01",
      isRefund: false,
      envelopeId: null,
      placeId: null,
      categoryId: null,
      name: null,
      note: null,
      tag: null,
      items: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      planned: true, // legacy field — no longer declared on Transaction (see legacyPlanned.ts)
    };
    const ledgerWithLegacyPlanned = {
      ...emptyLedger(),
      transactions: [legacyPlannedTxn],
    } as unknown as ClientLedger;
    store.replace(ledgerWithLegacyPlanned, 0, BUDGET_A);
    void persist.persistLedger(store.snapshotForPersist());
    await persist.flushed();
    session = { user: { id: "user-A" } };

    await retryBoot();
    await syncNow("drain"); // join the boot-triggered cycle so the resulting push is observable

    expect(store.getBootStatus()).toBe("ready");
    expect(store.getLedger()!.transactions).toHaveLength(0); // swept before boot handed off
    expect(outbox.size()).toBe(0); // the delete op was pushed and applied — nothing left dangling
    expect(pushed().length).toBeGreaterThan(0); // it left through the real push path, not just memory
    expect(wrote(BUDGET_A)).toHaveLength(1); // exactly one op reached the server: our delete
  });

  it("a clean ledger (no legacy planned rows) boots without pushing anything extra", async () => {
    session = { user: { id: "user-A" } };

    await retryBoot();

    expect(store.getBootStatus()).toBe("ready");
    expect(outbox.size()).toBe(0); // nothing to sweep, nothing queued
  });
});

/* ── The e2ee CHECKPOINT upload is a full-budget write too ────────────────
 *
 * POST /sync2/snapshot UPSERTs the resolved budget's only checkpoint (blob AND uptoSeq) and the
 * client fires it FIRE-AND-FORGET from the pull, i.e. at the very end of a cycle — the widest
 * window there is for a cookie swapped in another tab. `epoch` cannot catch it: two
 * independently-encrypted budgets both sit at epoch 1. Dropping A's ciphertext into B's
 * checkpoint destroys B's new-device bootstrap (their DEK cannot decrypt it) and skips journal
 * rows (stale uptoSeq). So the upload names the tenant the cycle verified. */

describe("sync e2ee: the checkpoint upload carries the verified owner", () => {
  const e2eeReplicaDue = () => {
    e2ee.setTierMeta({ tier: "e2ee", epoch: 1 });
    e2ee.setDek(generateDek(), 1); // validated for the epoch the fixture runs at
    e2ee.noteOpsSeen(e2ee.SNAPSHOT_EVERY_OPS); // the checkpoint threshold is due
    serverE2eeCursor = 5; // the journal moved past the client's cursor → the pull body is non-trivial
  };
  /** The upload is fire-and-forget BY DESIGN (it must not block the cycle) — let it land. */
  const uploaded = async () => {
    for (let i = 0; i < 100 && snapshotUploads.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  it("a stable session: the checkpoint lands in the session's own budget", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    e2eeReplicaDue();

    await syncNow("interval");
    await uploaded();

    expect(snapshotUploads).toHaveLength(1);
    expect(snapshotUploads[0]?.userId).toBe("user-A"); // the tenant the cycle verified travels along
    expect(wrote(BUDGET_A)).toEqual(["snapshot"]);
  });

  it("the cookie is swapped mid-cycle → B's checkpoint is NOT overwritten with A's ciphertext", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    e2eeReplicaDue();
    onPull = () => {
      session = { user: { id: "user-B" } }; // a sign-in in another tab, mid-cycle
      serverBudget = BUDGET_B;
      onPull = null;
    };

    await syncNow("interval");
    await uploaded();

    expect(snapshotUploads[0]?.userId).toBe("user-A"); // …still names the session A verified
    expect(wrote(BUDGET_B)).toEqual([]); // the server refuses it: B's blob + uptoSeq survive
  });
});

/* ── v2 context discipline on the wire (backlog §2, test group 3) ─────────
 *
 * Push must encrypt under the replica's OWN (budgetId, epoch); pull must decrypt with the
 * locally EXPECTED context, so a substituted/foreign/re-labelled journal row fails BEFORE the
 * mirror is touched or the cursor advances; the periodic checkpoint authenticates the cursor
 * it claims; and the 409 e2ee_upgrade_required of a legacy budget stops the cycle without
 * consuming the outbox or the replica. */

describe("sync e2ee v2: encryption context discipline", () => {
  const BUDGET_V2 = "aaaaaaaa-0000-4000-8000-0000000000aa";
  const dek = generateDek();
  const v2Replica = async (epoch = 1) => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    serverBudget = BUDGET_V2;
    store.replace(emptyLedger(), 0, BUDGET_V2);
    e2ee.setTierMeta({ tier: "e2ee", epoch });
    e2ee.setDek(dek, 1); // validated for the fixture's epoch
  };

  it("push encrypts under the replica's exact (budgetId, epoch) and NAMES the budget", async () => {
    await v2Replica();
    const op = catOp();
    outbox.add(op);

    await syncNow("test");

    expect(pushedCipherOps).toHaveLength(1);
    const row = pushedCipherOps[0]!;
    expect(row.opId).toBe(op.opId);
    // decrypts ONLY under the local context the cycle was supposed to use…
    const pt = await decryptPayload(row.ciphertext, dek, opAadContext(BUDGET_V2, 1, op.opId));
    expect(JSON.parse(pt).kind).toBe("category.create");
    // …and under any other epoch/budget/opId it fails (the vectors in crypto.test.ts)
    await expect(decryptPayload(row.ciphertext, dek, opAadContext(BUDGET_V2, 2, op.opId))).rejects.toThrow();
    expect(outbox.size()).toBe(0); // acked
  });

  it("pull: a substituted ciphertext (valid rows, swapped outer opIds) applies NOTHING and keeps the cursor", async () => {
    await v2Replica();
    const opA = catOp();
    const opB = catOp();
    const ctx = { budgetId: BUDGET_V2, epoch: 1 };
    const rowA = await e2ee.encryptOp(opA, dek, ctx);
    const rowB = await e2ee.encryptOp(opB, dek, ctx);
    // the storage server re-pairs B's valid ciphertext with A's clear opId (and vice versa)
    serverPullOps = [
      { seq: 1, opId: rowA.opId, ciphertext: rowB.ciphertext },
      { seq: 2, opId: rowB.opId, ciphertext: rowA.ciphertext },
    ];

    await syncNow("test");

    expect(store.getLedger()!.categories).toEqual([]); // neither op reached the mirror
    expect(store.getCursor()).toBe(0); // the cursor did not advance past unauthenticated rows
    expect(getSyncStatus().state).toBe("error"); // the cycle failed loudly, not silently
  });

  it("pull: rows from another epoch (response-epoch drift) fail before the mirror is touched", async () => {
    await v2Replica(1);
    const op = catOp();
    // the server serves a journal row belonging to another generation of the same budget
    const stale = await e2ee.encryptOp(op, dek, { budgetId: BUDGET_V2, epoch: 2 });
    serverPullOps = [{ seq: 1, opId: stale.opId, ciphertext: stale.ciphertext }];

    await syncNow("test");

    expect(store.getLedger()!.categories).toEqual([]);
    expect(store.getCursor()).toBe(0);
  });

  it("the periodic checkpoint is bound to the cursor it claims (uptoSeq inside the AAD)", async () => {
    await v2Replica();
    const op = catOp();
    const row = await e2ee.encryptOp(op, dek, { budgetId: BUDGET_V2, epoch: 1 });
    serverPullOps = [{ seq: 7, opId: row.opId, ciphertext: row.ciphertext }];
    e2ee.noteOpsSeen(e2ee.SNAPSHOT_EVERY_OPS); // the checkpoint threshold is due

    await syncNow("test");
    for (let i = 0; i < 100 && snapshotUploads.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(snapshotUploads).toHaveLength(1);
    const up = snapshotUploads[0]!;
    expect(up.uptoSeq).toBe(7); // the cursor after the applied row
    // the blob authenticates exactly that position — a replay at another uptoSeq fails
    await expect(e2ee.decryptSnapshot(up.blob!, dek, { budgetId: BUDGET_V2, epoch: 1, uptoSeq: 7 })).resolves.toBeDefined();
    await expect(e2ee.decryptSnapshot(up.blob!, dek, { budgetId: BUDGET_V2, epoch: 1, uptoSeq: 0 })).rejects.toThrow();
  });

  it("409 e2ee_upgrade_required: the cycle stops; outbox, replica and cursor are preserved", async () => {
    await v2Replica();
    store.applyLocal(catOp()); // some local state that must survive
    const queued = catOp();
    outbox.add(queued);
    serverUpgradeRequired = true;

    await syncNow("test");

    expect(outbox.size()).toBe(1); // nothing consumed
    expect(store.getLedger()!.categories).toHaveLength(1); // mirror untouched
    expect(store.getCursor()).toBe(0);
    expect(wrote(BUDGET_V2)).toEqual([]); // the server refused before any write
    expect(e2ee.getCipherVersion()).toBe(1); // the legacy format is recorded (Settings shows the action)
    expect(getSyncStatus().state).toBe("error");
  });
});

/* ── The DEK lifecycle across an epoch change (review F1/F2/F3/F5) ──────────
 *
 * One design, not three patches: adopting a NEW epoch (any 409 body) invalidates trust in the
 * held DEK until an authenticated use under the new generation re-validates it; validation
 * failure drops the key and lands on Unlock; NO op is ever encrypted with an unvalidated key;
 * and the upgrade ceremony persists its materials so a retry is byte-identical. */

describe("sync e2ee v2: DEK lifecycle across an epoch change", () => {
  const BUDGET_V2 = "aaaaaaaa-0000-4000-8000-0000000000aa";
  const oldDek = generateDek();
  const stampedReplica = async (epoch: number) => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    serverBudget = BUDGET_V2;
    store.replace({ ...emptyLedger(), categories: [{ id: crypto.randomUUID(), name: "pre-existing" }] }, 3, BUDGET_V2);
    e2ee.setTierMeta({ tier: "e2ee", epoch });
    e2ee.setDek(oldDek, epoch); // validated for the CURRENT generation
  };

  it("F1/F3: a key rotation on another device ends on Unlock — never a poisoned push or an error loop", async () => {
    await stampedReplica(1);
    const queued = catOp();
    outbox.add(queued);
    // ANOTHER device ran the upgrade: epoch 2, new DEK, new checkpoint
    const newDek = generateDek();
    serverEpoch = 2;
    serverBlob = await e2ee.encryptSnapshot(emptyLedger(), newDek, { budgetId: BUDGET_V2, epoch: 2, uptoSeq: 0 });

    await syncNow("test");

    // the push met the epoch 409 BEFORE anything was stored; bootstrap then found a checkpoint
    // the held key cannot open → trust is over: key dropped, Unlock takes the screen
    expect(pushedCipherOps).toEqual([]); // nothing under the dead key ever reached the journal
    expect(wrote(BUDGET_V2)).toEqual([]);
    expect(store.getBootStatus()).toBe("locked"); // the Unlock screen — not a silent error loop
    expect(e2ee.getDek()).toBeNull(); // the dead key is gone (memory AND IDB)
    expect(outbox.size()).toBe(1); // the queued edit survives — it pushes under the NEW key
    expect(store.getLedger()!.categories.map((c) => c.name)).toEqual(["pre-existing"]); // mirror untouched
  });

  it("F1 precondition: an ADOPTED epoch alone never pushes — the unvalidated key locks the engine", async () => {
    await stampedReplica(1);
    outbox.add(catOp());
    // a 409 body was adopted somewhere (tierMeta moved), but NOTHING re-validated the key
    e2ee.setTierMeta({ tier: "e2ee", epoch: 2 });
    serverEpoch = 2;

    await syncNow("test");

    expect(called("/api/sync2/push")).toBe(false); // the hard precondition: no encrypt, no network
    expect(store.getBootStatus()).toBe("locked");
    expect(outbox.size()).toBe(1);
  });

  it("F2: a ceremony retry re-sends the byte-identical body — the interrupted attempt's materials win", async () => {
    await stampedReplica(1);
    e2ee.setCipherVersion(1); // a legacy budget awaiting the ceremony
    upgradeNetworkFail = true;

    await expect(upgradeServerE2eeV2("ceremony-pass-123")).rejects.toThrow();
    expect(await hasPendingE2eeUpgrade()).toBe(true); // the intent survived the network failure
    expect(upgradeCalls).toHaveLength(1);

    // adoptions in between (409 bodies from other channels) must not clobber the intent
    e2ee.setTierMeta({ tier: "e2ee", epoch: 7 });

    upgradeNetworkFail = false;
    await upgradeServerE2eeV2(null); // RESUME — no new password, no new materials

    expect(upgradeCalls).toHaveLength(2);
    expect(upgradeCalls[1]).toBe(upgradeCalls[0]); // byte-identical: the server's idempotency branch is reachable
    expect(await hasPendingE2eeUpgrade()).toBe(false); // fulfilled
    expect(e2ee.getTierMeta()).toEqual({ tier: "e2ee", epoch: 2 }); // expectedEpoch(1)+1 — from the RECORD
    expect(e2ee.isDekValidForEpoch(2)).toBe(true); // the SAME DEK, validated for the new generation
    expect(e2ee.getCipherVersion()).toBe(2);
  });

  it("F2: a stale-epoch refusal drops the intent (it can never commit) — a fresh attempt may start over", async () => {
    await stampedReplica(1);
    e2ee.setCipherVersion(1);
    upgradeNetworkFail = true;
    await expect(upgradeServerE2eeV2("ceremony-pass-123")).rejects.toThrow();
    upgradeNetworkFail = false;
    serverEpoch = 5; // ANOTHER device changed the generation meanwhile

    await expect(upgradeServerE2eeV2(null)).rejects.toThrow("tier_mismatch");

    expect(await hasPendingE2eeUpgrade()).toBe(false); // authoritatively dead — dropped
    // R2: the authoritative refusal also re-taught this device the server's CURRENT format —
    // the durable "format 1" meta must not pin the Unlock screen to the upgrade state forever.
    expect(e2ee.getCipherVersion()).toBe(2);
  });

  it("R1: a replace obligation NEVER runs with an unvalidated key — locked, zero writes, obligation preserved", async () => {
    // The catastrophic interleaving: rotation elsewhere, epoch adopted (409 body), bootstrap
    // failed TRANSIENTLY (key not dropped) — and this device carries a durable replace
    // obligation. The obligation branch runs FIRST in the cycle and posts /sync2/reset, which
    // deletes the whole journal and swaps the only checkpoint: with the dead key that write
    // would destroy the server copy beyond recovery. The validated-key precondition must gate
    // it BEFORE any obligation processing.
    await stampedReplica(1);
    markReplacePending(); // e.g. a JSON backup import awaiting its server replace
    e2ee.setTierMeta({ tier: "e2ee", epoch: 2 }); // adopted from a 409 — key NOT re-validated
    serverEpoch = 2;

    await syncNow("test");

    expect(overwriteOwners).toEqual([]); // /sync2/reset was never posted
    expect(wrote(BUDGET_V2)).toEqual([]); // nothing reached the server at all
    expect(store.getBootStatus()).toBe("locked"); // waiting for Unlock, not silently erroring

    // …and the obligation SURVIVES: after re-validation (Unlock) the very next cycle consumes it
    const newDek = generateDek();
    e2ee.setDek(newDek, 2); // Unlock installed + validated the new generation's key
    store.setBootStatus("ready");
    await syncNow("test");
    expect(overwriteOwners).toEqual(["user-A"]); // the reset ran — WITH the validated key
    expect(wrote(BUDGET_V2)).toContain("reset");
  });

  it("R1: resetServerE2ee refuses an unvalidated key even when passed EXPLICITLY", async () => {
    await stampedReplica(1);
    e2ee.setTierMeta({ tier: "e2ee", epoch: 2 }); // adopted; the held key is validated for 1 only
    serverEpoch = 2;

    await expect(resetServerE2ee(e2ee.getDek()!)).rejects.toThrow("no_encryption_key");

    expect(overwriteOwners).toEqual([]); // nothing was posted
  });

  it("F5: an edit made in another tab DURING the ceremony survives commit and pushes under the new epoch", async () => {
    await stampedReplica(1);
    e2ee.setCipherVersion(1);
    const before = catOp();
    store.applyLocal(before);
    outbox.add(before); // captured by the ceremony's snapshot
    const late = catOp();
    onUpgrade = () => {
      // a second tab commits an edit while the ceremony's request is in flight
      store.applyLocal(late);
      outbox.add(late);
      onUpgrade = null;
    };

    await upgradeServerE2eeV2("ceremony-pass-123");

    // commit acked EXACTLY the captured ops — the late edit is still queued and still visible
    expect(outbox.size()).toBe(1);
    expect(outbox.snapshot()[0]!.op.opId).toBe(late.opId);
    const names = store.getLedger()!.categories.map((c) => c.name);
    expect(names).toContain("Food"); // both catOps create "Food" — assert by id below
    expect(store.getLedger()!.categories).toHaveLength(3); // pre-existing + before + late (no wipe)

    await syncNow("test"); // the late op goes out under the NEW generation with the NEW key
    expect(outbox.size()).toBe(0);
    expect(wrote(BUDGET_V2)).toContain(late.opId);
    const pushed = pushedCipherOps.find((r) => r.opId === late.opId);
    expect(pushed).toBeDefined(); // encrypted at push time — after the DEK swap, valid for epoch 2
  });
});

/* ── A 401 outside a cycle must reach the Login screen too ─────────────── */

describe("sync: 401 on an out-of-cycle write routes to Login", () => {
  it("pushLocalToServer with no session → BootStatus unauthed (not a raw error string)", async () => {
    // An out-of-cycle full replacement must classify 401 exactly like the regular cycle so the
    // app reaches Login while retaining the local replica and queued work.
    session = null;
    await idbPut("meta", "user-A", "userId");

    await expect(pushLocalToServer()).rejects.toThrow();

    expect(called("/api/sync/replace")).toBe(false);
    expect(store.getBootStatus()).toBe("unauthed"); // App renders LoginScreen
    expect(await idbGet("meta", "ledger")).toBeDefined(); // the only copy is intact
  });

  it("assertOwnReplica (Settings → E2EE) with no session → BootStatus unauthed", async () => {
    session = null;
    await expect(assertOwnReplica()).rejects.toThrow();
    expect(store.getBootStatus()).toBe("unauthed");
  });
});

/* ── E2EE tier — the outbox is PLAINTEXT and survives tier flips ───────── */

describe("sync cycle: e2ee replica with no owner stamp", () => {
  it("an unproven e2ee budget is neither pushed to nor reset (and not wiped either)", async () => {
    e2ee.setTierMeta({ tier: "e2ee", epoch: 1 });
    e2ee.setDek(new Uint8Array(32), 1); // validated for the fixture's epoch
    outbox.add(catOp()); // queued ops (plaintext, waiting to be encrypted at push)
    markReplacePending(); // …and a pending full replace of the server
    session = { user: { id: "user-B" } };
    serverBudget = BUDGET_B; // a different e2ee budget — same epoch 1, so the server would accept

    await syncNow("test");

    expect(called("/api/sync2/push")).toBe(false); // no ciphertext of this replica into that journal
    expect(called("/api/sync2/reset")).toBe(false); // that journal + checkpoint NOT destroyed
    expect(reloads).toBe(0); // …and this device's ledger + ops are NOT destroyed on a guess
    expect(outbox.size()).toBe(1);
  });

  it("a tier mismatch during the proof does not become a flip + replay into the session's budget", async () => {
    // Local replica is e2ee (legacy sync2 bootstrap → no budgetId), the session's budget is
    // PLAIN. The 409 must not escape into handleTierFlip: that re-bootstraps from B's budget
    // and replays A's plaintext outbox onto it, which the next cycle would push.
    e2ee.setTierMeta({ tier: "e2ee", epoch: 1 });
    e2ee.setDek(new Uint8Array(32), 1); // validated for the fixture's epoch
    store.replace(emptyLedger(), 0, ""); // no budgetId to compare against
    outbox.add(catOp());
    session = { user: { id: "user-B" } };
    serverIsPlain = true;

    await syncNow("test");

    expect(called("/api/sync2/push")).toBe(false);
    expect(called("/api/sync/push")).toBe(false); // …not on the v1 path either
    expect(called("/api/sync/replace")).toBe(false);
    expect(outbox.size()).toBe(1); // nothing left the device, nothing was destroyed
    expect(reloads).toBe(0); // unverifiable ≠ proven foreign: we do NOT wipe on a guess
    await persist.flushed();
    expect(await idbGet("meta", "userId")).toBeUndefined(); // and it is NOT adopted
  });
});

/* ── The DEK proof, and what it may NOT be built from ─────────────────────
 *
 * For a LEGACY e2ee replica (bootstrapped over sync2 against a pre-2.0 server, so it carries no
 * budgetId at all) the only available proof is its DEK: the session's checkpoint is encrypted
 * with the budget's key, and AES-GCM authenticates it. That works ONLY for a key that arrived
 * WITH the replica. A key unwrapped from the SESSION's own key envelope (Unlock, E2EE password
 * change) opens the session's checkpoint BY CONSTRUCTION — and since setDek() persists it, the
 * proof would resurrect itself after one reload if the provenance were not persisted too. */

describe("sync: the e2ee ownership proof and the DEK's provenance", () => {
  /** A legacy e2ee replica: tier e2ee, no budgetId anywhere — not even in the ledger. */
  const legacyE2eeReplica = () => {
    e2ee.setTierMeta({ tier: "e2ee", epoch: 1 });
    store.replace(emptyLedger(), 0, "");
  };
  /** A fresh page load: the module forgets its key state and re-hydrates from IDB. */
  const reload = async () => {
    await persist.flushed();
    e2ee.__resetDekForTests();
    await e2ee.hydrate();
  };

  it("a DEK that came WITH the replica and opens the session's checkpoint → ours (adopted)", async () => {
    const dek = generateDek();
    // The checkpoint is bound to its (budgetId, epoch, uptoSeq) context — exactly what the fake
    // server serves below; the successful authenticated decrypt is what lets the replica adopt
    // the budget id its own key just vouched for (v2 writes are fail-closed without one).
    serverBlob = await e2ee.encryptSnapshot(emptyLedger(), dek, { budgetId: BUDGET_B, epoch: 1, uptoSeq: 0 });
    await idbPut("meta", dek, "e2eeDek"); // as a pre-2.0 build left it: key, no provenance
    legacyE2eeReplica();
    await reload();
    outbox.add(catOp());
    session = { user: { id: "user-A" } };
    serverBudget = BUDGET_B; // (the replica cannot name a budget — the DEK is the whole proof)

    await syncNow("test");

    expect(wrote(BUDGET_B)).toHaveLength(1); // proven → the ops go out
    await persist.flushed();
    expect(await idbGet<string>("meta", "userId")).toBe("user-A");
  });

  it("a DEK unwrapped from the SESSION's envelope proves nothing — not even after a reload", async () => {
    // The chain: this device holds user A's legacy e2ee replica; A's session lapses; B signs in
    // and unlocks (or changes the E2EE password) → setDek(B's DEK). In THAT page load the proof
    // correctly fails. After a reload the key is still in IDB — and it must STILL fail, or B's
    // own checkpoint would decrypt with it ("ours"), A's replica would be stamped as B's, A's
    // queued ops would be pushed into B's journal and a pending replace would overwrite it.
    const dekOfB = generateDek();
    serverBlob = await e2ee.encryptSnapshot(emptyLedger(), dekOfB, { budgetId: BUDGET_B, epoch: 1, uptoSeq: 0 }); // B's checkpoint, B's key
    legacyE2eeReplica(); // …but the replica on this device is A's
    e2ee.setDek(dekOfB, 1); // Unlock / password change under B's session
    outbox.add(catOp()); // A's unsent op
    markReplacePending(); // …and A's pending full replace of the server
    session = { user: { id: "user-B" } };
    serverBudget = BUDGET_B;

    await reload(); // ← the whole point: the key survives, its provenance must survive too
    await syncNow("test");

    expect(e2ee.isDekFromStore()).toBe(false);
    expect(wrote(BUDGET_B)).toEqual([]); // no ops, no /sync2/reset — B's budget is untouched
    expect(outbox.size()).toBe(1); // A's op is still here (refused ≠ destroyed)
    expect(reloads).toBe(0);
    await persist.flushed();
    expect(await idbGet("meta", "userId")).toBeUndefined(); // A's replica is NOT adopted by B
  });
});

/* ── The PER-REQUEST owner assertion on the full-budget OVERWRITE routes ──────
 *
 * /sync/replace, /sync2/reset and the E2EE enable/disable buttons resolve the target budget from
 * the SESSION COOKIE alone, and the client's ownership check is a DIFFERENT request than the
 * write: serializing (or encrypting) and uploading a whole ledger takes seconds on mobile, the
 * cookie is shared by every tab, and a sign-in as another user can complete in that window. The
 * blast radius is the entire budget — restoreLedger wipes it and rebuilds it from the body. So
 * the write NAMES the tenant the client verified, and the server refuses a session it did not
 * verify (409 budget_mismatch) BEFORE writing anything.
 *
 * The assertion is on the USER, not the budget: on the very path these routes serve — a restore —
 * the replica deliberately carries the BACKUP FILE's budgetId (data.ts), so asserting the budget
 * would refuse every restore of a backup taken from another install. */

describe("sync: full-budget overwrites carry the verified owner", () => {
  it("/sync/replace names the verified user, and a mid-upload sign-in as B is refused", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    // …while the ledger is uploading, the shared cookie becomes B's (a sign-in in another tab)
    onOverwrite = () => {
      session = { user: { id: "user-B" } };
      serverBudget = BUDGET_B;
      onOverwrite = null;
    };

    await expect(pushLocalToServer()).rejects.toThrow(); // 409 budget_mismatch

    expect(overwriteOwners).toEqual(["user-A"]); // the tenant the client verified travels along
    expect(wrote(BUDGET_B)).toEqual([]); // B's budget is NOT wiped and replaced by A's ledger
    expect(wrote(BUDGET_A)).toEqual([]); // …and the server wrote nothing at all
  });

  it("/sync2/reset names the verified user, and a mid-upload sign-in as B is refused", async () => {
    e2ee.setTierMeta({ tier: "e2ee", epoch: 1 });
    e2ee.setDek(generateDek(), 1);
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    onOverwrite = () => {
      session = { user: { id: "user-B" } };
      serverBudget = BUDGET_B;
      onOverwrite = null;
    };

    await expect(resetServerE2ee()).rejects.toThrow();

    expect(overwriteOwners).toEqual(["user-A"]);
    expect(wrote(BUDGET_B)).toEqual([]); // B's journal + checkpoint are NOT destroyed
  });

  it("with a stable session the replace goes through (the assertion is not a new refusal)", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };

    await pushLocalToServer();

    expect(overwriteOwners).toEqual(["user-A"]);
    expect(wrote(BUDGET_A)).toEqual(["replace"]);
  });

  it("a restore whose backup names ANOTHER budget still works (the tenant is the user)", async () => {
    // importBackup() adopts the budgetId from the FILE, so after restoring a backup taken on a
    // different install the replica names a budget the session does not own. That is the normal
    // "migrate hosts / rebuild the server" flow — it must NOT be mistaken for a cross-tenant write.
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    store.replace(nonEmptyLedger(), 0, BUDGET_B); // the ledger came from budget B's backup file
    markReplacePending(); // …and owes the server a full replace

    await syncNow("test");

    expect(wrote(BUDGET_A)).toEqual(["replace"]); // restored into the session user's own budget
    expect(store.getBudgetId()).toBe(BUDGET_A); // …and the replica adopts the canonical id
  });
});

/* ── Cloud sign-out: pre-wipe outbox flush ──────────────────────────────── */

describe("flushOutboxForSignOut (cloud sign-out wipes the replica afterwards)", () => {
  it("pushes the queue and reports 0 left — the wipe loses nothing", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    outbox.add(catOp());

    expect(await flushOutboxForSignOut()).toBe(0);
    expect(wrote(BUDGET_A).length).toBe(1); // the op reached the server first
  });

  it("offline: nothing pushed, the remainder reported — NOTHING destroyed here", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    outbox.add(catOp());
    offline = true;

    expect(await flushOutboxForSignOut()).toBe(1);
    expect(outbox.size()).toBe(1); // still queued — the CALLER asks the human before any discard
  });
});
