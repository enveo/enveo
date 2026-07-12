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
  __resetIdentity,
  __resetObligations,
  __setLocalMode,
  assertOwnReplica,
  decideIdentity,
  disableLocal,
  discardForeignReplica,
  getLocalMode,
  markReplacePending,
  enterLoginKeepingReplica,
  pushLocalToServer,
  resetServerE2ee,
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
  recurrences: [],
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
 
let writes: Record<string, string[]> = {};
 
let onPush: (() => void) | null = null;
 
let onOverwrite: (() => void) | null = null;
 
let overwriteOwners: (string | undefined)[] = [];
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
  writes = {};
  onPush = null;
  onOverwrite = null;
  overwriteOwners = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("/api/auth/get-session")) return json(session);  
    if (url.startsWith("/api/sync2/")) {
      if (serverIsPlain) return tierMismatch();
      if (url.startsWith("/api/sync2/snapshot")) {
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
      if (url.startsWith("/api/sync2/pull")) return json({ cursor: 0, epoch: 1, ops: [] });
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
  __setLocalMode("off");
  outbox.clearAll();
  e2ee.__resetDekForTests();
  e2ee.clearDek();
  e2ee.setTierMeta({ tier: "plain", epoch: 0 });
  await clearLocalData();  
  store.replace(emptyLedger(), 0, BUDGET_A);  
  store.setBootStatus("ready");
  void persist.persistLedger(store.snapshotForPersist());  
  await persist.flushed();
});

afterEach(() => {
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

    await discardForeignReplica();  

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
 * device — wiping there would silently destroy the ledger AND every queued op. */

describe("sync: an unproven replica is refused, never wiped", () => {
  it("2.0 upgrade path: the owner's budget is lazily created (new id) → no write, no data loss", async () => {
    outbox.add(catOp());  
    session = { user: { id: "user-owner" } };  
    serverBudget = BUDGET_B; // …whose budget was lazily created empty (the old one is not attached yet)

    await syncNow("test");

    expect(called("/api/sync/push")).toBe(false);  
    expect(reloads).toBe(0); // NOT wiped — the mismatch proves nothing about the account
    expect(outbox.size()).toBe(1);  
    await persist.flushed();
    expect(await idbGet("meta", "ledger")).toBeDefined();  
    expect(await idbGet("meta", "userId")).toBeUndefined(); // …and NOT adopted on a guess
  });

  it("the same replica is pushed once the owner's budget is reattached", async () => {
    outbox.add(catOp());
    session = { user: { id: "user-owner" } };
    serverBudget = BUDGET_B;
    await syncNow("test");  

    serverBudget = BUDGET_A;  
    await syncNow("test");

    expect(called("/api/sync/push")).toBe(true);  
    await persist.flushed();
    expect(await idbGet<string>("meta", "userId")).toBe("user-owner");
  });

  it("an unproven replica is refused by the out-of-cycle writers too, with no wipe", async () => {
    session = { user: { id: "user-owner" } };
    serverBudget = BUDGET_B;

    await expect(pushLocalToServer()).rejects.toThrow();
    await expect(assertOwnReplica()).rejects.toThrow();
    expect(called("/api/sync/replace")).toBe(false);
    expect(reloads).toBe(0);
    expect(await idbGet("meta", "ledger")).toBeDefined();
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
