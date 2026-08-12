/**
 * The production dependency closure of the runtime image (§3e).
 *
 * WHY THIS EXISTS. `bun install --production --frozen-lockfile --filter '@enveo/api' --filter
 * '@enveo/shared'` links exactly the right packages into each workspace's `node_modules`, but the
 * isolated store underneath (`node_modules/.bun/`) is NOT pruned: Bun links every OPTIONAL PEER
 * that happens to be resolvable in the workspace graph. `better-auth` declares react, react-dom,
 * drizzle-kit, prisma, mongodb and vitest as optional peers (`peerDependenciesMeta[x].optional`),
 * and they are resolvable here because `@enveo/api` devDepends on drizzle-kit and `@enveo/web`
 * depends on react. The result: drizzle-kit, tsx and three copies of esbuild inside a "production"
 * install — precisely the packages §3e requires to be absent.
 *
 * WHAT THIS DOES. Walk the real link graph from the two workspace roots, following only links a
 * package actually REQUIRES — `dependencies`, `optionalDependencies` and NON-optional
 * `peerDependencies`. Everything in the store the walk never reaches is dead weight and is
 * deleted. Omitting an optional peer is the contract of `optional: true`: the dependent must
 * guard its use. `drizzle-orm` is also one of better-auth's optional peers, but it is a DIRECT
 * dependency of `@enveo/api`, so the walk reaches it from there and keeps it.
 *
 * This module is pure — the filesystem arrives through the injected `StoreReader` — so the graph
 * rules are unit-tested against a synthetic store with no Docker in the loop.
 */

/** The parts of a package manifest that decide what must be resolvable at runtime. */
export type Manifest = Readonly<{
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean } | undefined>;
}>;

/** One symlink inside a `node_modules` directory. */
export type Link = Readonly<{
  /** Specifier as imported, e.g. `hono` or `@enveo/shared`. */
  name: string;
  /** Store entry the link resolves to, e.g. `hono@4.13.1`, or `null` for a workspace link. */
  storeId: string | null;
  /** Absolute path of a workspace package the link resolves to, when `storeId` is `null`. */
  workspaceDir: string | null;
}>;

export type StoreReader = Readonly<{
  /** Symlinks directly inside `dir` (scoped directories flattened into `@scope/name`). */
  linksIn: (dir: string) => Link[];
  /** Manifest of the package a store entry contains. */
  manifestOfStoreEntry: (storeId: string) => Manifest;
  /** Manifest of a workspace package directory. */
  manifestOfWorkspace: (dir: string) => Manifest;
  /** `node_modules` directory of a store entry. */
  nodeModulesOfStoreEntry: (storeId: string) => string;
  /** `node_modules` directory of a workspace package. */
  nodeModulesOfWorkspace: (dir: string) => string;
}>;

export type Closure = Readonly<{
  /** Store entries reachable through required links. */
  keep: ReadonlySet<string>;
  /** Reason the walk first reached each kept entry — for a readable build log. */
  reachedVia: ReadonlyMap<string, string>;
}>;

/**
 * Specifiers a package must be able to resolve. An optional peer is deliberately excluded: by
 * declaring it optional the dependent promises to work without it.
 */
export function requiredSpecifiers(manifest: Manifest): Set<string> {
  const required = new Set<string>([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]);
  for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
    if (manifest.peerDependenciesMeta?.[peer]?.optional !== true) required.add(peer);
  }
  return required;
}

/** Walk the required-link graph from the given workspace roots. */
export function computeClosure(reader: StoreReader, workspaceRoots: readonly string[]): Closure {
  const keep = new Set<string>();
  const reachedVia = new Map<string, string>();
  const visitedDirs = new Set<string>();

  type Frame = Readonly<{ nodeModules: string; required: Set<string>; label: string }>;
  const queue: Frame[] = workspaceRoots.map((dir) => ({
    nodeModules: reader.nodeModulesOfWorkspace(dir),
    required: requiredSpecifiers(reader.manifestOfWorkspace(dir)),
    label: dir,
  }));

  while (queue.length > 0) {
    const frame = queue.shift();
    if (frame === undefined) break;
    if (visitedDirs.has(frame.nodeModules)) continue;
    visitedDirs.add(frame.nodeModules);

    for (const link of reader.linksIn(frame.nodeModules)) {
      if (!frame.required.has(link.name)) continue;

      if (link.storeId !== null) {
        if (keep.has(link.storeId)) continue;
        keep.add(link.storeId);
        reachedVia.set(link.storeId, `${frame.label} → ${link.name}`);
        queue.push({
          nodeModules: reader.nodeModulesOfStoreEntry(link.storeId),
          required: requiredSpecifiers(reader.manifestOfStoreEntry(link.storeId)),
          label: link.storeId,
        });
      } else if (link.workspaceDir !== null) {
        queue.push({
          nodeModules: reader.nodeModulesOfWorkspace(link.workspaceDir),
          required: requiredSpecifiers(reader.manifestOfWorkspace(link.workspaceDir)),
          label: link.workspaceDir,
        });
      }
    }
  }

  return { keep, reachedVia };
}

/**
 * Store entries the walk did not reach. `.bun/node_modules` is Bun's own bookkeeping directory,
 * not a package, and is never a removal candidate.
 */
export function deadStoreEntries(allEntries: readonly string[], closure: Closure): string[] {
  return allEntries.filter((id) => id !== "node_modules" && !closure.keep.has(id)).sort();
}

/**
 * Sanity gate on the computed closure. A prune that removes everything (a bad root path, a
 * renamed store layout) must fail the build loudly rather than ship an image whose API cannot
 * resolve its own dependencies.
 */
export function closureProblems(closure: Closure, mustKeep: readonly string[]): string[] {
  const problems: string[] = [];
  if (closure.keep.size === 0) {
    return ["computed closure is EMPTY — the workspace roots or the store layout are wrong"];
  }
  for (const name of mustKeep) {
    const found = [...closure.keep].some((id) => id === name || id.startsWith(`${name}@`));
    if (!found) problems.push(`required runtime package missing from the closure: ${name}`);
  }
  return problems;
}
