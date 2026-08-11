#!/usr/bin/env bun
/**
 * Release gate, registry side (§3d): ask the REGISTRY what is actually there.
 *
 *   bun scripts/release-image.ts probe  --image ghcr.io/enveo/enveo --tag 3.8.0 \
 *        --revision <sha> --version 3.8.0 --platforms linux/amd64,linux/arm64
 *   bun scripts/release-image.ts verify --image ghcr.io/enveo/enveo --digest sha256:… \
 *        --revision <sha> --version 3.8.0 --platforms linux/amd64,linux/arm64 --attestations
 *
 * `probe` decides whether the exact SemVer tag already exists, and is what makes a manual re-run
 * idempotent instead of destructive:
 *
 *   absent                                  → build and publish it
 *   present, identity matches the tag SHA   → resume WITHOUT rebuilding (exit 0, state=present)
 *   present, identity differs               → STOP for investigation (exit 1)
 *   registry error                          → STOP (exit 3) — never mistaken for "absent"
 *
 * That last line is the one with teeth. Vite stamps a build time into the bundle, so rebuilding
 * the same source produces a DIFFERENT digest; if a 401 or a timeout read as "absent", a re-run
 * would push a new digest over an already-released immutable tag.
 *
 * `verify` is the post-push gate: the artifact users will pull carries both runnable platforms,
 * the right identity labels, and (once attestations are required) provenance and an SBOM for
 * EVERY platform. The rules are pure and unit-tested in `lib/releaseImage.ts`; this file only
 * collects facts and reports.
 */
import { appendFileSync } from "node:fs";
import {
  checkAttachment,
  checkAttestationCoverage,
  checkLabels,
  classifyInspectFailure,
  runnablePlatforms,
  type ImageIndex,
} from "./lib/releaseImage";

const EXIT_VIOLATIONS = 1;
const EXIT_USAGE = 2;
const EXIT_REGISTRY_ERROR = 3;

type Run = Readonly<{ code: number; stdout: string; stderr: string }>;

function inspect(reference: string, format?: string): Run {
  const argv = ["docker", "buildx", "imagetools", "inspect", reference];
  argv.push(...(format === undefined ? ["--raw"] : ["--format", format]));
  const result = Bun.spawnSync(argv, { stdio: ["ignore", "pipe", "pipe"] });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString().trim(),
  };
}

function parse<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`the registry returned an unparseable ${what}: ${text.slice(0, 200)}`);
  }
}

function fail(message: string): void {
  console.error(`::error::release-image: ${message}`);
}

function report(title: string, violations: readonly string[]): boolean {
  if (violations.length === 0) {
    console.log(`  ✓ ${title}`);
    return true;
  }
  console.error(`  ✗ ${title}`);
  for (const violation of violations) console.error(`      • ${violation}`);
  return false;
}

function emit(outputs: Readonly<Record<string, string>>): void {
  const path = process.env["GITHUB_OUTPUT"];
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  for (const line of lines) console.log(`  ${line}`);
  if (path !== undefined && path !== "") appendFileSync(path, `${lines.join("\n")}\n`);
}

type Options = Readonly<{
  image: string;
  platforms: string[];
  revision: string;
  version: string;
  source: string;
}>;

/** Identity + platform checks, shared by `probe` (existing tag) and `verify` (pushed digest). */
function checkIdentity(reference: string, options: Options): string[] {
  const violations: string[] = [];

  const raw = inspect(reference);
  if (raw.code !== 0) throw new Error(`inspect ${reference} failed: ${raw.stderr}`);
  const index = parse<ImageIndex>(raw.stdout, "image index");

  const platforms = runnablePlatforms(index);
  const expected = [...options.platforms].sort().join(",");
  const found = [...platforms].sort().join(",");
  if (found !== expected) {
    violations.push(`runnable platforms are [${found}], expected [${expected}]`);
  }
  report(`runnable platforms: ${found || "<none>"}`, violations.slice(0, 1));

  const image = inspect(reference, "{{json .Image}}");
  if (image.code !== 0) throw new Error(`inspect ${reference} config failed: ${image.stderr}`);
  const labelViolations = checkLabels(parse<unknown>(image.stdout, "image config"), {
    platforms: options.platforms,
    revision: options.revision,
    version: options.version,
    source: options.source,
  });
  report(
    `OCI identity: revision=${options.revision} version=${options.version} source=${options.source}`,
    labelViolations,
  );
  violations.push(...labelViolations);

  return violations;
}

