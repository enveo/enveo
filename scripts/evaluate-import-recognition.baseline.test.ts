import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BASE_REVISION = "864c47f98c27bb7bf238e636b34f89dfa3dcc63c";
setDefaultTimeout(120_000);

let baseRoot = "";
let versionedBaseRoot = "";
const sourceSnapshots: Array<{ cleanup: () => Promise<void> }> = [];
let loadedBaselinePromise: Promise<unknown> | null = null;

const loadBaselineSnapshot = async (evaluator: Record<string, unknown>): Promise<unknown> => {
  loadedBaselinePromise ??= (async () => {
    const preflight = await (evaluator.preflightSource as (mode: "baseline", root: string) => Promise<unknown>)("baseline", versionedBaseRoot);
    const snapshot = (await (evaluator.materializeSourceSnapshot as (preflight: unknown) => Promise<{ cleanup: () => Promise<void> }>)(preflight)) as {
      cleanup: () => Promise<void>;
    };
    sourceSnapshots.push(snapshot);
    return (evaluator.loadSnapshotSource as (mode: "baseline", snapshot: unknown) => Promise<unknown>)("baseline", snapshot);
  })();
  return loadedBaselinePromise;
};

async function linkPackageDependencies(packageName: "api" | "shared", targetRoot = baseRoot): Promise<void> {
  const source = resolve(import.meta.dir, `../packages/${packageName}/node_modules`);
  const target = resolve(targetRoot, `packages/${packageName}/node_modules`);
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (packageName === "api" && entry.name === "@enveo") continue;
    await symlink(await realpath(resolve(source, entry.name)), resolve(target, entry.name));
  }
}

beforeAll(async () => {
  baseRoot = await mkdtemp(resolve(tmpdir(), "enveo-exact-import-base-"));
  const archive = Bun.spawn(["git", "archive", BASE_REVISION], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "ignore" });
  const extract = Bun.spawn(["tar", "-x", "-C", baseRoot], { stdin: archive.stdout, stdout: "ignore", stderr: "ignore" });
  const [archiveExit, extractExit] = await Promise.all([archive.exited, extract.exited]);
  if (archiveExit !== 0 || extractExit !== 0) throw new Error("could not materialize exact baseline revision");
  await linkPackageDependencies("api");
  await linkPackageDependencies("shared");
  await mkdir(resolve(baseRoot, "packages/api/node_modules/@enveo"), { recursive: true });
  await symlink(resolve(baseRoot, "packages/shared"), resolve(baseRoot, "packages/api/node_modules/@enveo/shared"));

  versionedBaseRoot = await mkdtemp(resolve(tmpdir(), "enveo-versioned-import-base-"));
  await rm(versionedBaseRoot, { recursive: true });
  const worktree = Bun.spawn(["git", "worktree", "add", "--detach", versionedBaseRoot, BASE_REVISION], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await worktree.exited) !== 0) throw new Error("could not materialize versioned baseline worktree");
  await linkPackageDependencies("api", versionedBaseRoot);
  await linkPackageDependencies("shared", versionedBaseRoot);
  await mkdir(resolve(versionedBaseRoot, "packages/api/node_modules/@enveo"), { recursive: true });
  await symlink(resolve(versionedBaseRoot, "packages/shared"), resolve(versionedBaseRoot, "packages/api/node_modules/@enveo/shared"));
});

afterAll(async () => {
  for (const snapshot of sourceSnapshots.reverse()) await snapshot.cleanup();
  if (baseRoot) await rm(baseRoot, { recursive: true, force: true });
  if (versionedBaseRoot) {
    const remove = Bun.spawn(["git", "worktree", "remove", "--force", versionedBaseRoot], {
      cwd: resolve(import.meta.dir, ".."),
      stdout: "ignore",
      stderr: "ignore",
    });
    await remove.exited;
  }
});

