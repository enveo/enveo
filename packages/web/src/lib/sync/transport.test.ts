/**
 * REQUEST-SHAPE assertions for every sync wire call (workflow §3c-3, checkpoint 4).
 *
 * Written BEFORE the transport extraction and kept after it: each still-valid v1 plain and
 * v2 E2EE endpoint is asserted on URL, method, content-type and the EXACT top-level body key
 * ORDER (JSON.parse preserves serialization order, so a re-ordered literal — a byte-level
 * change on the wire — fails here even though the server would accept it). Driven through the
 * public facade, so the assertions hold for the code path the app actually runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ClientLedger, SyncOp } from "@enveo/shared";
import { generateDek } from "../crypto";
import * as e2ee from "../e2ee";
import { clearLocalData, idbPut } from "../idb";
import * as outbox from "../outbox";
import * as persist from "../persist";
import { store } from "../store";
import {
  __resetBackoff,
  __resetIdentity,
  __resetObligations,
  __setLocalMode,
  fetchSnapshot,
  pushLocalToServer,
  resetServerE2ee,
  syncNow,
  upgradeServerE2eeV2,
} from "../sync";

const BUDGET_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

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

interface Recorded {
  url: string;
  method: string;
  contentType: string | undefined;
  body: string | undefined;
}

let requests: Recorded[] = [];
let session: { user: { id: string } } | null = null;
let serverEpoch = 1;
const realFetch = globalThis.fetch;
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const req = (prefix: string): Recorded | undefined => requests.find((r) => r.url.startsWith(prefix));
const bodyOf = (r: Recorded | undefined): Record<string, unknown> => JSON.parse(r?.body ?? "{}") as Record<string, unknown>;

beforeEach(async () => {
  requests = [];
  session = { user: { id: "user-A" } };
  serverEpoch = 1;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      method: init?.method ?? "GET",
      contentType: headers.get("content-type") ?? undefined,
      body: init?.body === undefined ? undefined : String(init.body),
    });
    if (url.startsWith("/api/auth/get-session")) return json(session);
    if (url.startsWith("/api/sync2/snapshot")) {
      return json({ budgetId: BUDGET_A, epoch: serverEpoch, wrappedDek: null, kdfParams: null, uptoSeq: 0, blob: null });
    }
    if (url.startsWith("/api/sync2/push")) return json({ cursor: 1, epoch: serverEpoch });
    if (url.startsWith("/api/sync2/pull")) return json({ cursor: 0, epoch: serverEpoch, ops: [] });
    if (url.startsWith("/api/sync2/reset")) return json({ epoch: serverEpoch, uptoSeq: 0 });
    if (url.startsWith("/api/budget/e2ee/upgrade-v2")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { expectedEpoch: number };
      serverEpoch = body.expectedEpoch + 1;
      return json({ budgetId: BUDGET_A, epoch: serverEpoch, cipherVersion: 2, uptoSeq: 0 });
    }
    if (url.startsWith("/api/sync/push")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { ops: SyncOp[] };
      return json({ budgetId: BUDGET_A, results: body.ops.map((o) => ({ opId: o.opId, status: "applied" })) });
    }
    if (url.startsWith("/api/sync/snapshot")) return json({ budgetId: BUDGET_A, cursor: 0, ...emptyLedger() });
    if (url.startsWith("/api/sync/pull")) return json({ budgetId: BUDGET_A, cursor: 0, resetRequired: false, changes: [] });
    if (url.startsWith("/api/sync/replace")) return json({ budgetId: BUDGET_A, cursor: 1 });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  __resetIdentity();
  __resetObligations();
  __resetBackoff();
  __setLocalMode("off");
  outbox.clearAll();
  e2ee.__resetDekForTests();
  e2ee.clearDek();
  e2ee.resetOpsCounter();
  e2ee.setTierMeta({ tier: "plain", epoch: 0 });
  e2ee.setCipherVersion(2);
  await clearLocalData();
  store.replace(emptyLedger(), 0, BUDGET_A);
  store.setBootStatus("ready");
  await idbPut("meta", "user-A", "userId"); // stamped: identity resolves without a proof probe
  void persist.persistLedger(store.snapshotForPersist());
  await persist.flushed();
});

afterEach(() => {
  __resetBackoff();
  globalThis.fetch = realFetch;
});

describe("wire shapes: v1 plain endpoints", () => {
  it("POST /api/sync/push — exact body key order {clientId, budgetId, ops}; pull follows push", async () => {
    const op = catOp();
    outbox.add(op);

    await syncNow("shape");

    const push = req("/api/sync/push");
    expect(push).toBeDefined();
    expect(push!.method).toBe("POST");
    expect(push!.contentType).toBe("application/json");
    const body = bodyOf(push);
    expect(Object.keys(body)).toEqual(["clientId", "budgetId", "ops"]);
    expect(typeof body.clientId).toBe("string");
    expect(body.budgetId).toBe(BUDGET_A);
    const ops = body.ops as Array<Record<string, unknown>>;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.opId).toBe(op.opId);
    expect(ops[0]!.kind).toBe("category.create");
    // push-before-pull order on the same cycle
    const pushIdx = requests.findIndex((r) => r.url.startsWith("/api/sync/push"));
    const pullIdx = requests.findIndex((r) => r.url.startsWith("/api/sync/pull"));
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(pullIdx).toBeGreaterThan(pushIdx);
  });

  it("GET /api/sync/pull — since carries the replica cursor, no body", async () => {
    await syncNow("shape");

    const pull = req("/api/sync/pull");
    expect(pull).toBeDefined();
    expect(pull!.url).toBe("/api/sync/pull?since=0");
    expect(pull!.method).toBe("GET");
    expect(pull!.body).toBeUndefined();
  });

  it("GET /api/sync/snapshot — no body", async () => {
    await fetchSnapshot();

    const snap = req("/api/sync/snapshot");
    expect(snap).toBeDefined();
    expect(snap!.method).toBe("GET");
    expect(snap!.body).toBeUndefined();
  });

  it("POST /api/sync/replace — exact body key order {ledger, userId}; userId is the verified session", async () => {
    await pushLocalToServer();

    const replace = req("/api/sync/replace");
    expect(replace).toBeDefined();
    expect(replace!.method).toBe("POST");
    expect(replace!.contentType).toBe("application/json");
    const body = bodyOf(replace);
    expect(Object.keys(body)).toEqual(["ledger", "userId"]);
    expect(body.userId).toBe("user-A");
    expect(Object.keys(body.ledger as Record<string, unknown>).sort()).toEqual([
      "accounts",
      "allocations",
      "budgets",
      "categories",
      "envelopes",
      "groups",
      "places",
      "transactions",
    ]);
  });
});

describe("wire shapes: v2 E2EE endpoints", () => {
  const dek = generateDek();
  const e2eeReplica = () => {
    e2ee.setTierMeta({ tier: "e2ee", epoch: 1 });
    e2ee.setDek(dek, 1); // validated for the fixture's epoch
  };

  it("POST /api/sync2/push — exact body key order {epoch, budgetId, ops}; v2 ciphertext rows", async () => {
    e2eeReplica();
    const op = catOp();
    outbox.add(op);

    await syncNow("shape");

    const push = req("/api/sync2/push");
    expect(push).toBeDefined();
    expect(push!.method).toBe("POST");
    expect(push!.contentType).toBe("application/json");
    const body = bodyOf(push);
    expect(Object.keys(body)).toEqual(["epoch", "budgetId", "ops"]);
    expect(body.epoch).toBe(1);
    expect(body.budgetId).toBe(BUDGET_A);
    const ops = body.ops as Array<Record<string, unknown>>;
    expect(ops).toHaveLength(1);
    expect(Object.keys(ops[0]!).sort()).toEqual(["ciphertext", "opId"]);
    expect(ops[0]!.opId).toBe(op.opId);
    expect(String(ops[0]!.ciphertext).startsWith("v2.")).toBe(true);
  });

  it("GET /api/sync2/pull — since + epoch in the query, no body; push precedes pull", async () => {
    e2eeReplica();
    outbox.add(catOp());

    await syncNow("shape");

    const pull = req("/api/sync2/pull");
    expect(pull).toBeDefined();
    expect(pull!.url).toBe("/api/sync2/pull?since=0&epoch=1");
    expect(pull!.method).toBe("GET");
    expect(pull!.body).toBeUndefined();
    const pushIdx = requests.findIndex((r) => r.url.startsWith("/api/sync2/push"));
    const pullIdx = requests.findIndex((r) => r.url.startsWith("/api/sync2/pull"));
    expect(pullIdx).toBeGreaterThan(pushIdx);
  });

  it("GET /api/sync2/snapshot — the identity/bootstrap read carries no body", async () => {
    e2eeReplica();
    await clearLocalData(); // no owner stamp → the cycle's proof reads the v2 snapshot
    store.replace(emptyLedger(), 0, BUDGET_A);
    void persist.persistLedger(store.snapshotForPersist());
    await persist.flushed();

    await syncNow("shape");

    const snap = req("/api/sync2/snapshot");
    expect(snap).toBeDefined();
    expect(snap!.method).toBe("GET");
    expect(snap!.body).toBeUndefined();
  });

  it("POST /api/sync2/reset — exact body key order {epoch, uptoCursor, snapshotBlob, userId}", async () => {
    e2eeReplica();

    await resetServerE2ee();

    const reset = req("/api/sync2/reset");
    expect(reset).toBeDefined();
    expect(reset!.method).toBe("POST");
    expect(reset!.contentType).toBe("application/json");
    const body = bodyOf(reset);
    expect(Object.keys(body)).toEqual(["epoch", "uptoCursor", "snapshotBlob", "userId"]);
    expect(body.epoch).toBe(1);
    expect(body.uptoCursor).toBe(0);
    expect(String(body.snapshotBlob).startsWith("v2.")).toBe(true);
    expect(body.userId).toBe("user-A");
  });

  it("POST /api/budget/e2ee/upgrade-v2 — exact body key order and cipherVersion 2", async () => {
    e2eeReplica();
    e2ee.setCipherVersion(1); // a legacy budget awaiting the ceremony

    await upgradeServerE2eeV2("ceremony-pass-123");

    const up = req("/api/budget/e2ee/upgrade-v2");
    expect(up).toBeDefined();
    expect(up!.method).toBe("POST");
    expect(up!.contentType).toBe("application/json");
    const body = bodyOf(up);
    expect(Object.keys(body)).toEqual(["budgetId", "userId", "expectedEpoch", "cipherVersion", "wrappedDek", "kdfParams", "snapshotBlob"]);
    expect(body.budgetId).toBe(BUDGET_A);
    expect(body.userId).toBe("user-A");
    expect(body.expectedEpoch).toBe(1);
    expect(body.cipherVersion).toBe(2);
    expect(String(body.snapshotBlob).startsWith("v2.")).toBe(true);
    expect(typeof body.wrappedDek).toBe("string");
    expect(typeof body.kdfParams).toBe("string");
  });
});
