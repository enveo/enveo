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
import { readdirSync } from "node:fs";
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
  const stamp = inImage(
    image,
    "grep -ho 'sha:\"[0-9a-f]*\"' /app/packages/web/dist/assets/index-*.js | head -1 || true",
  ).trim();
  const buildStampSha = stamp === "" ? null : (stamp.match(/sha:"([0-9a-f]*)"/)?.[1] ?? null);

  return {
    appFiles,
    storeEntries,
    configUser: config.User ?? "",
    effectiveUid,
    appWritable,
    labels: config.Labels ?? {},
    entrypoint: config.Entrypoint ?? [],
    buildStampSha,
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

  const facts = collect(image);
  const violations = checkImage(facts, { migrations, sourceCommit });

  console.log(`image-inventory: ${image}`);
  console.log(`  files under /app        ${facts.appFiles.length}`);
  console.log(`  installed packages      ${facts.storeEntries.length}`);
  console.log(`  migrations expected     ${migrations.length}`);
  console.log(`  user                    ${facts.configUser} (effective uid ${facts.effectiveUid})`);
  console.log(`  /app writable           ${facts.appWritable}`);
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
