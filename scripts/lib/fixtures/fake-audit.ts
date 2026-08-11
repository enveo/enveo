#!/usr/bin/env bun
/**
 * A stand-in for `bun audit --json`, used by audit.process.test.ts.
 *
 * It exists because the distinction that matters cannot be tested against the real command:
 * Bun exits 1 BOTH when it found advisories (parseable JSON on stdout) and when the tool itself
 * failed (empty stdout, message on stderr). The gate must pass the first through to the policy
 * evaluator and fail closed on the second.
 *
 *   bun fake-audit.ts clean       → exit 0, "{}"
 *   bun fake-audit.ts findings    → exit 1, the real esbuild advisory (what main reports today)
 *   bun fake-audit.ts high        → exit 1, a synthetic high advisory
 *   bun fake-audit.ts toolfailure → exit 1, EMPTY stdout + a registry error on stderr
 *   bun fake-audit.ts garbage     → exit 0, output that is not the documented schema
 *   bun fake-audit.ts crash       → exit 7, an unexpected status
 */
const MODE = process.argv[2] ?? "clean";

const ESBUILD = {
  esbuild: [
    {
      id: 1102341,
      url: "https://github.com/advisories/GHSA-67mh-4wv8-2f99",
      title: "esbuild enables any website to send any requests to the development server",
      severity: "moderate",
      vulnerable_versions: "<=0.24.2",
      cwe: ["CWE-346"],
      cvss: { score: 5.3, vectorString: "CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:N/A:N" },
    },
  ],
};

const HIGH = {
  "@enveo/nothing": [
    {
      id: 4242,
      url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
      title: "synthetic high advisory used only by the audit gate tests",
      severity: "high",
      vulnerable_versions: "<99.0.0",
    },
  ],
};

switch (MODE) {
  case "clean":
    process.stdout.write("{}\n");
    process.exit(0);
  case "findings":
    process.stdout.write(`${JSON.stringify(ESBUILD)}\n`);
    process.exit(1);
  case "high":
    process.stdout.write(`${JSON.stringify(HIGH)}\n`);
    process.exit(1);
  case "toolfailure":
    process.stderr.write("error: failed to resolve the registry: connection refused\n");
    process.exit(1);
  case "garbage":
    process.stdout.write("<!doctype html><html>proxy login page</html>\n");
    process.exit(0);
  case "crash":
    process.stderr.write("error: something unexpected\n");
    process.exit(7);
  default:
    process.stderr.write(`unknown fake-audit mode: ${MODE}\n`);
    process.exit(64);
}
