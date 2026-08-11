/**
 * The runtime image contract (§3e), as executable rules.
 *
 * §3e's acceptance criterion is explicit: prove the allowlist and the absence of the dev tree
 * "in the resulting image", not by reading the Dockerfile. A Dockerfile can look minimal and
 * still ship a build toolchain — that is exactly how `bun install --production --filter` behaves
 * (see `runtimeClosure.ts`). So the rules below are evaluated against facts COLLECTED FROM A
 * BUILT IMAGE by `scripts/image-inventory.ts`.
 *
 * Pure on purpose: `imageInventory.test.ts` runs these rules against synthetic facts inside
 * `bun run test` (no Docker, no network), and the CLI supplies real ones in CI.
 */

/** Everything the checker knows about a built image. */
export type ImageFacts = Readonly<{
  /** Every regular file under `/app`, relative to `/app`. */
  appFiles: readonly string[];
  /** Entry names of `node_modules/.bun` — Bun's isolated store. */
  storeEntries: readonly string[];
  /** `docker inspect .Config.User`. */
  configUser: string;
  /** `id -u` executed inside the running container. */
  effectiveUid: number;
  /** Whether the runtime user can create a file inside `/app`. */
  appWritable: boolean;
  /** `docker inspect .Config.Labels`. */
  labels: Readonly<Record<string, string>>;
  /** `docker inspect .Config.Entrypoint`. */
  entrypoint: readonly string[];
  /** The `sha` baked into the web bundle's build stamp, or `null` if it could not be read. */
  buildStampSha: string | null;
  /**
   * Files under `/app` whose first four bytes are the ELF magic — i.e. native executables or
   * shared objects. MUST be empty: the build stage runs on Debian/glibc and the runtime on
   * Alpine/musl, and that is only safe because nothing native crosses the boundary.
   */
  nativeBinaries: readonly string[];
  /**
   * Shipped source modules with an import the image cannot resolve, as `file → specifier`.
   * NAME-INDEPENDENT backstop for the rule above: a denylist only catches files someone named
   * according to the convention, while this catches any shipped module that cannot actually
   * load — which is the property that matters. It is what would have caught
   * `test-helpers.ts` (`import fc from "fast-check"`) whatever it had been called.
   */
  unresolvableImports: readonly string[];
  /**
   * `bun --version` executed INSIDE the image. Binds the pinned base DIGEST to the version it
   * claims: every other check compares text against text, so a Bun bump that pastes a stale or
   * wrong-tag digest leaves `.bun-version`, CI, `@types/bun`, the docs and both `FROM` tags all
   * reading the same version, the whole gate green, and the shipped image running a different
   * Bun than `verify:ci` exercised and than the audit parser was written against.
   */
  bunVersion: string;
  /**
   * Every OS package installed in the image, as `name-version` (`apk info -v`), sorted.
   *
   * RECORDED, not judged: no rule below reads it. The runtime stage runs `apk upgrade`, which
   * deliberately carries no version pin — Alpine's repository keeps only the CURRENT build of a
   * package per branch, so pinning would break the build on Alpine's release schedule rather
   * than ours. That makes the OS patch level of two builds of the same commit potentially
   * different, and this is what turns that difference from invisible into a line in the audit
   * trail. The vulnerability gate itself is `bun run image:scan`, which fails closed.
   */
  osPackages: readonly string[];
}>;

/** Repository-derived expectations the image is measured against. */
export type Expectations = Readonly<{
  /** Every `*.sql` file in `packages/api/drizzle` — the migration tree must arrive COMPLETE. */
  migrations: readonly string[];
  /** The SHA passed as `--build-arg SOURCE_COMMIT`, or `null` when the build passed none. */
  sourceCommit: string | null;
  /** The contents of `.bun-version` — what the image's own `bun --version` must report. */
  bunVersion: string;
}>;

