/**
 * ONE Bun version for the whole repository (§3e).
 *
 * `.bun-version` is the single source of truth. Four other places name a Bun version and have
 * historically drifted apart: the CI workflow, the weekly audit workflow, the `@types/bun`
 * dependency range and the Docker base image. Drift is not cosmetic — CI's `bun audit --json`
 * parser is written against a KNOWN output shape, the test suites run on the CI runtime, and
 * the image that ships to users must run the runtime the gate actually exercised.
 *
 * Everything here is PURE: callers pass file contents in, so the logic is unit-testable and the
 * repo-wide assertion is one focused test (`bunVersion.test.ts`) that reads the real files.
 *
 * A Bun upgrade is therefore a deliberate one-commit change: bump `.bun-version`, the workflow
 * pins, `@types/bun` and BOTH Dockerfile coordinates (version AND digest) together, then rerun
 * the complete gate. Never float the digest on its own.
 */

/** The single source of truth, relative to the repository root. */
export const BUN_VERSION_FILE = ".bun-version";

/** Exact `MAJOR.MINOR.PATCH` — a range or a floating major is not a pin. */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/** `sha256:` + 64 lowercase hex characters. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** One place that names a Bun version, and what it says. */
export type VersionRef = Readonly<{
  /** File the reference was read from, e.g. `.github/workflows/ci.yml`. */
  file: string;
  /** Human-readable locator, e.g. `BUN_VERSION` or `FROM oven/bun (stage: runtime)`. */
  where: string;
  /** The version as written. */
  version: string;
}>;

/** A reference that disagrees with `.bun-version`. */
export type Drift = Readonly<{
  file: string;
  where: string;
  found: string;
  expected: string;
}>;

/** One `FROM oven/bun:…` line. */
export type BunBase = Readonly<{
  where: string;
  /** The `MAJOR.MINOR.PATCH` part of the tag. */
  version: string;
  /**
   * The image VARIANT — the tag suffix after the version (`alpine`), or `null` for the plain
   * Debian image. Enveo deliberately uses two: Debian for the native build toolchain, Alpine
   * for the pure-JS runtime. One digest per variant, one version across all of them.
   */
  variant: string | null;
  /** `sha256:…`, or `null` when the line carries no digest at all. */
  digest: string | null;
}>;

/** Parse `.bun-version`. Throws on anything that is not an exact version. */
export function parseBunVersionFile(text: string): string {
  const version = text.trim();
  if (!EXACT_VERSION.test(version)) {
    throw new Error(
      `${BUN_VERSION_FILE} must contain one exact Bun version (MAJOR.MINOR.PATCH), got: ${JSON.stringify(text)}`,
    );
  }
  return version;
}

/**
 * Bun versions pinned in a GitHub workflow: the `BUN_VERSION` env value and every literal
 * `bun-version:` input of `oven-sh/setup-bun`. A `${{ … }}` expression is an indirection, not a
 * pin, so it is skipped — the value it points at is checked where it is defined.
 */
