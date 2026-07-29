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
 * the last copy of that budget (local mode "wiped" deleted the server's), and a user id does not
 * survive a server rebuild (same e-mail, new uuid). A failed proof for an UNSTAMPED replica — a
 * budgetId that differs, a checkpoint its DEK cannot open — is merely inconclusive (budgetId is
 * the epoch marker and the session's budget may have just been lazily created), so it refuses
 * every write too. And an UNBOUND replica (no budgetId at all) is adopted only where adoption
 * cannot destroy anything: against a session budget that is provably empty.
 *
 * Under bun there is no window/indexedDB, so idb.ts runs in its in-memory mode and sync.ts
 * installs no triggers — the cycle can be driven directly with syncNow().
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ClientLedger, SyncOp } from "@enveo/shared";
import { generateDek } from "./crypto";
import * as e2ee from "./e2ee";
import { clearLocalData, idbGet, idbPut } from "./idb";
import * as outbox from "./outbox";
import * as persist from "./persist";
import { store } from "./store";
import {
  __resetBackoff,
  __resetIdentity,
  __resetObligations,
  __setLocalMode,
  assertOwnReplica,
  decideIdentity,
  disableLocal,
  discardLocalReplica,
  flushOutboxForSignOut,
  getLocalMode,
  getSyncStatus,
  markReplacePending,
  enterLoginKeepingReplica,
  pushLocalToServer,
  recheckReplicaOwner,
  resetServerE2ee,
  retryBoot,
  subscribeSyncStatus,
  syncNow,
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

 

let calls: string[] = [];
let session: { user: { id: string } } | null = null;
let reloads = 0;
 
let serverBudget = BUDGET_A;
 
let serverIsPlain = false;
 
let serverBlob: string | null = null;
 
let serverHasData = false;
 
let serverE2eeCursor = 0;
 
let offline = false;
 
let writes: Record<string, string[]> = {};
 
let onPush: (() => void) | null = null;
/** Runs when a PULL arrives — lets a test swap the session mid-cycle with an EMPTY outbox (the
 *  steady state: the push loop is skipped entirely, so its per-request assertion never fires). */
let onPull: (() => void) | null = null;
 
let onOverwrite: (() => void) | null = null;
 
let overwriteOwners: (string | undefined)[] = [];
 
let snapshotUploads: { userId?: string; uptoSeq: number }[] = [];
const realFetch = globalThis.fetch;
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const conflict = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 409, headers: { "content-type": "application/json" } });
const tierMismatch = (): Response => conflict({ error: "tier_mismatch", tier: "plain", epoch: 0 });
/** The server's PER-REQUEST tenant assertion: the pushed budget must be the session's. */
const budgetMismatch = (claimed: string | undefined): Response | null =>
  claimed !== undefined && claimed !== serverBudget
    ? conflict({ error: "budget_mismatch", budgetId: serverBudget })
    : null;
/**
 * The server's PER-REQUEST OWNER assertion on the full-budget OVERWRITE routes (api
 * ownerAssertionFails): the body names the tenant the client verified, and the server compares it
 * with the session IT resolves for THIS request — a cookie swapped mid-upload is refused.
 */
const ownerMismatch = (claimed: string | undefined): Response | null =>
  claimed !== undefined && claimed !== session?.user.id
    ? conflict({ error: "budget_mismatch", budgetId: serverBudget })
    : null;