/** Files without which the container cannot do its job. */
const REQUIRED_FILES: ReadonlyArray<readonly [string, string]> = [
  ["packages/api/src/index.ts", "the API entry point"],
  ["packages/api/src/db/migrate.ts", "the startup migrator"],
  ["packages/shared/src/index.ts", "the shared domain package"],
  ["packages/api/drizzle/meta/_journal.json", "the migration journal (migration ORDER comes from it)"],
  ["packages/web/dist/index.html", "the SPA shell"],
  ["packages/web/dist/sw.js", "the PWA service worker"],
  ["packages/web/dist/manifest.webmanifest", "the PWA manifest"],
  ["package.json", "the root manifest (workspace resolution)"],
  ["packages/api/package.json", "the API manifest"],
  ["packages/shared/package.json", "the shared manifest"],
];

/**
 * Whole directories that must not exist in the image. Source of the frontend, tests, docs and
 * repository metadata are not runtime inputs; shipping them is attack surface and scanner noise.
 */
const FORBIDDEN_PATHS: ReadonlyArray<readonly [RegExp, string]> = [
  // `.test.` (suites) AND `.test-` (support modules, spawned children). One rule, because the
  // repository convention is "a test-only module inside a shipped src/ tree has `.test` in its
  // basename". Matching only `*.test.ts` is how `test-helpers.ts`, `testSupport.ts` and five
  // `*-child.ts` DB drivers shipped to users — including one that imports `fast-check`, which
  // the production prune removes, so it could never load.
  [/(^|\/)[^/]+\.test[.-][^/]*$/, "test file / test-support module"],
  [/^packages\/web\/src\//, "web source (only the built dist is a runtime input)"],
  [/^packages\/web\/(scripts|public)\//, "web build tooling"],
  [/^packages\/api\/drizzle\.config\.ts$/, "drizzle-kit configuration (the CLI is not installed)"],
  [/^(docs|security|\.github|\.agent|\.git)\//, "repository metadata"],
  [/^scripts\//, "repository tooling"],
  [/^(README|CONTRIBUTING|CLAUDE|AGENTS|SECURITY|CODE_OF_CONDUCT)\.md$/, "documentation"],
  [/^(Dockerfile|Makefile|docker-compose\.yml|compose\.selfhost\.yml|bun\.lock)$/, "build inputs"],
  [/(^|\/)\.env/, "environment file"],
  [/^packages\/web\/dist\/.*\.map$/, "source map"],
];

/**
 * Packages that must NOT be installed. Every one of these reached the old image through
 * `COPY --from=build /app /app`; drizzle-kit, esbuild, tsx and react additionally survive a
 * naive `bun install --production --filter` as optional peers of better-auth.
 */
const FORBIDDEN_PACKAGES = [
  "vite",
  "vite-plugin-pwa",
  "typescript",
  "drizzle-kit",
  "fast-check",
  "esbuild",
  "rollup",
  "sharp",
  "react",
  "react-dom",
  "tsx",
  "vitest",
  "@types/react",
  "@types/node",
  "bun-types",
  "@vitejs/plugin-react",
  "fake-indexeddb",
] as const;

/** Packages the API imports directly — their absence would be a broken prune, not a lean image. */
const REQUIRED_PACKAGES = ["hono", "drizzle-orm", "postgres", "better-auth", "zod"] as const;

/**
 * `better-auth@1.6.26+cbc1f5e9` → `better-auth`; `@esbuild+linux-x64@0.28.2` → `@esbuild/linux-x64`.
 * Bun writes a store entry as `<name>@<version>[+<hash>]`, with `/` in a scope written as `+`.
 */
export function packageNameOfStoreEntry(storeEntry: string): string {
  const at = storeEntry.lastIndexOf("@");
  if (at <= 0) return storeEntry;
  const name = storeEntry.slice(0, at);
  return name.startsWith("@") ? name.replace("+", "/") : name;
}

/** Every rule the image breaks. An empty array is the pass condition. */
export function checkImage(facts: ImageFacts, expectations: Expectations): string[] {
  const violations: string[] = [];
  const files = new Set(facts.appFiles);

  // ── allowlist: what must be there ───────────────────────────────────────────────────────
  for (const [path, why] of REQUIRED_FILES) {
    if (!files.has(path)) violations.push(`missing ${path} — ${why}`);
  }
  for (const migration of expectations.migrations) {
    if (!files.has(`packages/api/drizzle/${migration}`)) {
      violations.push(`missing migration packages/api/drizzle/${migration}`);
    }
  }

  const installed = new Set(facts.storeEntries.map(packageNameOfStoreEntry));
  for (const name of REQUIRED_PACKAGES) {
    if (!installed.has(name)) violations.push(`required runtime package not installed: ${name}`);
  }

  // ── denylist: what must NOT be there ────────────────────────────────────────────────────
  //
  // Scoped to ENVEO's own tree. What a third-party package ships inside its own tarball is not
  // ours to shape — zod, for instance, publishes its `src/**/tests/*.test.ts`. The lever for
  // dependency content is WHICH PACKAGES ARE INSTALLED, checked right below; applying the path
  // rules to `node_modules/` would only produce noise nobody can act on.
  for (const file of facts.appFiles) {
    if (file.startsWith("node_modules/")) continue;
    for (const [pattern, why] of FORBIDDEN_PATHS) {
      if (pattern.test(file)) violations.push(`forbidden file in the image: ${file} (${why})`);
    }
  }
  for (const name of FORBIDDEN_PACKAGES) {
    if (installed.has(name)) {
      const entry = facts.storeEntries.find((e) => packageNameOfStoreEntry(e) === name);
      violations.push(`dev/build package present in the runtime image: ${entry ?? name}`);
    }
  }

  // ── nothing native crossed the stage boundary ───────────────────────────────────────────
  //
  // The load-bearing check for the two-base build. `deps`/`runtime` are Alpine (musl) while
  // `build` is Debian (glibc); a native `.node` addon or ELF helper copied forward from the
  // build stage — or pulled in by a future dependency — would be linked against the wrong libc
  // and fail at require() time, possibly only on a code path nobody smoke-tests. An empty set
  // is what makes mixing the bases legitimate, so it is asserted, not assumed.
  for (const binary of facts.nativeBinaries) {
    violations.push(
      `native ELF binary in the runtime image: ${binary} — the runtime closure must stay pure JavaScript ` +
        `(build stage is glibc, runtime is musl)`,
    );
  }

  // ── every shipped module can actually load ──────────────────────────────────────────────
  for (const problem of facts.unresolvableImports) {
    violations.push(`shipped module has an import the image cannot resolve: ${problem}`);
  }

  // ── the pinned digest really is the pinned version ──────────────────────────────────────
  if (facts.bunVersion !== expectations.bunVersion) {
    violations.push(
      `image runs Bun ${facts.bunVersion}, but .bun-version pins ${expectations.bunVersion} — ` +
        `the base digest does not match the version it claims`,
    );
  }

  // ── the container runs unprivileged ─────────────────────────────────────────────────────
  if (facts.configUser === "" || facts.configUser === "root" || facts.configUser === "0") {
    violations.push(`image runs as root (Config.User = ${JSON.stringify(facts.configUser)})`);
  }
  if (facts.effectiveUid === 0) violations.push("effective uid inside the container is 0 (root)");
  if (facts.appWritable) {
    violations.push("/app is writable by the runtime user — application files must be read-only");
  }
  if (facts.entrypoint.length === 0) {
    violations.push("no ENTRYPOINT — migrate→start ordering would depend on the caller");
  }

  // ── release metadata ────────────────────────────────────────────────────────────────────
  const revision = facts.labels["org.opencontainers.image.revision"] ?? "";
  const source = facts.labels["org.opencontainers.image.source"] ?? "";
  if (source === "") violations.push("missing OCI label org.opencontainers.image.source");
  if (expectations.sourceCommit !== null) {
    if (revision !== expectations.sourceCommit) {
      violations.push(
        `OCI revision label is ${JSON.stringify(revision)}, expected ${JSON.stringify(expectations.sourceCommit)}`,
      );
    }
    if (facts.buildStampSha !== expectations.sourceCommit) {
      violations.push(
        `web build stamp sha is ${JSON.stringify(facts.buildStampSha)}, expected ${JSON.stringify(expectations.sourceCommit)}`,
      );
    }
  }

  return violations;
}
