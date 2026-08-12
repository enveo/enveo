#!/usr/bin/env bun
/**
 * Prune Bun's isolated store down to the API's real production closure (§3e).
 *
 * Runs INSIDE the Docker `deps` stage, right after
 *   bun install --production --frozen-lockfile --filter '@enveo/api' --filter '@enveo/shared'
 *
 * That install links the right packages into each workspace's `node_modules`, but leaves the
 * store (`node_modules/.bun/`) unpruned: Bun materialises every OPTIONAL PEER that is resolvable
 * in the workspace graph, so better-auth's optional peers drag drizzle-kit, tsx, esbuild, react
 * and react-dom into a "production" install. See `lib/runtimeClosure.ts` for the full reasoning.
 *
 * The graph rules live in that pure module and are unit-tested; this file is only the
 * filesystem adapter plus the deletion. It FAILS CLOSED — a store layout it cannot read, or a
 * closure missing a known runtime package, aborts the image build instead of shipping an API
 * that cannot resolve its own imports.
 *
 *   bun scripts/prune-runtime-deps.ts /app
 */
import { type Dirent, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { closureProblems, computeClosure, deadStoreEntries, type Link, type Manifest, type StoreReader } from "./lib/runtimeClosure";

/** Workspaces the runtime image actually runs. */
const WORKSPACES = ["packages/api", "packages/shared"] as const;

/** If any of these is missing after the walk, the prune is wrong — abort the build. */
const MUST_KEEP = ["hono", "drizzle-orm", "postgres", "better-auth", "zod"] as const;

/**
 * `better-auth@1.6.26+cbc1f5e9` → `better-auth`; `@esbuild+linux-x64@0.28.2` → `@esbuild/linux-x64`.
 * Bun encodes a store entry as `<name>@<version>[+<hash>]` with `/` written as `+` in the scope.
 */
export function packageNameFromStoreId(storeId: string): string {
  const at = storeId.lastIndexOf("@");
  if (at <= 0) throw new Error(`unrecognised store entry: ${storeId}`);
  const name = storeId.slice(0, at);
  return name.startsWith("@") ? name.replace("+", "/") : name;
}

function makeReader(appDir: string): StoreReader {
  const store = resolve(appDir, "node_modules/.bun");

  const readManifest = (packageDir: string, context: string): Manifest => {
    try {
      return JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as Manifest;
    } catch (error) {
      // Fail closed: an unreadable manifest would silently under-report what must be kept.
      throw new Error(`cannot read the manifest of ${context} (${packageDir}): ${String(error)}`);
    }
  };

  const classify = (target: string): Pick<Link, "storeId" | "workspaceDir"> => {
    if (target.startsWith(`${store}/`)) {
      const id = target.slice(store.length + 1).split("/")[0] ?? null;
      return { storeId: id, workspaceDir: null };
    }
    const packages = resolve(appDir, "packages");
    if (target.startsWith(`${packages}/`)) {
      const name = target.slice(packages.length + 1).split("/")[0];
      return { storeId: null, workspaceDir: name ? `${packages}/${name}` : null };
    }
    return { storeId: null, workspaceDir: null };
  };

  const linksIn = (dir: string, prefix = ""): Link[] => {
    const links: Link[] = [];
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return links; // a package with no dependencies has no node_modules directory
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) {
        links.push({
          name: `${prefix}${entry.name}`,
          ...classify(resolve(dir, readlinkSync(full))),
        });
      } else if (entry.isDirectory() && entry.name.startsWith("@") && prefix === "") {
        links.push(...linksIn(full, `${entry.name}/`));
      }
    }
    return links;
  };

  return {
    linksIn: (dir) => linksIn(dir),
    manifestOfStoreEntry: (storeId) => readManifest(`${store}/${storeId}/node_modules/${packageNameFromStoreId(storeId)}`, storeId),
    manifestOfWorkspace: (dir) => readManifest(dir, dir),
    nodeModulesOfStoreEntry: (storeId) => `${store}/${storeId}/node_modules`,
    nodeModulesOfWorkspace: (dir) => `${dir}/node_modules`,
  };
}

function main(argv: readonly string[]): number {
  const appDir = resolve(argv[0] ?? "/app");
  const store = resolve(appDir, "node_modules/.bun");

  if (!statSync(store, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`prune-runtime-deps: no isolated store at ${store} — is this a Bun install?`);
    return 1;
  }

  const reader = makeReader(appDir);
  const roots = WORKSPACES.map((w) => resolve(appDir, w));
  const closure = computeClosure(reader, roots);

  const problems = closureProblems(closure, MUST_KEEP);
  if (problems.length > 0) {
    console.error("prune-runtime-deps: refusing to prune —");
    for (const problem of problems) console.error(`  • ${problem}`);
    return 1;
  }

  const dead = deadStoreEntries(readdirSync(store), closure);
  for (const id of dead) rmSync(`${store}/${id}`, { recursive: true, force: true });

  console.log(`prune-runtime-deps: kept ${closure.keep.size} store entries, removed ${dead.length}`);
  if (dead.length > 0) console.log(`  removed: ${dead.join(" ")}`);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