const wrote = (budgetId: string): string[] => writes[budgetId] ?? [];

 
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
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (offline) throw new TypeError("offline"); // network failure — NOT a "signed out" answer
    if (url.startsWith("/api/auth/get-session")) return json(session);  
    if (url.startsWith("/api/sync2/")) {
      if (serverIsPlain) return tierMismatch();
      if (url.startsWith("/api/sync2/snapshot")) {
        

        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body ?? "{}")) as { userId?: string; uptoSeq: number };
          snapshotUploads.push(body);
          const refused = ownerMismatch(body.userId);
          if (refused) return refused;
          writes[serverBudget] = [...wrote(serverBudget), "snapshot"];
          return json({ epoch: 1, uptoSeq: body.uptoSeq });
        }
        return json({ budgetId: serverBudget, epoch: 1, wrappedDek: null, kdfParams: null, uptoSeq: 0, blob: serverBlob });
      }
      if (url.startsWith("/api/sync2/push")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          budgetId?: string;
          ops: Array<{ opId: string }>;
        };
        const refused = budgetMismatch(body.budgetId);
        if (refused) return refused;
        writes[serverBudget] = [...wrote(serverBudget), ...body.ops.map((o) => o.opId)];
        onPush?.();  
        return json({ cursor: 1, epoch: 1 });
      }
      if (url.startsWith("/api/sync2/pull")) {
        onPull?.();  
        return json({ cursor: serverE2eeCursor, epoch: 1, ops: [] });
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
    if (url.startsWith("/api/sync/push")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { budgetId?: string; ops: SyncOp[] };
      const refused = budgetMismatch(body.budgetId);
      if (refused) return refused;
      writes[serverBudget] = [...wrote(serverBudget), ...body.ops.map((o) => o.opId)];
      const res = json({
        budgetId: serverBudget,
        results: body.ops.map((o) => ({ opId: o.opId, status: "applied" })),
      });
      onPush?.();  
      return res;
    }
    if (url.startsWith("/api/sync/snapshot")) {
      return json({ budgetId: serverBudget, cursor: 0, ...(serverHasData ? nonEmptyLedger() : emptyLedger()) });
    }
    if (url.startsWith("/api/sync/pull")) {
      onPull?.();  
      return json({ budgetId: serverBudget, cursor: 0, resetRequired: false, changes: [] });
    }
    if (url.startsWith("/api/sync/replace")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { userId?: string };
      overwriteOwners.push(body.userId);
      onOverwrite?.();  
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
  __setLocalMode("off");
  outbox.clearAll();
  e2ee.__resetDekForTests();
  e2ee.clearDek();
  e2ee.resetOpsCounter();  
  e2ee.setTierMeta({ tier: "plain", epoch: 0 });
  await clearLocalData();  
  store.replace(emptyLedger(), 0, BUDGET_A);  
  store.setBootStatus("ready");
  void persist.persistLedger(store.snapshotForPersist());  
  await persist.flushed();
});

afterEach(() => {
  __resetBackoff();  
  globalThis.fetch = realFetch;
  delete (globalThis as { location?: unknown }).location;
});

 

describe("decideIdentity", () => {
  it("no session → unauthed (regardless of the stamp)", () => {
    expect(decideIdentity(null, "user-A")).toBe("unauthed");
    expect(decideIdentity(null, undefined)).toBe("unauthed");
  });
  it("stamped with a DIFFERENT user → foreign", () => {
    expect(decideIdentity("user-B", "user-A")).toBe("foreign");
  });
  it("same user → ok; no stamp yet → ok (ownership is proved separately)", () => {
    expect(decideIdentity("user-A", "user-A")).toBe("ok");
    expect(decideIdentity("user-A", undefined)).toBe("ok");
  });
});

 

