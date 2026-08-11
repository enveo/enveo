#!/usr/bin/env bun
/**
 * Vulnerability scan of a BUILT Enveo image (§3e), with a pinned scanner and fail-closed
 * semantics — the same discipline as `scripts/audit.ts` applies to dependencies.
 *
 *   bun scripts/scan-image.ts enveo:candidate
 *
 * Scans OS packages AND application layers. Critical/high findings BLOCK publication. There is
 * deliberately no `--ignore-unfixed` and no severity threshold: a finding with no upstream fix
 * is still a finding, and hiding it is exactly the failure mode §0a forbids. An accepted item
 * goes in `security/image-scan-ignore.yaml` as an exact, reviewed, EXPIRING entry, and stays
 * VISIBLE in the output (`--show-suppressed`).
 *
 * FAIL CLOSED. Trivy exits 1 both for "found vulnerabilities" and for an error, so the two are
 * told apart by whether a report was produced. A vulnerability-database download failure, an
 * unparseable report, or a report with no results at all is treated as a FAILED SCAN — never as
 * a clean bill of health. An unscanned image must not be publishable.
 *
 * The scanner itself is pinned by immutable digest, and the image is handed over as a tarball
 * (`docker save`) so the scanner container never needs the Docker socket.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Pinned scanner. Bump version and digest together in a reviewed PR, exactly like the Bun base:
 * a floating `latest` cannot produce a release verdict anybody can reproduce.
 */
const TRIVY_VERSION = "0.73.0";
const TRIVY_DIGEST = "sha256:7cced7cae583819fc7806d4cbc0dbbc7cad18b99f7d3e235192e6da8c091045c";
const TRIVY = `aquasec/trivy:${TRIVY_VERSION}@${TRIVY_DIGEST}`;

const BLOCKING = "CRITICAL,HIGH";
const IGNORE_FILE = "security/image-scan-ignore.yaml";

const EXIT_FINDINGS = 1;
const EXIT_SCAN_FAILED = 3;
const EXIT_USAGE = 2;

type Vulnerability = Readonly<{
  VulnerabilityID: string;
  PkgName: string;
  InstalledVersion: string;
  FixedVersion?: string;
  Severity: string;
  Status?: string;
  Title?: string;
}>;
type Result = Readonly<{ Target: string; Class?: string; Type?: string; Vulnerabilities?: Vulnerability[] }>;

function main(argv: readonly string[]): number {
  const image = argv[0];
  if (image === undefined || image.startsWith("-")) {
    console.error("usage: bun scripts/scan-image.ts <image-ref>");
    return EXIT_USAGE;
  }

  const repoRoot = join(import.meta.dir, "..");
  const tarball = join(repoRoot, `.image-scan-${process.pid}.tar`);

  try {
    const saved = Bun.spawnSync(["docker", "save", image, "-o", tarball], { stdio: ["ignore", "inherit", "pipe"] });
    if (saved.exitCode !== 0) {
      console.error(`scan-image: cannot export ${image}: ${saved.stderr.toString().trim()}`);
      return EXIT_SCAN_FAILED;
    }

    console.log(`scan-image: ${image}`);
    console.log(`scan-image: scanner ${TRIVY}`);

    // The human-readable table first: accepted items must stay visible, not silently dropped.
    const table = Bun.spawnSync(
      [
        "docker", "run", "--rm",
        "-v", `${tarball}:/scan/image.tar:ro`,
        "-v", `${join(repoRoot, "security")}:/policy:ro`,
        TRIVY,
        "image", "--input", "/scan/image.tar",
        "--scanners", "vuln",
        "--severity", BLOCKING,
        "--show-suppressed",
        "--ignorefile", `/policy/${IGNORE_FILE.split("/")[1]}`,
        "--exit-code", "0",
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (table.exitCode !== 0) {
      console.error("scan-image: the scanner itself failed — treating the image as UNSCANNED");
      return EXIT_SCAN_FAILED;
    }

    // …then the machine-readable pass used for the verdict.
    const json = Bun.spawnSync(
      [
        "docker", "run", "--rm",
        "-v", `${tarball}:/scan/image.tar:ro`,
        "-v", `${join(repoRoot, "security")}:/policy:ro`,
        TRIVY,
        "image", "--input", "/scan/image.tar",
        "--scanners", "vuln",
        "--severity", BLOCKING,
        "--ignorefile", `/policy/${IGNORE_FILE.split("/")[1]}`,
        "--format", "json",
        "--quiet",
        "--exit-code", "0",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let report: { Results?: Result[] };
    try {
      report = JSON.parse(json.stdout.toString()) as { Results?: Result[] };
    } catch {
      console.error("scan-image: the scanner produced no parseable report — UNSCANNED, failing closed");
      console.error(json.stderr.toString().trim());
      return EXIT_SCAN_FAILED;
    }

    // A scan that inspected nothing is not a clean scan. Enveo's image always yields at least
    // the OS package target, so an empty Results array means the scanner did not do its job.
    if (!Array.isArray(report.Results) || report.Results.length === 0) {
      console.error("scan-image: report contains NO scan targets — UNSCANNED, failing closed");
      return EXIT_SCAN_FAILED;
    }

    const blocking = report.Results.flatMap((result) =>
      (result.Vulnerabilities ?? []).map((vulnerability) => ({ target: result.Target, vulnerability })),
    );

    if (blocking.length > 0) {
      console.error(`\nscan-image: ${blocking.length} unaccepted critical/high finding(s):`);
      for (const { target, vulnerability } of blocking) {
        console.error(
          `  • ${vulnerability.Severity} ${vulnerability.VulnerabilityID} ${vulnerability.PkgName} ` +
            `${vulnerability.InstalledVersion} (fix: ${vulnerability.FixedVersion ?? "none"}) — ${target}`,
        );
      }
      console.error(
        `\nFix the package, bump the base image, or add an exact, reviewed, EXPIRING entry to ${IGNORE_FILE}.`,
      );
      return EXIT_FINDINGS;
    }

    console.log("\nscan-image: OK — no unaccepted critical/high findings");
    return 0;
  } finally {
    rmSync(tarball, { force: true });
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
