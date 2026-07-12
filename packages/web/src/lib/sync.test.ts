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
 * The guard is asymmetric on purpose: only the userId STAMP can prove a replica FOREIGN (that
 * verdict wipes it). A failed proof for an UNSTAMPED replica — a budgetId that differs, a
 * checkpoint its DEK cannot open — is inconclusive (budgetId is the epoch marker and the
 * session's budget may have just been lazily created), so it refuses every write and destroys
 * nothing.
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
  assertOwnReplica,
  decideIdentity,
  markReplacePending,
  pushLocalToServer,
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
/** What actually got WRITTEN, per budget: the whole point of the guard. */
let writes: Record<string, string[]> = {};
/** Runs when a push request arrives — lets a test swap the session mid-cycle. */
let onPush: (() => void) | null = null;
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
const wrote = (budgetId: string): string[] => writes[budgetId] ?? [];

beforeEach(async () => {
  calls = [];
  reloads = 0;
  session = null;
  serverBudget = BUDGET_A;
  serverIsPlain = false;
  serverBlob = null;
  writes = {};
  onPush = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("/api/auth/get-session")) return json(session); // 200 + `null` = no session
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
        onPush?.(); // a session swap lands BETWEEN two batches of the same push loop
        return json({ cursor: 1, epoch: 1 });
      }
      if (url.startsWith("/api/sync2/pull")) return json({ cursor: 0, epoch: 1, ops: [] });
      if (url.startsWith("/api/sync2/reset")) {
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
      onPush?.(); // a session swap lands BETWEEN two batches of the same push loop
      return res;
    }
    if (url.startsWith("/api/sync/snapshot")) {
      return json({ budgetId: serverBudget, cursor: 0, ...emptyLedger() });
    }
    if (url.startsWith("/api/sync/pull")) {
      return json({ budgetId: serverBudget, cursor: 0, resetRequired: false, changes: [] });
    }
    if (url.startsWith("/api/sync/replace")) {
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
  outbox.clearAll();
  e2ee.__resetDekForTests();
  e2ee.clearDek();
  e2ee.setTierMeta({ tier: "plain", epoch: 0 });
  await clearLocalData(); // no stamp, no ledger blob — each test sets up its own
  store.replace(emptyLedger(), 0, BUDGET_A); // a booted replica of budget A
  store.setBootStatus("ready");
  void persist.persistLedger(store.snapshotForPersist()); // durable, so a wipe is observable
  await persist.flushed();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as { location?: unknown }).location;
});

/* ── Pure decision ────────────────────────────────────────────────────── */

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

  it("a DIFFERENT account signed in → no push at all; the foreign replica is wiped", async () => {
    await idbPut("meta", "user-A", "userId"); // the replica belongs to user A
    outbox.add(catOp()); // …and carries A's unsent op
    session = { user: { id: "user-B" } }; // …but user B is signed in now

    await syncNow("test");

    expect(called("/api/sync/push")).toBe(false); // A's op NEVER reaches B's budget
    expect(reloads).toBe(1); // wiped + reloading → clean bootstrap for B
    expect(await idbGet("meta", "ledger")).toBeUndefined(); // A's replica gone from IDB
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

  it("server replace outside a cycle (disable local mode) is guarded too", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-B" } };

    await expect(pushLocalToServer()).rejects.toThrow(); // aborted, not applied to B's budget
    expect(called("/api/sync/replace")).toBe(false);
    expect(reloads).toBe(1);
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
    expect(reloads).toBe(1); // foreign replica → wiped + reloading
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
    expect(reloads).toBe(1); // A's replica wiped before B's budget could be touched
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

  it("pushLocalToServer (import / disable local mode) proves ownership as well", async () => {
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
    expect(reloads).toBe(1); // provably foreign (stamp) → wiped + reloading
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
    outbox.add(catOp()); // ops queued before the upgrade
    session = { user: { id: "user-owner" } }; // freshly registered owner…
    serverBudget = BUDGET_B; // …whose budget was lazily created empty (the old one is not attached yet)

    await syncNow("test");

    expect(called("/api/sync/push")).toBe(false); // nothing written into the new empty budget
    expect(reloads).toBe(0); // NOT wiped — the mismatch proves nothing about the account
    expect(outbox.size()).toBe(1); // the queued op survives (a later cycle re-proves)
    await persist.flushed();
    expect(await idbGet("meta", "ledger")).toBeDefined(); // the replica is still there
    expect(await idbGet("meta", "userId")).toBeUndefined(); // …and NOT adopted on a guess
  });

  it("the same replica is pushed once the owner's budget is reattached", async () => {
    outbox.add(catOp());
    session = { user: { id: "user-owner" } };
    serverBudget = BUDGET_B;
    await syncNow("test"); // unproven → refused (above)

    serverBudget = BUDGET_A; // operator reattaches the pre-2.0 budget to the owner account
    await syncNow("test");

    expect(called("/api/sync/push")).toBe(true); // the preserved op finally goes out
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
    expect(reloads).toBe(1); // the re-proof finds the stamp of another account → wipe + reload
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
    e2ee.setDek(new Uint8Array(32));
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
    e2ee.setDek(new Uint8Array(32));
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
    serverBlob = await e2ee.encryptSnapshot(emptyLedger(), dek);
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
    serverBlob = await e2ee.encryptSnapshot(emptyLedger(), dekOfB); // B's checkpoint, B's key
    legacyE2eeReplica(); // …but the replica on this device is A's
    e2ee.setDek(dekOfB); // Unlock / password change under B's session
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
