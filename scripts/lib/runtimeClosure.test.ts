/**
 * Pure tests for the runtime dependency closure (§3e).
 *
 * The fixture below is a miniature of the real problem: `@enveo/api` depends on `better-auth`,
 * which declares `drizzle-kit` and `react` as OPTIONAL peers and `drizzle-orm` as an optional
 * peer that the API itself depends on directly. The walk must drop the first two and keep the
 * third — otherwise a "production" image ships a build toolchain.
 */
import { describe, expect, it } from "bun:test";
import { closureProblems, computeClosure, deadStoreEntries, type Link, type Manifest, requiredSpecifiers, type StoreReader } from "./runtimeClosure";

// ── A synthetic store, shaped like `node_modules/.bun` ──────────────────────────────────────

const WORKSPACE: Record<string, Manifest> = {
  "/app/packages/api": { dependencies: { "better-auth": "*", "drizzle-orm": "*", "@enveo/shared": "*" } },
  "/app/packages/shared": { dependencies: { zod: "*" } },
};

const STORE: Record<string, Manifest> = {
  "better-auth@1.6.26": {
    dependencies: { jose: "*" },
    peerDependencies: { "drizzle-kit": "*", "drizzle-orm": "*", react: "*", kysely: "*" },
    peerDependenciesMeta: {
      "drizzle-kit": { optional: true },
      "drizzle-orm": { optional: true },
      react: { optional: true },
      // kysely deliberately NOT optional — a required peer must survive the prune
    },
  },
  "drizzle-orm@0.45.2": {},
  "jose@6.2.8": {},
  "kysely@0.29.5": {},
  "zod@3.25.76": {},
  "drizzle-kit@0.31.10": { dependencies: { esbuild: "*" } },
  "esbuild@0.25.12": {},
  "react@18.3.1": {},
};

/** Every symlink Bun actually creates, INCLUDING the optional peers we want dropped. */
const LINKS: Record<string, Link[]> = {
  "/app/packages/api/node_modules": [
    { name: "better-auth", storeId: "better-auth@1.6.26", workspaceDir: null },
    { name: "drizzle-orm", storeId: "drizzle-orm@0.45.2", workspaceDir: null },
    { name: "@enveo/shared", storeId: null, workspaceDir: "/app/packages/shared" },
  ],
  "/app/packages/shared/node_modules": [{ name: "zod", storeId: "zod@3.25.76", workspaceDir: null }],
  "/store/better-auth@1.6.26/node_modules": [
    { name: "jose", storeId: "jose@6.2.8", workspaceDir: null },
    { name: "kysely", storeId: "kysely@0.29.5", workspaceDir: null },
    { name: "drizzle-kit", storeId: "drizzle-kit@0.31.10", workspaceDir: null },
    { name: "drizzle-orm", storeId: "drizzle-orm@0.45.2", workspaceDir: null },
    { name: "react", storeId: "react@18.3.1", workspaceDir: null },
  ],
  "/store/drizzle-kit@0.31.10/node_modules": [{ name: "esbuild", storeId: "esbuild@0.25.12", workspaceDir: null }],
};

const reader: StoreReader = {
  linksIn: (dir) => LINKS[dir] ?? [],
  manifestOfStoreEntry: (id) => STORE[id] ?? {},
  manifestOfWorkspace: (dir) => WORKSPACE[dir] ?? {},
  nodeModulesOfStoreEntry: (id) => `/store/${id}/node_modules`,
  nodeModulesOfWorkspace: (dir) => `${dir}/node_modules`,
};

const ROOTS = ["/app/packages/api", "/app/packages/shared"];

// ── Tests ───────────────────────────────────────────────────────────────────────────────────

