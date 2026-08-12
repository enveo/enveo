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
  checkAnnotations,
  checkAttachment,
  checkAttestationCoverage,
  checkLabels,
  classifyInspectFailure,
  runnableManifests,
  runnablePlatforms,
  type AnnotationSource,
  type ImageIndex,
} from "./lib/releaseImage";
import { parseReleaseTag, planAliasMoves, type AliasState } from "./lib/releaseVersion";

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
  report(`OCI identity labels: revision=${options.revision} version=${options.version} source=${options.source}`, labelViolations);
  violations.push(...labelViolations);

  // ANNOTATIONS, separately from labels — they live on the index/manifest rather than in the
  // config blob, they are what registries and supply-chain tooling read without pulling the
  // config, and metadata-action derives them from github.sha unless told otherwise. A published
  // image whose config says one commit and whose manifest says another is exactly the bug this
  // catches; reading only the label kept passing while the published metadata lied.
  const base = reference.split("@")[0] ?? reference;
  const sources: AnnotationSource[] = [{ where: "index", annotations: index.annotations }];
  for (const manifest of runnableManifests(index)) {
    const raw = inspect(`${base}@${manifest.digest}`);
    if (raw.code !== 0) {
      violations.push(`${manifest.platform}: cannot read its manifest: ${raw.stderr}`);
      continue;
    }
    sources.push({
      where: manifest.platform,
      annotations: parse<{ annotations?: Record<string, string> }>(raw.stdout, "manifest").annotations,
    });
  }
  const annotationViolations = checkAnnotations(sources, {
    revision: options.revision,
    version: options.version,
  });
  report(`OCI annotations on the index and every platform manifest`, annotationViolations);
  violations.push(...annotationViolations);

  return violations;
}

/**
 * Decide which mutable aliases this release may take over, and emit the list to move.
 *
 * Reads what each alias CURRENTLY serves from its own OCI metadata rather than assuming this
 * release is the newest thing that ever pointed there. Aliases only move forward: a legitimate
 * re-run of an older tag (to finish a GitHub Release, say) must not drag `latest` backwards.
 *
 * A skip is reported, not fatal — the rest of the resume is real work.
 */
function aliasPlan(image: string, version: string, aliases: readonly string[]): number {
  const verdict = parseReleaseTag(`v${version}`);
  if (!verdict.ok) {
    fail(`cannot parse the release version ${JSON.stringify(version)}: ${verdict.reason}`);
    return EXIT_VIOLATIONS;
  }

  const states: AliasState[] = aliases.map((alias) => {
    const raw = inspect(`${image}:${alias}`, "{{json .Image}}");
    if (raw.code !== 0) {
      if (classifyInspectFailure(raw.stderr) === "absent") {
        return { alias, present: false, version: null };
      }
      // A registry error is NOT "absent": treating it as such would move the alias blindly.
      throw new Error(`cannot read what ${image}:${alias} currently serves: ${raw.stderr}`);
    }
    return { alias, present: true, version: versionLabelOf(parse<unknown>(raw.stdout, "image config")) };
  });

  const decisions = planAliasMoves(verdict.release, states);
  console.log(`release-image alias-plan: ${image} → ${version}`);
  for (const decision of decisions) {
    const mark = decision.action === "move" ? "→" : decision.action === "noop" ? "=" : "✗";
    console.log(`  ${mark} ${decision.action.toUpperCase().padEnd(4)} ${decision.reason}`);
  }

  const move = decisions.filter((d) => d.action === "move").map((d) => d.alias);
  const skipped = decisions.filter((d) => d.action === "skip");
  if (skipped.length > 0) {
    // Visible in the log AND in the job summary — a silently skipped alias is how somebody
    // later concludes the pipeline is broken.
    for (const decision of skipped) console.log(`::warning::alias not moved — ${decision.reason}`);
  }
  emit({ move: move.join(","), skipped: skipped.map((d) => d.alias).join(",") });
  return 0;
}

/** The version an already-published image says it is, from any platform's labels. */
function versionLabelOf(imageJson: unknown): string | null {
  const root = (imageJson ?? {}) as Record<string, unknown>;
  const entries = "config" in root ? [root] : Object.values(root);
  for (const entry of entries) {
    const labels = ((entry as Record<string, unknown> | null)?.["config"] as { Labels?: Record<string, string> } | undefined)?.Labels;
    const version = labels?.["org.opencontainers.image.version"];
    if (version !== undefined && version !== "") return version;
  }
  return null;
}

/** Print `platform<TAB>manifest-digest` per runnable platform, for the per-arch inventory. */
function platforms(reference: string): number {
  const raw = inspect(reference);
  if (raw.code !== 0) {
    fail(`inspect ${reference} failed: ${raw.stderr}`);
    return EXIT_REGISTRY_ERROR;
  }
  const manifests = runnableManifests(parse<ImageIndex>(raw.stdout, "image index"));
  if (manifests.length === 0) {
    fail(`${reference} has no runnable platform manifests`);
    return EXIT_VIOLATIONS;
  }
  for (const manifest of manifests) console.log(`${manifest.platform}\t${manifest.digest}`);
  return 0;
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
        'Refusing to continue: an unresolved registry answer must never be read as "absent", ' +
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

  if (mode === "alias-plan") {
    const aliases = (flag("aliases") ?? "").split(",").filter((a) => a !== "");
    if (image === undefined || version === undefined) {
      console.error("usage: bun scripts/release-image.ts alias-plan --image <repo> --version <v> --aliases a,b");
      return EXIT_USAGE;
    }
    if (aliases.length === 0) {
      console.log("release-image alias-plan: no aliases for this release (a prerelease moves nothing)");
      emit({ move: "", skipped: "" });
      return 0;
    }
    try {
      return aliasPlan(image, version, aliases);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return EXIT_REGISTRY_ERROR;
    }
  }

  // `platforms` is a lookup, not a check: it needs neither revision nor version.
  if (mode === "platforms") {
    const digest = flag("digest");
    if (image === undefined || digest === undefined) {
      console.error("usage: bun scripts/release-image.ts platforms --image <repo> --digest <sha256:…>");
      return EXIT_USAGE;
    }
    try {
      return platforms(`${image}@${digest}`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return EXIT_REGISTRY_ERROR;
    }
  }

  if ((mode !== "probe" && mode !== "verify") || image === undefined || revision === undefined || version === undefined) {
    console.error(
      "usage:\n" +
        "  bun scripts/release-image.ts probe     --image <repo> --tag <exact> --revision <sha> --version <v> [--platforms a,b]\n" +
        "  bun scripts/release-image.ts verify    --image <repo> --digest <sha256:…> --revision <sha> --version <v> [--platforms a,b] [--attestations]\n" +
        "  bun scripts/release-image.ts platforms --image <repo> --digest <sha256:…>",
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