describe("sync cycle: session guard before the push", () => {
  it("no session → Login screen, nothing pushed, the outbox is preserved", async () => {
    await idbPut("meta", "user-A", "userId");
    outbox.add(catOp());
    session = null;

    await syncNow("test");

    expect(called("/api/auth/get-session")).toBe(true);
    expect(called("/api/sync/push")).toBe(false);
    expect(store.getBootStatus()).toBe("unauthed");  
    expect(outbox.size()).toBe(1);  
  });

  it("a DIFFERENT account signed in → no push at all; the replica is BLOCKED, not destroyed", async () => {
    await idbPut("meta", "user-A", "userId");  
    outbox.add(catOp());  
    session = { user: { id: "user-B" } };  

    await syncNow("test");

    expect(called("/api/sync/push")).toBe(false); // A's op NEVER reaches B's budget
    expect(store.getBootStatus()).toBe("foreign");  
    expect(reloads).toBe(0);  
    await persist.flushed();
    expect(await idbGet("meta", "ledger")).toBeDefined();  
    expect(await idbGet<string>("meta", "userId")).toBe("user-A");  
    expect(outbox.size()).toBe(1);  
  });

  it("the previous owner can sign back in — the sign-out KEEPS the replica", async () => {
    // The non-destructive way off ForeignReplicaScreen (and the reason "destroy nothing" is not a
    // dead end): the app is not rendered there, so Settings → sign out is unreachable.
    await idbPut("meta", "user-A", "userId");
    outbox.add(catOp());
    session = { user: { id: "user-B" } };
    await expect(assertOwnReplica()).rejects.toThrow();
    expect(store.getBootStatus()).toBe("foreign");

    session = null;  
    enterLoginKeepingReplica();

    expect(store.getBootStatus()).toBe("unauthed");  
    expect(await idbGet("meta", "ledger")).toBeDefined();  
    expect(outbox.size()).toBe(1);

    session = { user: { id: "user-A" } };  
    await syncNow("test");

    expect(pushed().length).toBe(1);  
    expect(store.getBootStatus()).toBe("ready");
  });

  it("only the human's explicit choice destroys a foreign replica (and it clears local mode)", async () => {
    __setLocalMode("wiped");  
    await idbPut("meta", "user-A", "userId");
    outbox.add(catOp());
    session = { user: { id: "user-B" } };
    await assertOwnReplica().catch(() => {});  
    expect(store.getBootStatus()).toBe("foreign");

    await discardLocalReplica();  

    expect(reloads).toBe(1);
    expect(await idbGet("meta", "ledger")).toBeUndefined();  
    expect(await idbGet("meta", "userId")).toBeUndefined();
    expect(outbox.size()).toBe(0);
    

    expect(getLocalMode()).toBe("off");
  });

  it("same account → the cycle runs and the owner stamp is (re)written", async () => {
    await idbPut("meta", "user-A", "userId");
    outbox.add(catOp());
    session = { user: { id: "user-A" } };

    await syncNow("test");

    expect(called("/api/sync/push")).toBe(true);
    expect(outbox.size()).toBe(0);  
    await persist.flushed();
    expect(await idbGet<string>("meta", "userId")).toBe("user-A");
    expect(store.getBootStatus()).toBe("ready");
  });

  it("server replace outside a cycle (disable local mode) is guarded too", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-B" } };

    await expect(pushLocalToServer()).rejects.toThrow(); // aborted, not applied to B's budget
    expect(called("/api/sync/replace")).toBe(false);
    expect(store.getBootStatus()).toBe("foreign");
    expect(await idbGet("meta", "ledger")).toBeDefined();  
  });
});

/* ── The foreign verdict must not destroy the LAST copy of a budget ──────
 *
 * In local mode "wiped" the server data was deliberately deleted, so the IDB replica is the ONLY
 * copy — and the mode makes boot skip the network entirely, so the foreign replica surfaces only
 * when someone taps "Disable local mode". Wiping there (the first cut of this guard did) destroys
 * the budget outright: local gone, server empty by design. The same holds for a self-hoster who
 * rebuilt their server and got a NEW user id for the same e-mail — the "foreign" stamp is then a
 * false positive over the very data the rebuild is meant to recover. */

describe("sync: a foreign replica in local mode 'wiped' (the only copy left)", () => {
  it("'Disable local mode' as another user destroys nothing — it blocks and asks", async () => {
    __setLocalMode("wiped");  
    await idbPut("meta", "user-A", "userId");
    outbox.add(catOp());
    session = { user: { id: "user-B" } };  

    await expect(disableLocal()).rejects.toThrow();  

    expect(called("/api/sync/replace")).toBe(false); // A's ledger does NOT overwrite B's budget
    expect(store.getBootStatus()).toBe("foreign");  
    expect(reloads).toBe(0);
    expect(getLocalMode()).toBe("wiped");  
    await persist.flushed();
    expect(await idbGet("meta", "ledger")).toBeDefined();  
    expect(outbox.size()).toBe(1);
  });
});

 

describe("sync cycle: the session is re-verified every cycle", () => {
  it("sign-in as another user in ANOTHER tab → the long-lived tab pushes nothing", async () => {
    


    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    await syncNow("boot");  

    outbox.add(catOp());  
    session = { user: { id: "user-B" } };  

    await syncNow("interval");

    expect(called("/api/sync/push")).toBe(false); // A's op does NOT land in B's budget
    expect(store.getBootStatus()).toBe("foreign"); // …and A's data is blocked, not destroyed
    expect(reloads).toBe(0);
  });

  it("a 401 forgets the verdict — the next (different) session cannot inherit it", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    outbox.add(catOp());
    await syncNow("boot");  
    expect(pushed().length).toBe(1);

    outbox.add(catOp());  
    session = null;  
    await syncNow("interval");
    expect(store.getBootStatus()).toBe("unauthed");  

    session = { user: { id: "user-B" } };  
    await syncNow("interval");

    expect(pushed().length).toBe(1);  
    expect(store.getBootStatus()).toBe("foreign");  
    expect(outbox.size()).toBe(1); // A's queued op is preserved, not thrown away
  });
});

 

