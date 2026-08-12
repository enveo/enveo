#!/usr/bin/env bun
/**
 * Release gate, phase 1 (§3d): decide whether a tag may be released AT ALL — before any
 * registry login, any write-scoped job, any build.
 *
 *   bun scripts/release-validate.ts --tag v3.8.0
 *   bun scripts/release-validate.ts --tag v3.8.0 --main-ref origin/main
 *
 * Four questions, in this order, each fatal:
 *
 *   1. is the tag a version tag under the strict policy?      (lib/releaseVersion.ts, unit-tested)
 *   2. does that tag EXIST and resolve to a commit?           (never a branch, never a raw SHA)
 *   3. is that commit an ancestor of `main`?                  (a tag can point anywhere)
 *   4. does APP_VERSION at that commit agree with the tag?    (read from the TAGGED commit)
 *
 * Point 4 reads `packages/web/src/lib/version.ts` out of the tagged commit with `git show`, not
 * from the working tree: the workflow's checkout could be any ref, and the only version that
 * matters is the one the released source ships.
 *
 * On success the resolved facts are written to `$GITHUB_OUTPUT`. Everything downstream — every
 * checkout, the build arg, the OCI labels, the attestation subject — uses the SHA resolved here,
 * so `github.sha` (the default branch head on a workflow_dispatch) can never leak into the
 * released artifact's identity.
 */
import { appendFileSync } from "node:fs";
import { aliasImageTags, checkAppVersion, extractAppVersion, parseReleaseTag } from "./lib/releaseVersion";

const APP_VERSION_FILE = "packages/web/src/lib/version.ts";

const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

type Run = Readonly<{ code: number; stdout: string; stderr: string }>;

function git(...argv: readonly string[]): Run {
  const result = Bun.spawnSync(["git", ...argv], { stdio: ["ignore", "pipe", "pipe"] });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

/** GitHub renders this as an annotation; locally it is still a readable line. */
function fail(message: string): number {
  console.error(`::error::release-validate: ${message}`);
  return EXIT_REJECTED;
}

function emit(outputs: Readonly<Record<string, string>>): void {
  const path = process.env["GITHUB_OUTPUT"];
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  for (const line of lines) console.log(`  ${line}`);
  if (path !== undefined && path !== "") appendFileSync(path, `${lines.join("\n")}\n`);
}

function main(argv: readonly string[]): number {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };

  const tag = flag("tag");
  if (tag === undefined) {
    console.error("usage: bun scripts/release-validate.ts --tag <vX.Y.Z> [--main-ref origin/main]");
    return EXIT_USAGE;
  }
  const mainRef = flag("main-ref") ?? "origin/main";

  // ── 1. the tag is a version tag ─────────────────────────────────────────────────────────
  const verdict = parseReleaseTag(tag);
  if (!verdict.ok) return fail(verdict.reason);
  const release = verdict.release;

  // ── 2. the tag EXISTS on the remote and resolves to a commit ────────────────────────────
  //
  // `refs/tags/` is explicit on purpose: a BRANCH called `v3.8.0` must not be releasable, and a
  // raw SHA never reaches this point (it fails the parser). `^{commit}` dereferences an
  // annotated tag object to the commit it points at.
  const resolved = git("rev-parse", "--verify", "--quiet", `refs/tags/${release.tag}^{commit}`);
  if (resolved.code !== 0 || resolved.stdout === "") {
    return fail(
      `tag ${release.tag} does not exist (fetch tags first, and note that a manual re-run may ` + `only name a tag that ALREADY exists on the remote)`,
    );
  }
  const sha = resolved.stdout;

  // ── 3. the commit is on main ────────────────────────────────────────────────────────────
  //
  // A tag is just a pointer: it can be created on any branch, on a commit that never passed
  // review, or on a commit that was reverted. `--is-ancestor` is the check that keeps a release
  // inside the history everybody else sees.
  const mainSha = git("rev-parse", "--verify", "--quiet", `${mainRef}^{commit}`);
  if (mainSha.code !== 0 || mainSha.stdout === "") {
    return fail(`cannot resolve ${mainRef} — fetch it before validating (needs real history)`);
  }
  const ancestry = git("merge-base", "--is-ancestor", sha, mainRef);
  if (ancestry.code !== 0) {
    return fail(`${release.tag} (${sha}) is NOT an ancestor of ${mainRef} (${mainSha.stdout}) — only ` + `commits that reached main may be released`);
  }

  // ── 4. APP_VERSION at the TAGGED commit agrees with the tag ─────────────────────────────
  const versionFile = git("show", `${sha}:${APP_VERSION_FILE}`);
  if (versionFile.code !== 0) {
    return fail(`cannot read ${APP_VERSION_FILE} at ${sha}: ${versionFile.stderr}`);
  }
  const appVersion = extractAppVersion(versionFile.stdout);
  const mismatch = checkAppVersion(release, appVersion);
  if (mismatch !== null) return fail(mismatch);

  const aliases = aliasImageTags(release);
  console.log(`release-validate: ${release.tag} accepted`);
  console.log(`  commit          ${sha} (ancestor of ${mainRef})`);
  console.log(`  APP_VERSION     ${appVersion} (from ${APP_VERSION_FILE} at that commit)`);
  console.log(`  channel         ${release.stable ? "stable" : "prerelease"}`);
  console.log(`  exact image tag ${release.version}`);
  console.log(`  moving aliases  ${aliases.length === 0 ? "<none — a prerelease moves nothing>" : aliases.join(", ")}`);
  console.log("");

  emit({
    tag: release.tag,
    version: release.version,
    core: release.core,
    sha,
    stable: String(release.stable),
    aliases: aliases.join(","),
  });
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