export function collectWorkflowBunVersions(file: string, yaml: string): VersionRef[] {
  const refs: VersionRef[] = [];
  const patterns: ReadonlyArray<readonly [RegExp, string]> = [
    [/^\s*BUN_VERSION:\s*(.+?)\s*$/gm, "BUN_VERSION"],
    [/^\s*bun-version:\s*(.+?)\s*$/gm, "bun-version"],
  ];
  for (const [pattern, where] of patterns) {
    for (const match of yaml.matchAll(pattern)) {
      const raw = (match[1] ?? "").replace(/^["']|["']$/g, "").trim();
      if (raw.includes("${{")) continue; // indirection, checked at its definition
      refs.push({ file, where, version: raw });
    }
  }
  return refs;
}

/**
 * Every `FROM oven/bun:…` in a Dockerfile, with its stage name. A line without a digest is
 * reported with `digest: null` so the caller can reject it — `oven/bun:1.3.14` alone is a
 * mutable tag that can be republished. The tag is split into version and variant, because
 * Enveo runs two variants of the SAME version (Debian to build, Alpine to run).
 */
export function collectDockerfileBunBases(text: string): BunBase[] {
  const bases: BunBase[] = [];
  const pattern = /^\s*FROM\s+oven\/bun:([^\s@]+)(?:@(\S+))?(?:\s+AS\s+(\S+))?/gim;
  for (const match of text.matchAll(pattern)) {
    const tag = match[1] ?? "";
    const parts = /^(\d+\.\d+\.\d+)(?:-(.+))?$/.exec(tag);
    bases.push({
      where: `FROM oven/bun:${tag} (stage: ${match[3] ?? "<unnamed>"})`,
      // A tag that is not `MAJOR.MINOR.PATCH[-variant]` keeps its raw text, so the version
      // comparison below reports it instead of silently parsing to something plausible.
      version: parts?.[1] ?? tag,
      variant: parts?.[2] ?? null,
      digest: match[2] ?? null,
    });
  }
  return bases;
}

/**
 * Bun versions named in prose, e.g. "Bun **1.3.14**" or "Bun `1.3.14`". The developer-facing
 * documentation is the third leg of the drift check: a contributor who installs the version the
 * README names must get the version CI and Docker use.
 */
export function collectDocumentedBunVersions(file: string, markdown: string): VersionRef[] {
  const refs: VersionRef[] = [];
  for (const match of markdown.matchAll(/\bBun\s+[*`]{0,2}(\d+\.\d+\.\d+)[*`]{0,2}/g)) {
    refs.push({ file, where: `prose "Bun ${match[1]}"`, version: match[1] ?? "" });
  }
  return refs;
}

/**
 * The `@types/bun` dependency range. Bun's own types ship per release, so a range whose base
 * version is not the pinned runtime means the editor/typechecker describes a different Bun than
 * the one that runs. `^1.3.14` → `1.3.14`.
 */
export function collectTypesBunVersion(file: string, packageJson: string): VersionRef[] {
  const parsed = JSON.parse(packageJson) as {
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const range = parsed.devDependencies?.["@types/bun"] ?? parsed.dependencies?.["@types/bun"];
  if (range === undefined) return [];
  return [{ file, where: "@types/bun", version: range.replace(/^[\^~]/, "").trim() }];
}

/** Every reference that disagrees with the pinned version. Empty array = no drift. */
export function findBunVersionDrift(expected: string, refs: readonly VersionRef[]): Drift[] {
  return refs
    .filter((ref) => ref.version !== expected)
    .map((ref) => ({ file: ref.file, where: ref.where, found: ref.version, expected }));
}

/**
 * Docker bases must all name the pinned VERSION and carry a well-formed digest, and every stage
 * using the SAME variant must use the same digest. Two stages on one variant but different
 * digests would build the app on one image and ship another; different variants are a reviewed
 * decision (Debian builds, Alpine runs) and each is pinned independently.
 */
export function findDockerBaseProblems(expected: string, bases: readonly BunBase[]): string[] {
  const problems: string[] = [];
  if (bases.length === 0) return ["no `FROM oven/bun:…` line found — the Bun base is not pinned"];

  for (const base of bases) {
    if (base.version !== expected) {
      problems.push(`${base.where}: version ${base.version}, expected ${expected}`);
    }
    if (base.digest === null) {
      problems.push(
        `${base.where}: no @sha256 digest — a bare tag is mutable and can be republished`,
      );
    } else if (!DIGEST.test(base.digest)) {
      problems.push(`${base.where}: malformed digest ${base.digest}`);
    }
  }

  const byVariant = new Map<string, Set<string>>();
  for (const base of bases) {
    if (base.digest === null) continue;
    const key = base.variant ?? "<debian>";
    const digests = byVariant.get(key) ?? new Set<string>();
    digests.add(base.digest);
    byVariant.set(key, digests);
  }
  for (const [variant, digests] of byVariant) {
    if (digests.size > 1) {
      problems.push(
        `stages on the ${variant} base disagree on its digest (${[...digests].join(", ")}) — one reviewed image per variant`,
      );
    }
  }
  return problems;
}

/** One-line human summary used by the test failure message. */
export function formatDrift(drift: readonly Drift[]): string {
  return drift
    .map((d) => `  • ${d.file} (${d.where}): ${d.found} — expected ${d.expected}`)
    .join("\n");
}