function probe(reference: string, options: Options): number {
  console.log(`release-image probe: ${reference}`);

  const raw = inspect(reference);
  if (raw.code !== 0) {
    if (classifyInspectFailure(raw.stderr) === "absent") {
      console.log("  the exact tag does not exist yet — this release must BUILD it");
      emit({ state: "absent", digest: "" });
      return 0;
    }
    fail(
      `cannot determine whether ${reference} exists: ${raw.stderr}\n` +
        "Refusing to continue: an unresolved registry answer must never be read as \"absent\", " +
        "because that would rebuild and overwrite an already-released immutable tag.",
    );
    return EXIT_REGISTRY_ERROR;
  }

  console.log("  the exact tag ALREADY exists — checking that it is the artifact this tag means");
  const violations = checkIdentity(reference, options);
  if (violations.length > 0) {
    fail(
      `${reference} exists but does not match this release. STOP and investigate — an exact ` +
        "SemVer tag is never overwritten automatically; a genuinely broken image is replaced by " +
        "a new patch version.",
    );
    return EXIT_VIOLATIONS;
  }

  const manifest = inspect(reference, "{{json .Manifest}}");
  const digest = parse<{ digest?: string }>(manifest.stdout, "manifest descriptor").digest ?? "";
  console.log("  identity matches — resuming without rebuilding");
  emit({ state: "present", digest });
  return 0;
}

function verify(reference: string, options: Options, attestations: boolean): number {
  console.log(`release-image verify: ${reference}`);

  const violations = checkIdentity(reference, options);

  if (attestations) {
    const raw = inspect(reference);
    const index = parse<ImageIndex>(raw.stdout, "image index");
    const coverage = checkAttestationCoverage(index);
    report("every runnable platform has an attestation manifest", coverage);
    violations.push(...coverage);

    for (const [what, format] of [
      ["SBOM", "{{json .SBOM}}"],
      ["provenance", "{{json .Provenance}}"],
    ] as const) {
      const result = inspect(reference, format);
      if (result.code !== 0) {
        violations.push(`cannot read ${what}: ${result.stderr}`);
        continue;
      }
      const missing = checkAttachment(what, parse<unknown>(result.stdout, what), options.platforms);
      report(`${what} attached for every platform`, missing);
      violations.push(...missing);
    }
  }

  if (violations.length > 0) {
    fail(`${violations.length} violation(s) on the published artifact — the release stops here`);
    return EXIT_VIOLATIONS;
  }
  console.log("\nrelease-image: OK — the published artifact is the one this tag means");
  return 0;
}

function main(argv: readonly string[]): number {
  const mode = argv[0];
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };

  const image = flag("image");
  const revision = flag("revision");
  const version = flag("version");
  if ((mode !== "probe" && mode !== "verify") || image === undefined || revision === undefined || version === undefined) {
    console.error(
      "usage:\n" +
        "  bun scripts/release-image.ts probe  --image <repo> --tag <exact> --revision <sha> --version <v> [--platforms a,b]\n" +
        "  bun scripts/release-image.ts verify --image <repo> --digest <sha256:…> --revision <sha> --version <v> [--platforms a,b] [--attestations]",
    );
    return EXIT_USAGE;
  }

  const options: Options = {
    image,
    revision,
    version,
    platforms: (flag("platforms") ?? "linux/amd64,linux/arm64").split(",").filter((p) => p !== ""),
    source: flag("source") ?? `https://github.com/${process.env["GITHUB_REPOSITORY"] ?? ""}`,
  };

  try {
    if (mode === "probe") {
      const tag = flag("tag");
      if (tag === undefined) {
        console.error("probe needs --tag");
        return EXIT_USAGE;
      }
      return probe(`${image}:${tag}`, options);
    }
    const digest = flag("digest");
    if (digest === undefined) {
      console.error("verify needs --digest");
      return EXIT_USAGE;
    }
    return verify(`${image}@${digest}`, options, argv.includes("--attestations"));
  } catch (error) {
    // Any unexpected registry/parse failure is a FAILED check, never a pass.
    fail(error instanceof Error ? error.message : String(error));
    return EXIT_REGISTRY_ERROR;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
