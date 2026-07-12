/**
 * Sync engine — multi-tenant + re-auth guard (mandatory accounts).
 *
 * Two invariants, both about what happens BEFORE the outbox is pushed:
 *  - a 401 (expired/revoked session) must reach the LOGIN screen (BootStatus "unauthed"),
 *    not just a muted badge — otherwise the outbox grows forever with no way to sign in,
 *  - a replica belonging to ANOTHER account must never have its queued ops pushed into the
 *    signed-in user's budget (the server applies fresh creates happily — the FK guards only
 *    reject references to another budget's EXISTING rows).
 *
 * Under bun there is no window/indexedDB, so idb.ts runs in its in-memory mode and sync.ts
 * installs no triggers — the cycle can be driven directly with syncNow().
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ClientLedger, SyncOp } from "@enveo/shared";
import { clearLocalData, idbGet, idbPut } from "./idb";
import * as outbox from "./outbox";
import * as persist from "./persist";
import { store } from "./store";
import { __resetIdentity, decideIdentity, pushLocalToServer, syncNow } from "./sync";

const BUDGET_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

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

/* ── Server + browser stubs ───────────────────────────────────────────── */

let calls: string[] = [];
let session: { user: { id: string } } | null = null;
let reloads = 0;
const realFetch = globalThis.fetch;
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  calls = [];
  reloads = 0;
  session = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("/api/auth/get-session")) return json(session); // 200 + `null` = no session
    if (url.startsWith("/api/sync/push")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { ops: SyncOp[] };
      return json({
        budgetId: BUDGET_A,
        results: body.ops.map((o) => ({ opId: o.opId, status: "applied" })),
      });
    }
    if (url.startsWith("/api/sync/pull")) {
      return json({ budgetId: BUDGET_A, cursor: 0, resetRequired: false, changes: [] });
    }
    if (url.startsWith("/api/sync/replace")) return json({ budgetId: BUDGET_A, cursor: 1 });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  (globalThis as { location?: { reload: () => void } }).location = {
    reload: () => {
      reloads++;
    },
  };

  __resetIdentity();
  outbox.clearAll();
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
  it("same user → ok; no stamp yet → ok (adopted)", () => {
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

    expect(calls.some((u) => u.startsWith("/api/auth/get-session"))).toBe(true);
    expect(calls.some((u) => u.startsWith("/api/sync/push"))).toBe(false);
    expect(store.getBootStatus()).toBe("unauthed"); // App renders LoginScreen
    expect(outbox.size()).toBe(1); // the queued op survives the re-auth
  });

  it("a DIFFERENT account signed in → no push at all; the foreign replica is wiped", async () => {
    await idbPut("meta", "user-A", "userId"); // the replica belongs to user A
    outbox.add(catOp()); // …and carries A's unsent op
    session = { user: { id: "user-B" } }; // …but user B is signed in now

    await syncNow("test");

    expect(calls.some((u) => u.startsWith("/api/sync/push"))).toBe(false); // A's op NEVER reaches B's budget
    expect(reloads).toBe(1); // wiped + reloading → clean bootstrap for B
    expect(await idbGet("meta", "ledger")).toBeUndefined(); // A's replica gone from IDB
    expect(await idbGet("meta", "userId")).toBeUndefined();
    expect(outbox.size()).toBe(0);
  });

  it("same account → the cycle runs and the owner stamp is (re)written", async () => {
    await idbPut("meta", "user-A", "userId");
    const op = catOp();
    outbox.add(op);
    session = { user: { id: "user-A" } };

    await syncNow("test");

    expect(calls.some((u) => u.startsWith("/api/sync/push"))).toBe(true);
    expect(outbox.size()).toBe(0); // applied → acked
    await persist.flushed();
    expect(await idbGet<string>("meta", "userId")).toBe("user-A");
    expect(store.getBootStatus()).toBe("ready");
  });

  it("server replace outside a cycle (disable local mode) is guarded too", async () => {
    await idbPut("meta", "user-A", "userId");
    session = { user: { id: "user-B" } };

    await expect(pushLocalToServer()).rejects.toThrow(); // aborted, not applied to B's budget
    expect(calls.some((u) => u.startsWith("/api/sync/replace"))).toBe(false);
    expect(reloads).toBe(1);
  });

  it("replica with no owner stamp → adopted by the session user before pushing", async () => {
    outbox.add(catOp());
    session = { user: { id: "user-C" } };

    await syncNow("test");

    expect(calls.some((u) => u.startsWith("/api/sync/push"))).toBe(true);
    await persist.flushed();
    expect(await idbGet<string>("meta", "userId")).toBe("user-C");
  });
});
