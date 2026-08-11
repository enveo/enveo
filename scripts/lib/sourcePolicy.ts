/**
 * Self-host source policy (§5a) — two narrow rules over a fixed, short list of files.
 *
 * 1. **The canonical self-host image reference is `ghcr.io/enveo/enveo:latest`, always.**
 *    `latest` is a mutable alias the release gate moves only onto a fully verified stable
 *    image; documenting a numeric tag instead means every release makes the documentation
 *    stale, and it quietly invites operators to pin a version that will never get the next
 *    security fix. So in these files an Enveo image reference is either the bare package name
 *    (prose about the package) or `:latest` — a numeric tag, an `X.Y.Z` placeholder and a
 *    digest pin are all rejected. Release tooling, `docs/releasing.md` and the tests are NOT
 *    in scope: naming exact versions is their entire job.
 *
 * 2. **`scripts/deploy.sh` never downloads or executes a remote installer.** It configures and
 *    starts Enveo; provisioning Docker is the host operator's decision, and `curl … | sh` is
 *    precisely the pattern a self-hosted finance app should not teach. The rule bans remote
 *    downloads, pipes into a shell and package-manager automation — deliberately NOT the
 *    script's own localhost health probe.
 *
 * Everything here is PURE (callers pass file contents in) so the rules are unit-testable;
 * `scripts/check-sources.ts` applies them to the real tree and `sourcePolicy.test.ts` covers
 * both the rules and the current repository. The check never queries GHCR: documentation
 * verification must not depend on live registry state.
 */

/** Canonical self-host documents. Anything an operator is expected to copy from lives here. */
export const SELF_HOST_DOCS = [
  "README.md",
  "compose.selfhost.yml",
  ".env.selfhost.example",
  "docs/install.md",
  "docs/hosting.md",
  "docs/operations.md",
] as const;

/** The deployment bootstrap script, relative to the repository root. */
export const DEPLOY_SCRIPT = "scripts/deploy.sh";

/** One rule violation, located precisely enough to fix without searching. */
export type PolicyViolation = Readonly<{
  file: string;
  /** 1-based. */
  line: number;
  rule: "image-tag" | "version-placeholder" | "remote-download" | "pipe-to-shell" | "package-manager";
  detail: string;
}>;

/** The Enveo image, with whatever tag/digest follows it. Stops at markup and prose delimiters. */
const ENVEO_IMAGE = /ghcr\.io\/enveo\/enveo([:@][^\s`'"<>,)\]]*)?/g;

/** `X.Y.Z` / `vX.Y.Z` — the placeholder this policy replaced. */
const VERSION_PLACEHOLDER = /\bv?X\.Y\.Z\b/g;

/** The one tag canonical self-host documentation may name. */
const ALLOWED_TAG = ":latest";

/** Sentence punctuation that is not part of the reference (`…:latest.` ends a sentence). */
const stripTrailingPunctuation = (ref: string): string => ref.replace(/[.,;:!?]+$/, "");

/**
 * Rule 1. Every Enveo image reference in `text` must be bare or `:latest`, and the file may not
 * carry an `X.Y.Z` version placeholder. A placeholder INSIDE an image reference is reported once,
 * as the image-tag violation it really is.
 */
export function checkSelfHostImageRefs(file: string, text: string): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = index + 1;
    // Blank out image references before the placeholder sweep so one mistake is reported once.
    let rest = raw;
    for (const match of raw.matchAll(ENVEO_IMAGE)) {
      const whole = match[0];
      rest = rest.replace(whole, " ".repeat(whole.length));
      const ref = stripTrailingPunctuation(match[1] ?? "");
      if (ref === "" || ref === ALLOWED_TAG) continue;
      violations.push({
        file,
        line,
        rule: "image-tag",
        detail: `\`ghcr.io/enveo/enveo${ref}\` — canonical self-host documentation uses \`${ALLOWED_TAG}\` only`,
      });
    }
    for (const match of rest.matchAll(VERSION_PLACEHOLDER)) {
      violations.push({
        file,
        line,
        rule: "version-placeholder",
        detail: `\`${match[0]}\` — no version placeholder in canonical self-host documentation`,
      });
    }
  });
  return violations;
}

/** A URL that points back at the machine running the script (the health probe). */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0"]);
const URL_IN_LINE = /\bhttps?:\/\/([^\s'"|)\/]+)/g;
const DOWNLOADER = /\b(curl|wget)\b/;
const PIPE_TO_SHELL = /\|\s*(?:sudo\s+)?(?:ba|z|k|d)?sh\b/;
const PACKAGE_MANAGER = /\b(?:apt-get|apt|apk|dnf|yum|pacman|zypper|brew|snap)\s+(?:install|add|-S)\b/;

/** Rule 2. `scripts/deploy.sh` must not fetch or run anything from the network. */
export function checkDeployScript(text: string): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = index + 1;
    if (DOWNLOADER.test(raw)) {
      for (const match of raw.matchAll(URL_IN_LINE)) {
        const host = (match[1] ?? "").split(":")[0]!;
        if (LOCAL_HOSTS.has(host) || LOCAL_HOSTS.has(match[1] ?? "")) continue;
        violations.push({
          file: DEPLOY_SCRIPT,
          line,
          rule: "remote-download",
          detail: `downloads from \`${match[0]}\` — the bootstrap script performs no network downloads`,
        });
      }
    }
    if (PIPE_TO_SHELL.test(raw)) {
      violations.push({
        file: DEPLOY_SCRIPT,
        line,
        rule: "pipe-to-shell",
        detail: "pipes output into a shell — never execute a downloaded script",
      });
    }
    if (PACKAGE_MANAGER.test(raw)) {
      violations.push({
        file: DEPLOY_SCRIPT,
        line,
        rule: "package-manager",
        detail: "installs packages — provisioning the host is the operator's decision, not the script's",
      });
    }
  });
  return violations;
}

/** Render violations for a human. Empty string means the policy holds. */
export function formatViolations(violations: readonly PolicyViolation[]): string {
  return violations.map((v) => `  ${v.file}:${v.line}  [${v.rule}] ${v.detail}`).join("\n");
}
