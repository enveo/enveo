#!/usr/bin/env bun
/**
 * Inventory a BUILT Enveo image and evaluate it against the runtime contract (§3e).
 *
 *   bun scripts/image-inventory.ts enveo:candidate                  # allowlist + non-root only
 *   bun scripts/image-inventory.ts enveo:candidate --sha 1a2b3c4     # also check release metadata
 *
 * Why a separate command instead of a `bun test` case: the rules need a built image, and
 * `bun run test` must stay offline and Docker-free. The RULES are unit-tested in
 * `lib/imageInventory.test.ts`; this file only collects facts and reports.
 *
 * Every fact is read from the image itself — `docker inspect` for configuration, and commands
 * run INSIDE a throwaway container for the filesystem and the effective uid. Nothing here
 * inspects the Dockerfile: "the Dockerfile looks fine" is not evidence.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkImage, type ImageFacts } from "./lib/imageInventory";

const EXIT_VIOLATIONS = 1;
const EXIT_USAGE = 2;

/** Run a command, returning stdout. Throws with stderr attached on a non-zero exit. */
function run(argv: readonly string[]): string {
  const result = Bun.spawnSync([...argv], { stdio: ["ignore", "pipe", "pipe"] });
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed (${result.exitCode}): ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

/** Run a shell command inside a throwaway container built from the image under test. */
const inImage = (image: string, script: string): string =>
  run(["docker", "run", "--rm", "--network=none", "--entrypoint", "/bin/sh", image, "-c", script]);

/**
 * Run JavaScript with the image's OWN Bun. Used for the ELF sweep: the runtime base is Alpine,
 * where `file` is a busybox applet and `od`-per-file would be thousands of spawns. Bun is the
 * one tool guaranteed present on every Enveo image, whatever the base.
 */
const bunInImage = (image: string, source: string): string =>
  run(["docker", "run", "--rm", "--network=none", "--entrypoint", "bun", image, "-e", source]);

/**
 * Every file under /app starting with the ELF magic (`\x7fELF`). Symlinks are not followed —
 * the isolated store is a symlink forest and each real file is visited exactly once through its
 * store path.
 */
const ELF_SWEEP = `
const { readdirSync, openSync, readSync, closeSync } = require("node:fs");
const magic = Buffer.alloc(4);
const found = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = dir + "/" + entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { walk(path); continue; }
    if (!entry.isFile()) continue;
    let fd;
    try { fd = openSync(path, "r"); } catch { continue; }
    const read = readSync(fd, magic, 0, 4, 0);
    closeSync(fd);
    if (read === 4 && magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46) {
      found.push(path.slice("/app/".length));
    }
  }
};
walk("/app");
console.log(found.join("\\n"));
`;

/**
 * Every bare import specifier in the shipped `src` trees that the image cannot resolve.
 *
 * Uses `Bun.resolveSync` from INSIDE the image, so it answers the only question that matters:
 * would this module load here? Only `node:`/`bun:` builtins are skipped.
 *
 * BARE specifiers catch a module importing a dev dependency the production prune removed — the
 * name-independent backstop to the `*.test*` denylist, and what would have caught
 * `test-helpers.ts` (`import fc from "fast-check"`) under any name.
 *
 * RELATIVE specifiers catch the opposite mistake: EXCLUDING a file that a shipped module still
 * imports. Widening `.dockerignore` is exactly how that happens, so the two rules guard each
 * other — neither the allowlist (a handful of required files) nor the denylist would notice.
 */
const IMPORT_SWEEP = `
const { readdirSync, readFileSync } = require("node:fs");
const { dirname } = require("node:path");
const roots = ["/app/packages/api/src", "/app/packages/shared/src"];
const files = [];
const walk = (dir) => {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = dir + "/" + entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && /\\.tsx?$/.test(entry.name)) files.push(path);
  }
};
for (const root of roots) walk(root);

const problems = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const specifiers = new Set();
  for (const m of source.matchAll(/(?:^|[\\s;])(?:import|export)[^'"\\n]*?from\\s*['"]([^'"]+)['"]/g)) specifiers.add(m[1]);
  for (const m of source.matchAll(/(?:^|[\\s;])import\\s*['"]([^'"]+)['"]/g)) specifiers.add(m[1]);
  for (const m of source.matchAll(/\\brequire\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)/g)) specifiers.add(m[1]);
  for (const specifier of specifiers) {
    if (specifier.startsWith("node:") || specifier.startsWith("bun:")) continue;
    try { Bun.resolveSync(specifier, dirname(file)); }
    catch { problems.push(file.slice("/app/".length) + " -> " + specifier); }
  }
}
console.log(problems.join("\\n"));
`;

function collect(image: string): ImageFacts {
  const config = JSON.parse(
    run(["docker", "image", "inspect", image, "--format", "{{json .Config}}"]),
  ) as { User?: string; Labels?: Record<string, string>; Entrypoint?: string[] };

  const lines = (text: string): string[] =>
    text.split("\n").map((l) => l.trim()).filter((l) => l !== "");

  const appFiles = lines(inImage(image, "cd /app && find . -type f | sed 's|^\\./||'"));
  const storeEntries = lines(
    inImage(image, "ls /app/node_modules/.bun 2>/dev/null | grep -v '^node_modules$' || true"),
  );

  // `|| true` so an expected failure (a read-only /app) is a clean "no", not a crashed probe.
  const appWritable =
    inImage(image, "touch /app/.write-probe 2>/dev/null && echo WRITABLE || echo READONLY").includes(
      "WRITABLE",
    );

  const effectiveUid = Number(inImage(image, "id -u").trim());

  // The web build stamp: vite inlines __BUILD_INFO__ as `{time:"…",sha:"…"}` into the entry chunk.
  // Deliberately `[^"]*` and not `[0-9a-f]*`: a real commit SHA is hex, but matching only hex
  // means a WRONG value (or a build arg that never reached the bundle) reads back as "no stamp
  // found" and gets reported as absent instead of as a mismatch. Extract whatever is there and
  // let the comparison do the judging.
  const stamp = inImage(
    image,
    "grep -ho 'sha:\"[^\"]*\"' /app/packages/web/dist/assets/index-*.js | head -1 || true",
  ).trim();
  const buildStampSha = stamp === "" ? null : (stamp.match(/sha:"([^"]*)"/)?.[1] ?? null);

  // Recorded for the audit trail, not judged (see ImageFacts.osPackages). `apk upgrade` in the
  // runtime stage is intentionally unpinned, so this is where the resulting patch level becomes
  // visible instead of implicit.
  const osPackages = lines(inImage(image, "apk info -v 2>/dev/null | sort || true"));

  const nativeBinaries = lines(bunInImage(image, ELF_SWEEP));
  const unresolvableImports = lines(bunInImage(image, IMPORT_SWEEP));
  const bunVersion = run(["docker", "run", "--rm", "--network=none", "--entrypoint", "bun", image, "--version"]).trim();

  return {
    unresolvableImports,
    bunVersion,
    osPackages,
    appFiles,
    storeEntries,
    configUser: config.User ?? "",
    effectiveUid,
    appWritable,
    labels: config.Labels ?? {},
    entrypoint: config.Entrypoint ?? [],
    buildStampSha,
    nativeBinaries,
  };
}

function main(argv: readonly string[]): number {
  const image = argv[0];
  if (image === undefined || image.startsWith("-")) {
    console.error("usage: bun scripts/image-inventory.ts <image-ref> [--sha <source-commit>]");
    return EXIT_USAGE;
  }
  const shaFlag = argv.indexOf("--sha");
  const sourceCommit = shaFlag === -1 ? null : (argv[shaFlag + 1] ?? null);

  // The expected migration set comes from the REPOSITORY, so a migration added but not copied
  // into the image fails here rather than at a customer's first container start.
  const migrations = readdirSync(join(import.meta.dir, "..", "packages", "api", "drizzle"))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  // `.bun-version` is the repository's single source of truth; the image must AGREE with it,
  // which is what binds the pinned base digest to the version its tag claims.
  const bunVersion = readFileSync(join(import.meta.dir, "..", ".bun-version"), "utf8").trim();

  const facts = collect(image);
  const violations = checkImage(facts, { migrations, sourceCommit, bunVersion });

  console.log(`image-inventory: ${image}`);
  console.log(`  files under /app        ${facts.appFiles.length}`);
  console.log(`  installed packages      ${facts.storeEntries.length}`);
  console.log(`  migrations expected     ${migrations.length}`);
  console.log(`  bun in image            ${facts.bunVersion} (.bun-version pins ${bunVersion})`);
  // The OpenSSL pair is called out by name because it is why the runtime stage upgrades at all
  // (CVE-2026-45447); the full list follows so any OS drift is legible in the same output.
  const openssl = facts.osPackages.filter((pkg) => /^lib(ssl|crypto)\d/.test(pkg));
  console.log(`  OS packages             ${facts.osPackages.length}${openssl.length === 0 ? "" : ` (${openssl.join(", ")})`}`);
  console.log(`  unresolvable imports    ${facts.unresolvableImports.length} (must be 0)`);
  console.log(`  user                    ${facts.configUser} (effective uid ${facts.effectiveUid})`);
  console.log(`  /app writable           ${facts.appWritable}`);
  console.log(`  native ELF binaries     ${facts.nativeBinaries.length} (must be 0)`);
  console.log(`  entrypoint              ${facts.entrypoint.join(" ")}`);
  console.log(`  build stamp sha         ${facts.buildStampSha ?? "<none>"}`);
  console.log(`  OCI revision            ${facts.labels["org.opencontainers.image.revision"] || "<none>"}`);

  if (violations.length > 0) {
    console.error(`\nimage-inventory: ${violations.length} violation(s):`);
    for (const violation of violations) console.error(`  • ${violation}`);
    return EXIT_VIOLATIONS;
  }
  console.log("\nimage-inventory: OK — runtime allowlist satisfied, no dev/build packages present");
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