describe("sync cycle: replica with no owner stamp", () => {
  it("the session's budget IS the replica's → adopted and pushed", async () => {
    outbox.add(catOp());
    session = { user: { id: "user-C" } };
    serverBudget = BUDGET_A;  

    await syncNow("test");

    expect(called("/api/sync/push")).toBe(true);
    await persist.flushed();
    expect(await idbGet<string>("meta", "userId")).toBe("user-C");
  });

  it("a pending REPLACE with an EMPTY outbox never overwrites the session's budget", async () => {
    


    markReplacePending();  
    session = { user: { id: "user-B" } };
    serverBudget = BUDGET_B;  

    await syncNow("test");

    expect(outbox.size()).toBe(0);  
    expect(called("/api/sync/replace")).toBe(false); // B's budget is NOT overwritten
  });

  it("pushLocalToServer (import / disable local mode) proves ownership as well", async () => {
    session = { user: { id: "user-B" } };
    serverBudget = BUDGET_B;

    await expect(pushLocalToServer()).rejects.toThrow();
    expect(called("/api/sync/replace")).toBe(false);
  });

  it("assertOwnReplica guards the writes made outside sync.ts (E2EE enable/disable)", async () => {
    


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
 * replica is reachable ("Clear local data" in local mode leaves exactly an empty unbound one, and
 * an offline start then fills it with data), so the proof must be about what a wrong answer would
 * COST: an empty session budget has nothing to lose, one that holds data has everything. */

describe("sync: an UNBOUND replica (no budgetId)", () => {
  it("is refused against a session budget that HOLDS DATA (no cross-tenant overwrite)", async () => {
    


    store.replace(nonEmptyLedger(), 0, "");  
    await persist.persistLedger(store.snapshotForPersist());
    session = { user: { id: "user-B" } };
    serverHasData = true; // …and B's budget is NOT empty

    await expect(pushLocalToServer()).rejects.toThrow();  

    expect(called("/api/sync/replace")).toBe(false); // B's budget is NOT wiped and overwritten
    expect(reloads).toBe(0);  
    await persist.flushed();
    expect(await idbGet("meta", "userId")).toBeUndefined(); // NOT adopted on a guess
    expect(await idbGet("meta", "ledger")).toBeDefined();  
  });

  it("is adopted when the session's budget is provably EMPTY (nothing to destroy)", async () => {
    store.replace(nonEmptyLedger(), 0, "");  
    session = { user: { id: "user-B" } };
    serverHasData = false;  

    await pushLocalToServer();

    expect(wrote(BUDGET_A)).toEqual(["replace"]);  
    await persist.flushed();
    expect(await idbGet<string>("meta", "userId")).toBe("user-B");
  });

  it("'Disable local mode' on an EMPTY unbound replica never replaces the server with nothing", async () => {
    


    __setLocalMode("wiped");
    await clearLocalData();
    store.replace(emptyLedger(), 0, "");  
    session = { user: { id: "user-B" } };
    serverHasData = true;  

    await disableLocal();

    expect(called("/api/sync/replace")).toBe(false);  
    expect(getLocalMode()).toBe("off");  
    expect(reloads).toBe(1);  
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
    outbox.add(catOp());  
    session = { user: { id: "user-owner" } };  
    serverBudget = BUDGET_B; // …whose budget was lazily created empty (the old one is not attached yet)

    await syncNow("test");

    expect(called("/api/sync/push")).toBe(false);  
    expect(getSyncStatus().state).toBe("unverified"); // …and the UI can SAY so (not a red "error")
    expect(reloads).toBe(0); // NOT wiped — the mismatch proves nothing about the account
    expect(outbox.size()).toBe(1);  
    expect(store.getBootStatus()).toBe("ready"); // the app keeps working — it just cannot send
    await persist.flushed();
    expect(await idbGet("meta", "ledger")).toBeDefined();  
    expect(await idbGet("meta", "userId")).toBeUndefined(); // …and NOT adopted on a guess
  });

  it("the same replica is pushed once the owner's budget is reattached — and the state clears", async () => {
    outbox.add(catOp());
    session = { user: { id: "user-owner" } };
    serverBudget = BUDGET_B;
    await syncNow("test");  
    expect(getSyncStatus().state).toBe("unverified");

    serverBudget = BUDGET_A;  
    await syncNow("test");

    expect(called("/api/sync/push")).toBe(true);  
    expect(getSyncStatus().state).toBe("synced");  
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
    expect(getSyncStatus().state).toBe("unverified");  
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

    serverBudget = BUDGET_A;  
    await recheckReplicaOwner();  

    expect(wrote(BUDGET_A)).toHaveLength(1);  
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
    expect(await idbGet("meta", "ledger")).toBeDefined();  

    await discardLocalReplica();  

    expect(reloads).toBe(1);  
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
    outbox.add(catOp());  
    session = { user: { id: "user-owner" } };
    serverBudget = BUDGET_B;
    await syncNow("test");
    expect(getSyncStatus().ownerUnproven).toBe(true);

    const { seen, stop } = record();
    await syncNow("test");  
    await recheckReplicaOwner();
    stop();

    expect(seen.some((s) => s.state === "syncing")).toBe(true);  
    expect(seen.every((s) => s.unproven)).toBe(true); // …the fact the UI reads does NOT
    expect(getSyncStatus().state).toBe("unverified");
    expect(getSyncStatus().ownerUnproven).toBe(true);
  });

  it("clears the moment the proof succeeds", async () => {
    session = { user: { id: "user-owner" } };
    serverBudget = BUDGET_B;
    await syncNow("test");
    expect(getSyncStatus().ownerUnproven).toBe(true);

    serverBudget = BUDGET_A;  
    await recheckReplicaOwner();

    expect(getSyncStatus().ownerUnproven).toBe(false);  
    expect(getSyncStatus().state).toBe("synced");
  });

  it("clears on sign-out — the Login screen owns the story from there", async () => {
    session = { user: { id: "user-owner" } };
    serverBudget = BUDGET_B;
    await syncNow("test");
    expect(getSyncStatus().ownerUnproven).toBe(true);

    enterLoginKeepingReplica();  

    expect(getSyncStatus().ownerUnproven).toBe(false);
    expect(getSyncStatus().state).toBe("unauthed");
  });

  it("clears in local mode — there sync is off by the user's own choice", async () => {
    session = { user: { id: "user-owner" } };
    serverBudget = BUDGET_B;
    await syncNow("test");
    expect(getSyncStatus().ownerUnproven).toBe(true);

    __setLocalMode("paused");  

    expect(getSyncStatus().ownerUnproven).toBe(false);
    expect(getSyncStatus().state).toBe("local");
  });
});










describe("sync push: the per-request tenant assertion", () => {
  it("the cookie is swapped BETWEEN batches → the rest of the outbox never lands in B's budget", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    for (let i = 0; i < 150; i++) outbox.add(catOp()); 


    onPush = () => {
      session = { user: { id: "user-B" } };
      serverBudget = BUDGET_B;
      onPush = null;
    };

    await syncNow("test");

    expect(pushed().length).toBe(2);  
    expect(wrote(BUDGET_A)).toHaveLength(100);  
    expect(wrote(BUDGET_B)).toEqual([]);  
    expect(store.getBootStatus()).toBe("foreign");  
    expect(reloads).toBe(0);  
  });

  it("same user, budget rotated (reseed / restore / reattach) → resync, then the ops go out", async () => {
    // The very same 409, from the legitimate cause: it must NOT become a permanent refusal.
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    serverBudget = BUDGET_B;  
    store.replace(emptyLedger(), 0, BUDGET_A);  
    outbox.add(catOp());

    await syncNow("test");

    expect(wrote(BUDGET_B)).toHaveLength(1);  
    expect(store.getBudgetId()).toBe(BUDGET_B);
    expect(outbox.size()).toBe(0);
    expect(reloads).toBe(0);  
  });
});











describe("sync pull: a resync never replaces the mirror on an unverified session", () => {
  it("the cookie is swapped mid-cycle (EMPTY outbox) → A's replica is NOT overwritten by B's", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    expect(outbox.size()).toBe(0); 


    onPull = () => {
      session = { user: { id: "user-B" } };
      serverBudget = BUDGET_B;
      onPull = null;
    };

    await syncNow("interval");

    expect(called("/api/sync/snapshot")).toBe(false); // B's ledger is never even fetched…
    expect(store.getBudgetId()).toBe(BUDGET_A);  
    expect(store.getBootStatus()).toBe("foreign");  
    expect(reloads).toBe(0);  
    await persist.flushed();
    expect(await idbGet("meta", "budgetId")).toBe(BUDGET_A);  
    expect(await idbGet<string>("meta", "userId")).toBe("user-A");
  });

  it("same user, budget rotated (reseed / restore) → the pull-side resync still runs", async () => {
    // The very same signal from the legitimate cause: it must NOT become a permanent refusal.
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    serverBudget = BUDGET_B; // the user's own budget id changed under the replica (new data epoch)

    await syncNow("interval");

    expect(called("/api/sync/snapshot")).toBe(true);  
    expect(store.getBudgetId()).toBe(BUDGET_B);
    expect(store.getBootStatus()).toBe("ready");
    expect(reloads).toBe(0);
  });
});

/* ── BOOT is the READ side: the app must not render a foreign replica ─────
 *
 * boot() hydrates from IDB and sets BootStatus "ready" BEFORE the first cycle runs, so the guard
 * that protects writes cannot protect the screen. The ways a device changes hands are routine (a
 * 90-day cookie expires → Login; sign-out keeps the replica → Login; the next account signs in),
 * and in local mode doCycle bails before ensureIdentity ever runs — there the window would never
 * close at all. */

describe("sync boot: the replica's owner is checked BEFORE it is rendered", () => {
  it("another account signed in → ForeignReplicaScreen, not the previous owner's budget", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-B" } };

    await retryBoot();

    expect(store.getBootStatus()).toBe("foreign"); // App never renders A's ledger to B
    expect(called("/api/sync/snapshot")).toBe(false); // …and B's data is not bootstrapped over it
    expect(reloads).toBe(0);
    expect(await idbGet("meta", "ledger")).toBeDefined();  
  });

  it("the session expired → Login BEFORE the data is on screen (replica + outbox preserved)", async () => {
    await idbPut("meta", "user-A", "userId");
    outbox.add(catOp());
    session = null;  

    await retryBoot();

    expect(store.getBootStatus()).toBe("unauthed");  
    expect(outbox.size()).toBe(1);  
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
    expect(called("/api/auth/get-session")).toBe(true);  
  });

  it("OFFLINE: the owner cannot be verified → local-first wins, the replica is shown", async () => {
    // Being offline is not being somebody else. A boot that refuses to show the replica would be
    // its own kind of data loss (it can be the last copy) — the first cycle that REACHES the
    // server enforces the verdict instead.
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    offline = true; // get-session THROWS (network), it does not answer "no session"

    await retryBoot();
    await syncNow("drain");  

    expect(store.getBootStatus()).toBe("ready");
  });

  it("LOCAL MODE + another account → foreign (no cycle ever runs there to catch it)", async () => {
    

    __setLocalMode("paused");
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-B" } };

    await retryBoot();

    expect(store.getBootStatus()).toBe("foreign");
    expect(await idbGet("meta", "ledger")).toBeDefined(); // …blocked, not destroyed
  });

  it("LOCAL MODE + no session → the replica still boots (the server may be gone for good)", async () => {
    


    __setLocalMode("wiped");
    await idbPut("meta", "user-A", "userId");
    session = null;

    await retryBoot();

    expect(store.getBootStatus()).toBe("ready");
    expect(called("/api/sync/snapshot")).toBe(false);  
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
    await syncNow("drain");  

    expect(store.getBootStatus()).toBe("ready");
    expect(store.getLedger()!.transactions).toHaveLength(0);  
    expect(outbox.size()).toBe(0);  
    expect(pushed().length).toBeGreaterThan(0); // it left through the real push path, not just memory
    expect(wrote(BUDGET_A)).toHaveLength(1);  
  });

  it("a clean ledger (no legacy planned rows) boots without pushing anything extra", async () => {
    session = { user: { id: "user-A" } };

    await retryBoot();

    expect(store.getBootStatus()).toBe("ready");
    expect(outbox.size()).toBe(0);  
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
    e2ee.setDek(generateDek());
    e2ee.noteOpsSeen(e2ee.SNAPSHOT_EVERY_OPS);  
    serverE2eeCursor = 5;  
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
      session = { user: { id: "user-B" } };  
      serverBudget = BUDGET_B;
      onPull = null;
    };

    await syncNow("interval");
    await uploaded();

    expect(snapshotUploads[0]?.userId).toBe("user-A");  
    expect(wrote(BUDGET_B)).toEqual([]);  
  });
});