describe("requiredSpecifiers", () => {
  it("includes dependencies and optionalDependencies", () => {
    const manifest: Manifest = { dependencies: { a: "*" }, optionalDependencies: { b: "*" } };

    expect([...requiredSpecifiers(manifest)].sort()).toEqual(["a", "b"]);
  });

  it("keeps a peer with no meta entry — undeclared means required", () => {
    expect([...requiredSpecifiers({ peerDependencies: { kysely: "*" } })]).toEqual(["kysely"]);
  });

  it("drops a peer explicitly marked optional", () => {
    const manifest: Manifest = {
      peerDependencies: { react: "*", kysely: "*" },
      peerDependenciesMeta: { react: { optional: true } },
    };

    expect([...requiredSpecifiers(manifest)]).toEqual(["kysely"]);
  });
});

describe("computeClosure", () => {
  const closure = computeClosure(reader, ROOTS);

  it("keeps the API's own dependency graph", () => {
    expect([...closure.keep].sort()).toEqual(["better-auth@1.6.26", "drizzle-orm@0.45.2", "jose@6.2.8", "kysely@0.29.5", "zod@3.25.76"]);
  });

  it("drops the optional peers that only exist because of dev/web workspaces", () => {
    expect(closure.keep.has("drizzle-kit@0.31.10")).toBe(false);
    expect(closure.keep.has("react@18.3.1")).toBe(false);
  });

  it("drops a transitive dependency of a dropped optional peer", () => {
    expect(closure.keep.has("esbuild@0.25.12")).toBe(false);
  });

  it("keeps an optional peer that a workspace package depends on DIRECTLY", () => {
    // drizzle-orm is optional for better-auth but a hard dependency of @enveo/api.
    expect(closure.keep.has("drizzle-orm@0.45.2")).toBe(true);
  });

  it("keeps a NON-optional peer of a kept package", () => {
    expect(closure.keep.has("kysely@0.29.5")).toBe(true);
  });

  it("follows workspace links, so a sibling package's own dependencies survive", () => {
    // zod is reachable only through @enveo/api → @enveo/shared → zod.
    expect(closure.reachedVia.get("zod@3.25.76")).toBe("/app/packages/shared → zod");
  });

  it("terminates on a dependency cycle", () => {
    const cyclic = computeClosure(
      {
        ...reader,
        linksIn: (dir) =>
          dir === "/store/a@1/node_modules"
            ? [{ name: "b", storeId: "b@1", workspaceDir: null }]
            : dir === "/store/b@1/node_modules"
              ? [{ name: "a", storeId: "a@1", workspaceDir: null }]
              : dir === "/app/packages/api/node_modules"
                ? [{ name: "a", storeId: "a@1", workspaceDir: null }]
                : [],
        manifestOfStoreEntry: (id): Manifest => (id === "a@1" ? { dependencies: { b: "*" } } : { dependencies: { a: "*" } }),
        manifestOfWorkspace: () => ({ dependencies: { a: "*" } }),
      },
      ["/app/packages/api"],
    );

    expect([...cyclic.keep].sort()).toEqual(["a@1", "b@1"]);
  });
});

describe("deadStoreEntries", () => {
  it("lists everything the walk never reached", () => {
    const dead = deadStoreEntries(Object.keys(STORE), computeClosure(reader, ROOTS));

    expect(dead).toEqual(["drizzle-kit@0.31.10", "esbuild@0.25.12", "react@18.3.1"]);
  });

  it("never proposes Bun's own bookkeeping directory for removal", () => {
    const dead = deadStoreEntries(["node_modules", "react@18.3.1"], computeClosure(reader, ROOTS));

    expect(dead).toEqual(["react@18.3.1"]);
  });
});

describe("closureProblems", () => {
  it("passes when every named runtime package survived", () => {
    expect(closureProblems(computeClosure(reader, ROOTS), ["better-auth", "drizzle-orm"])).toEqual([]);
  });

  it("fails loudly on an empty closure rather than shipping an unresolvable image", () => {
    const empty = computeClosure({ ...reader, linksIn: () => [] }, ROOTS);

    expect(closureProblems(empty, [])).toHaveLength(1);
    expect(closureProblems(empty, [])[0]).toContain("EMPTY");
  });

  it("names a required runtime package that the walk lost", () => {
    expect(closureProblems(computeClosure(reader, ROOTS), ["hono"])[0]).toContain("hono");
  });
});