const extracted = {
  transactions: [
    {
      date: "2026-08-15",
      amount: 1299,
      type: "expense",
      rawPlace: "BLANK PLACE",
      tag: "BLANK",
      currency: "EUR",
      fxOriginal: "",
    },
    {
      date: "2026-08-15",
      amount: 2599,
      type: "expense",
      rawPlace: "SPACE PLACE",
      tag: "SPACE",
      currency: "EUR",
      fxOriginal: "",
    },
  ],
};

const enriched = {
  transactions: [
    { index: 0, name: "Blank history", envelope: "Food", category: "Daily", place: "Blank place" },
    { index: 1, name: "Space history", envelope: "Food", category: "Daily", place: "Space place" },
  ],
};

const context = {
  accountId: "account-a",
  accounts: [
    {
      id: "account-a",
      name: "Checking",
      color: "#000000",
      icon: "wallet",
      type: "checking",
      onBudget: true,
      initialBalance: 0,
      archived: false,
      sort: 0,
      automaticEnvelopeId: null,
    },
  ],
  envelopes: [
    {
      id: "envelope-food",
      groupId: "group-a",
      name: "Food",
      color: "#000000",
      icon: "tag",
      note: null,
      monthlyTarget: null,
      isSavings: false,
      sort: 0,
      archived: false,
    },
  ],
  categories: [{ id: "category-daily", name: "Daily" }],
  transactions: [],
  historyRecords: [
    {
      accountId: "account-a",
      currency: "EUR",
      sourceRef: "",
      tag: "BLANK",
      place: "BLANK PLACE",
      name: "Blank history",
      envelope: "Food",
      category: "Daily",
      type: "expense" as const,
      isRefund: false,
      toAccountId: null,
    },
    {
      accountId: "account-a",
      currency: "EUR",
      sourceRef: "   ",
      tag: "SPACE",
      place: "SPACE PLACE",
      name: "Space history",
      envelope: "Food",
      category: "Daily",
      type: "expense" as const,
      isRefund: false,
      toAccountId: null,
    },
  ],
};

type Request = Record<string, unknown>;

const responseChat =
  (requests: Request[]) =>
  async (request: Request): Promise<string> => {
    requests.push(structuredClone(request));
    return JSON.stringify(requests.length === 1 ? extracted : enriched);
  };