/* ── A 401 outside a cycle must reach the Login screen too ─────────────── */

describe("sync: 401 on an out-of-cycle write routes to Login", () => {
  it("pushLocalToServer with no session → BootStatus unauthed (not a raw error string)", async () => {
    // The 2.0 upgrade path of a device in local mode "wiped": the server data was deliberately
    // deleted, so the IDB replica is the ONLY copy — and boot in local mode makes NO network
    // call, so nothing else can put the Login screen on screen. Without this, "Disable local
    // mode" ends in "unauthorized: 401" and the only offered remedy destroys the sole copy.
    session = null;
    await idbPut("meta", "user-A", "userId");

    await expect(pushLocalToServer()).rejects.toThrow();

    expect(called("/api/sync/replace")).toBe(false);
    expect(store.getBootStatus()).toBe("unauthed");  
    expect(await idbGet("meta", "ledger")).toBeDefined();  
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
    e2ee.setDek(new Uint8Array(32));
    outbox.add(catOp()); // queued ops (plaintext, waiting to be encrypted at push)
    markReplacePending();  
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
    e2ee.setDek(new Uint8Array(32));
    store.replace(emptyLedger(), 0, "");  
    outbox.add(catOp());
    session = { user: { id: "user-B" } };
    serverIsPlain = true;

    await syncNow("test");

    expect(called("/api/sync2/push")).toBe(false);
    expect(called("/api/sync/push")).toBe(false); // …not on the v1 path either
    expect(called("/api/sync/replace")).toBe(false);
    expect(outbox.size()).toBe(1);  
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
   
  const reload = async () => {
    await persist.flushed();
    e2ee.__resetDekForTests();
    await e2ee.hydrate();
  };

  it("a DEK that came WITH the replica and opens the session's checkpoint → ours (adopted)", async () => {
    const dek = generateDek();
    serverBlob = await e2ee.encryptSnapshot(emptyLedger(), dek);
    await idbPut("meta", dek, "e2eeDek");  
    legacyE2eeReplica();
    await reload();
    outbox.add(catOp());
    session = { user: { id: "user-A" } };
    serverBudget = BUDGET_B; // (the replica cannot name a budget — the DEK is the whole proof)

    await syncNow("test");

    expect(wrote(BUDGET_B)).toHaveLength(1);  
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
    serverBlob = await e2ee.encryptSnapshot(emptyLedger(), dekOfB);  
    legacyE2eeReplica();  
    e2ee.setDek(dekOfB);  
    outbox.add(catOp());  
    markReplacePending();  
    session = { user: { id: "user-B" } };
    serverBudget = BUDGET_B;

    await reload(); // ← the whole point: the key survives, its provenance must survive too
    await syncNow("test");

    expect(e2ee.isDekFromStore()).toBe(false);
    expect(wrote(BUDGET_B)).toEqual([]);  
    expect(outbox.size()).toBe(1);  
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
     
    onOverwrite = () => {
      session = { user: { id: "user-B" } };
      serverBudget = BUDGET_B;
      onOverwrite = null;
    };

    await expect(pushLocalToServer()).rejects.toThrow();  

    expect(overwriteOwners).toEqual(["user-A"]); // the tenant the client verified travels along
    expect(wrote(BUDGET_B)).toEqual([]); // B's budget is NOT wiped and replaced by A's ledger
    expect(wrote(BUDGET_A)).toEqual([]);  
  });

  it("/sync2/reset names the verified user, and a mid-upload sign-in as B is refused", async () => {
    e2ee.setTierMeta({ tier: "e2ee", epoch: 1 });
    e2ee.setDek(generateDek());
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
    store.replace(nonEmptyLedger(), 0, BUDGET_B);  
    markReplacePending();  

    await syncNow("test");

    expect(wrote(BUDGET_A)).toEqual(["replace"]);  
    expect(store.getBudgetId()).toBe(BUDGET_A);  
  });
});

 

describe("flushOutboxForSignOut (cloud sign-out wipes the replica afterwards)", () => {
  it("pushes the queue and reports 0 left — the wipe loses nothing", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    outbox.add(catOp());

    expect(await flushOutboxForSignOut()).toBe(0);
    expect(wrote(BUDGET_A).length).toBe(1);  
  });

  it("offline: nothing pushed, the remainder reported — NOTHING destroyed here", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-A" } };
    outbox.add(catOp());
    offline = true;

    expect(await flushOutboxForSignOut()).toBe(1);
    expect(outbox.size()).toBe(1);  
  });
});
