import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BASE_REVISION = "864c47f98c27bb7bf238e636b34f89dfa3dcc63c";

let baseRoot = "";

async function linkPackageDependencies(packageName: "api" | "shared"): Promise<void> {
  const source = resolve(import.meta.dir, `../packages/${packageName}/node_modules`);
  const target = resolve(baseRoot, `packages/${packageName}/node_modules`);
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (packageName === "api" && entry.name === "@enveo") continue;
    await symlink(await realpath(resolve(source, entry.name)), resolve(target, entry.name));
  }
}

beforeAll(async () => {
  baseRoot = await mkdtemp(resolve(tmpdir(), "enveo-exact-import-base-"));
  const archive = Bun.spawn(["git", "archive", BASE_REVISION], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const extract = Bun.spawn(["tar", "-x", "-C", baseRoot], { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" });
  const [archiveExit, extractExit] = await Promise.all([archive.exited, extract.exited]);
  if (archiveExit !== 0 || extractExit !== 0) throw new Error("could not materialize exact baseline revision");
  await linkPackageDependencies("api");
  await linkPackageDependencies("shared");
  await mkdir(resolve(baseRoot, "packages/api/node_modules/@enveo"), { recursive: true });
  await symlink(resolve(baseRoot, "packages/shared"), resolve(baseRoot, "packages/api/node_modules/@enveo/shared"));
});

afterAll(async () => {
  if (baseRoot) await rm(baseRoot, { recursive: true, force: true });
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
  test("emits byte-identical cycle requests to the specified base route for blank source references", async () => {
    // Break caught: the evaluator cloned the route's schema without descriptions and
    // treated empty or whitespace-only source_ref values as confident learned matches.
    const evaluator = (await import("./evaluate-import-recognition")) as Record<string, unknown>;
    expect(typeof evaluator.loadSource).toBe("function");
    expect(typeof evaluator.runBaselineProductionAdapter).toBe("function");
    const loadSource = evaluator.loadSource as (mode: "baseline", sourceTree: string) => Promise<unknown>;
    const runAdapter = evaluator.runBaselineProductionAdapter as (input: Record<string, unknown>) => Promise<unknown>;

    const source = await loadSource("baseline", baseRoot);
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

    const route = (await import(pathToFileURL(resolve(baseRoot, "packages/api/src/routes/import.ts")).href)) as {
      extractImportForBudget: (input: Record<string, unknown>) => Promise<unknown>;
    };
    const dbModule = (await import(pathToFileURL(resolve(baseRoot, "packages/api/src/db/client.ts")).href)) as {
      db: { select: (...args: unknown[]) => unknown };
    };
    const schema = (await import(pathToFileURL(resolve(baseRoot, "packages/api/src/db/schema.ts")).href)) as Record<string, unknown>;
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
    const loadSource = evaluator.loadSource as (mode: "baseline", sourceTree: string) => Promise<Record<string, unknown>>;
    const runAdapter = evaluator.runBaselineProductionAdapter as (input: Record<string, unknown>) => Promise<unknown>;
    const source = await loadSource("baseline", baseRoot);
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
});