describe("exact legacy production baseline", () => {
  test("treats a snapshot as an opaque immutable capability and invalidates it on cleanup", async () => {
    const evaluator = await import("./evaluate-import-recognition");
    const preflight = await evaluator.preflightSource("baseline", versionedBaseRoot);
    const snapshot = await evaluator.materializeSourceSnapshot(preflight);
    const originalCleanup = snapshot.cleanup.bind(snapshot);
    const genuine = await evaluator.loadSnapshotSource("baseline", snapshot);
    const canonicalRoot = genuine.root;
    const maliciousRoot = await mkdtemp(resolve(tmpdir(), "enveo-forged-import-source-"));
    const sentinel = resolve(maliciousRoot, "sentinel");
    await mkdir(resolve(maliciousRoot, "packages/shared/src"), { recursive: true });
    await writeFile(
      resolve(maliciousRoot, "packages/shared/src/aiPrompts.ts"),
      `await Bun.write(${JSON.stringify(sentinel)}, "imported"); throw new Error("forged root imported");\n`,
    );

    try {
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(() => {
        (snapshot as unknown as { root: string }).root = maliciousRoot;
      }).toThrow();
      expect(() => Object.defineProperty(snapshot, "root", { value: maliciousRoot })).toThrow();
      expect(() => Object.defineProperty(snapshot, "identity", { value: { bound: true } })).toThrow();
      expect(() => Object.defineProperty(snapshot, "cleanup", { value: async () => {} })).toThrow();
      const spread = { ...snapshot } as typeof snapshot;
      await expect(evaluator.loadSnapshotSource("baseline", spread)).rejects.toThrow("verified immutable snapshot");
      await expect(spread.cleanup()).rejects.toThrow("verified immutable snapshot");
      const cloned = Object.create(Object.getPrototypeOf(snapshot), Object.getOwnPropertyDescriptors(snapshot)) as typeof snapshot;
      await expect(evaluator.loadSnapshotSource("baseline", cloned)).rejects.toThrow("verified immutable snapshot");
      await expect(cloned.cleanup()).rejects.toThrow("verified immutable snapshot");
      const proxied = new Proxy(snapshot, {}) as typeof snapshot;
      await expect(evaluator.loadSnapshotSource("baseline", proxied)).rejects.toThrow("verified immutable snapshot");
      await expect(proxied.cleanup()).rejects.toThrow("verified immutable snapshot");

      expect((await evaluator.loadSnapshotSource("baseline", snapshot)).root).toBe(canonicalRoot);
      await expect(access(sentinel)).rejects.toThrow();
      await snapshot.cleanup();
      await snapshot.cleanup();
      await expect(access(canonicalRoot)).rejects.toThrow();
      await expect(evaluator.loadSnapshotSource("baseline", snapshot)).rejects.toThrow("verified immutable snapshot");
      expect(await access(maliciousRoot)).toBeNull();
    } finally {
      await originalCleanup();
      await rm(maliciousRoot, { recursive: true, force: true });
    }
  });

  test("binds only the exact clean accepted baseline revision and module digest", async () => {
    const evaluator = (await import("./evaluate-import-recognition")) as Record<string, unknown>;
    const source = (await loadBaselineSnapshot(evaluator)) as {
      identity: { expectedRevision: string; actualRevision: string; bound: boolean; actualModuleDigest: string; expectedModuleDigest: string };
    };
    expect(source.identity).toMatchObject({ expectedRevision: BASE_REVISION, actualRevision: BASE_REVISION, bound: true });
    expect(source.identity.actualModuleDigest).toBe(source.identity.expectedModuleDigest);
  });

  test("records accepted module bytes but rejects an unversioned archive for release", async () => {
    const evaluator = (await import("./evaluate-import-recognition")) as Record<string, unknown>;
    const source = (await (evaluator.preflightSource as (mode: "baseline", root: string) => Promise<{ identity: unknown }>)("baseline", baseRoot)) as {
      identity: { expectedRevision: string; actualRevision: string; bound: boolean; actualModuleDigest: string; expectedModuleDigest: string };
    };
    expect(source.identity).toMatchObject({
      expectedRevision: BASE_REVISION,
      actualRevision: "unversioned",
      bound: false,
    });
    expect(source.identity.actualModuleDigest).toBe(source.identity.expectedModuleDigest);
  });

  test("rejects an unversioned baseline archive with source drift", async () => {
    const evaluator = (await import("./evaluate-import-recognition")) as Record<string, unknown>;
    const path = resolve(baseRoot, "packages/api/src/routes/import-match.ts");
    const original = await readFile(path);
    try {
      await writeFile(path, Buffer.concat([original, Buffer.from("\n// drift\n")]));
      const source = (await (evaluator.preflightSource as (mode: "baseline", root: string) => Promise<{ identity: unknown }>)("baseline", baseRoot)) as {
        identity: { bound: boolean; expectedModuleDigest: string; actualModuleDigest: string };
      };
      expect(source.identity.bound).toBe(false);
    } finally {
      await writeFile(path, original);
    }
  });

  test("freezes the archived route clock to fixture.today and restores Date", async () => {
    const evaluator = (await import("./evaluate-import-recognition")) as Record<string, unknown>;
    const source = await loadBaselineSnapshot(evaluator);
    const OriginalDate = globalThis.Date;
    const requests: Request[] = [];
    await (evaluator.runBaselineProductionAdapter as (input: Record<string, unknown>) => Promise<unknown>)({
      source,
      fixture: {
        id: "historical-base",
        images: ["fixture.png"],
        locale: "en",
        today: "2020-01-02",
        budgetCurrency: "EUR",
        formFactor: "mobile",
        overlap: false,
        context,
        rows: [],
      },
      images: ["data:image/png;base64,AA=="],
      chat: responseChat(requests),
    });
    expect(JSON.stringify(requests[0])).toContain("2020-01-02");
    expect(globalThis.Date).toBe(OriginalDate);
  });

  test("emits byte-identical cycle requests to the specified base route for blank source references", async () => {
    // Break caught: the evaluator cloned the route's schema without descriptions and
    // treated empty or whitespace-only source_ref values as confident learned matches.
    const evaluator = (await import("./evaluate-import-recognition")) as Record<string, unknown>;
    expect(typeof evaluator.loadSnapshotSource).toBe("function");
    expect(typeof evaluator.runBaselineProductionAdapter).toBe("function");
    const runAdapter = evaluator.runBaselineProductionAdapter as (input: Record<string, unknown>) => Promise<unknown>;

    const source = (await loadBaselineSnapshot(evaluator)) as { root: string };
    const adapterRequests: Request[] = [];
    await runAdapter({
      source,
      fixture: {
        id: "exact-base",
        images: ["fixture.png"],
        locale: "en",
        today: new Date().toISOString().slice(0, 10),
        budgetCurrency: "EUR",
        formFactor: "mobile",
        overlap: false,
        context,
        rows: [],
      },
      images: ["data:image/png;base64,AA=="],
      chat: responseChat(adapterRequests),
    });

    const route = (await import(pathToFileURL(resolve(source.root, "packages/api/src/routes/import.ts")).href)) as {
      extractImportForBudget: (input: Record<string, unknown>) => Promise<unknown>;
    };
    const dbModule = (await import(pathToFileURL(resolve(source.root, "packages/api/src/db/client.ts")).href)) as {
      db: { select: (...args: unknown[]) => unknown };
    };
    const schema = (await import(pathToFileURL(resolve(source.root, "packages/api/src/db/schema.ts")).href)) as Record<string, unknown>;
    const rowsByTable = new Map<unknown, unknown[]>([
      [schema.budgets, [{ currency: "EUR" }]],
      [schema.envelopes, [{ id: "envelope-food", name: "Food", archived: false }]],
      [schema.categories, [{ id: "category-daily", name: "Daily" }]],
      [
        schema.transactions,
        [
          {
            name: "Blank history",
            envelopeId: "envelope-food",
            categoryId: "category-daily",
            placeId: "place-blank",
            tag: "BLANK",
            sourceRef: "",
            type: "expense",
            isRefund: false,
            toAccountId: null,
          },
          {
            name: "Space history",
            envelopeId: "envelope-food",
            categoryId: "category-daily",
            placeId: "place-space",
            tag: "SPACE",
            sourceRef: "   ",
            type: "expense",
            isRefund: false,
            toAccountId: null,
          },
        ],
      ],
      [
        schema.places,
        [
          { id: "place-blank", name: "BLANK PLACE" },
          { id: "place-space", name: "SPACE PLACE" },
        ],
      ],
    ]);
    const originalSelect = dbModule.db.select;
    dbModule.db.select = () => ({
      from: (table: unknown) => ({
        where: async () => {
          const rows = rowsByTable.get(table);
          if (!rows) throw new Error(`unexpected legacy query table ${basename(String(table))}`);
          return structuredClone(rows);
        },
      }),
    });
    const directRequests: Request[] = [];
    try {
      await route.extractImportForBudget({
        budgetId: "exact-base-budget",
        images: ["data:image/png;base64,AA=="],
        locale: "en",
        chat: responseChat(directRequests),
      });
    } finally {
      dbModule.db.select = originalSelect;
    }

    expect(JSON.stringify(adapterRequests)).toBe(JSON.stringify(directRequests));
    expect(adapterRequests).toHaveLength(2);
    const cycleTwo = adapterRequests[1] as {
      messages: Array<{ content: string }>;
      responseFormat: { json_schema: { schema: { properties: { transactions: { items: { properties: Record<string, unknown> } } } } } };
    };
    expect(cycleTwo.responseFormat.json_schema.schema.properties.transactions.items.properties).toEqual({
      index: { type: "integer", description: "Index of the transaction from the input" },
      name: {
        type: "string",
        description: "Short name in the user's language of WHAT it was (e.g. Groceries, Fuel, Cloud fee) — NOT the store name",
      },
      envelope: { type: ["string", "null"], description: "Envelope name from the list or null" },
      category: { type: ["string", "null"], description: "Category name from the list or null" },
      place: { type: ["string", "null"], description: "Readable place name (e.g. Lidl) — an existing one if it matches" },
    });
    const payload = JSON.parse(cycleTwo.messages[1]!.content) as { transactions: Array<{ patterns: Array<{ fromSourceRef: boolean }> }> };
    expect(payload.transactions.map((transaction) => transaction.patterns[0]?.fromSourceRef)).toEqual([false, false]);
  });

  test("serializes fixture DB replacement and restores the exact original query method", async () => {
    // Break caught: overlapping baseline fixtures could replace the same imported DB
    // object's select method and make one fixture query another fixture's history.
    const evaluator = (await import("./evaluate-import-recognition")) as Record<string, unknown>;
    const runAdapter = evaluator.runBaselineProductionAdapter as (input: Record<string, unknown>) => Promise<unknown>;
    const source = (await loadBaselineSnapshot(evaluator)) as Record<string, unknown>;
    const seam = source.baseline as { db: { select: unknown } };
    const originalSelect = seam.db.select;
    let activeFixtures = 0;
    let maxActiveFixtures = 0;
    const chatForFixture = () => {
      let call = 0;
      return async (): Promise<string> => {
        call++;
        if (call === 1) {
          activeFixtures++;
          maxActiveFixtures = Math.max(maxActiveFixtures, activeFixtures);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
          return JSON.stringify(extracted);
        }
        activeFixtures--;
        return JSON.stringify(enriched);
      };
    };
    const fixture = (id: string) => ({
      id,
      images: ["fixture.png"],
      locale: "en",
      today: new Date().toISOString().slice(0, 10),
      budgetCurrency: "EUR",
      formFactor: "mobile",
      overlap: false,
      context,
      rows: [],
    });

    const results = await Promise.allSettled([
      runAdapter({ source, fixture: fixture("concurrent-a"), images: ["data:image/png;base64,AA=="], chat: chatForFixture() }),
      runAdapter({ source, fixture: fixture("concurrent-b"), images: ["data:image/png;base64,AA=="], chat: chatForFixture() }),
    ]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(maxActiveFixtures).toBe(1);
    expect(seam.db.select).toBe(originalSelect);
  });

  test("restores the process clock when the archived route fails", async () => {
    const evaluator = (await import("./evaluate-import-recognition")) as Record<string, unknown>;
    const source = await loadBaselineSnapshot(evaluator);
    const OriginalDate = globalThis.Date;
    await expect(
      (evaluator.runBaselineProductionAdapter as (input: Record<string, unknown>) => Promise<unknown>)({
        source,
        fixture: {
          id: "failing-base",
          images: ["fixture.png"],
          locale: "en",
          today: "2019-12-31",
          budgetCurrency: "EUR",
          formFactor: "mobile",
          overlap: false,
          context,
          rows: [],
        },
        images: ["data:image/png;base64,AA=="],
        chat: async () => {
          throw new Error("forced route failure");
        },
      }),
    ).rejects.toThrow("import_cycle_one_failed");
    expect(globalThis.Date).toBe(OriginalDate);
  });
});
