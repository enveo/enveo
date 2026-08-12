/**
 * The release-tag policy (§3d): what may be released, and under which image tags.
 *
 * A `v*` tag is the ONLY release trigger, and a tag does not authorise publication by itself.
 * This module is the first gate: it decides whether a tag is a version at all, whether the
 * repository's own `APP_VERSION` agrees with it, and which registry tags it earns.
 *
 * Everything here is PURE — no git, no filesystem, no registry — so every rejection class can be
 * unit-tested. The reviewed workflow used shell `case` globs (`v[0-9]*.[0-9]*.[0-9]*`), which
 * accept `v3.8.0rc1`, `v3.8.0_final`, `v3.8.0.deploy` and `v03.8.0`, all of which would have
 * become immutable public image tags.
 *
 * The parser is deliberately hand-written: the accepted grammar is a strict SUBSET of SemVer
 * (no build metadata), the rejection reasons must be legible in a workflow log, and a release
 * gate should not depend on a transitive package it cannot audit.
 */

/** A tag that passed the policy. `version` is what the registry sees; `tag` is the git ref name. */
export type ReleaseTag = Readonly<{
  /** As written in git, with the `v`: `v3.8.0-rc.1`. */
  tag: string;
  /** The OCI-facing version, without the `v`: `3.8.0-rc.1`. This is the exact image tag. */
  version: string;
  /** `MAJOR.MINOR.PATCH` only: `3.8.0`. */
  core: string;
  major: number;
  minor: number;
  patch: number;
  /** The prerelease identifiers as written (`rc.1`), or `null` for a stable release. */
  prerelease: string | null;
  /** A stable release moves the mutable aliases; a prerelease never does. */
  stable: boolean;
}>;

export type TagVerdict = Readonly<{ ok: true; release: ReleaseTag }> | Readonly<{ ok: false; reason: string }>;

/** `MAJOR.MINOR.PATCH`, digits only — leading zeros are checked separately for a clear message. */
const CORE = /^(\d+)\.(\d+)\.(\d+)$/;

/** The SemVer prerelease alphabet. */
const IDENTIFIER = /^[0-9A-Za-z-]+$/;

const ALL_DIGITS = /^\d+$/;

const hasLeadingZero = (component: string): boolean => component.length > 1 && component.startsWith("0");

/**
 * Parse a git tag against the release policy.
 *
 * Order matters: the checks run from the most structural (is this even a tag-shaped string?)
 * to the most specific, so the reported reason names the actual problem instead of a generic
 * "not a version tag".
 */
export function parseReleaseTag(raw: string): TagVerdict {
  if (raw === "") return { ok: false, reason: "empty tag" };

  // Before anything else: a value that came through a shell capture may carry a newline, and a
  // caller may have passed a full ref. Neither is a version tag, and both would otherwise be
  // half-accepted by a lenient regex.
  if (/\s/.test(raw)) {
    return { ok: false, reason: `tag contains whitespace: ${JSON.stringify(raw)}` };
  }
  if (raw.includes("/")) {
    return {
      ok: false,
      reason: `ref-like input ${JSON.stringify(raw)} — pass the tag NAME (v3.8.0), not a ref`,
    };
  }
  if (!raw.startsWith("v")) {
    return { ok: false, reason: `tag must start with a lowercase "v": ${JSON.stringify(raw)}` };
  }

  const body = raw.slice(1);

  // SemVer build metadata is valid SemVer but cannot be represented in the chosen OCI tag policy
  // (`+` is not a legal tag character), so it is rejected rather than silently mangled.
  if (body.includes("+")) {
    return {
      ok: false,
      reason: `build metadata is not accepted (${JSON.stringify(raw)}) — an OCI tag cannot carry "+"`,
    };
  }

  const dash = body.indexOf("-");
  const coreText = dash === -1 ? body : body.slice(0, dash);
  const prerelease = dash === -1 ? null : body.slice(dash + 1);

  const match = CORE.exec(coreText);
  if (match === null) {
    return {
      ok: false,
      reason: `${JSON.stringify(raw)} is not vMAJOR.MINOR.PATCH[-prerelease]`,
    };
  }
  const [, major = "", minor = "", patch = ""] = match;
  for (const [name, component] of [
    ["major", major],
    ["minor", minor],
    ["patch", patch],
  ] as const) {
    if (hasLeadingZero(component)) {
      return { ok: false, reason: `${name} component "${component}" has a leading zero` };
    }
  }

  if (prerelease !== null) {
    if (prerelease === "") {
      return { ok: false, reason: `empty prerelease in ${JSON.stringify(raw)}` };
    }
    for (const identifier of prerelease.split(".")) {
      if (identifier === "") {
        return { ok: false, reason: `empty prerelease identifier in ${JSON.stringify(raw)}` };
      }
      if (!IDENTIFIER.test(identifier)) {
        return {
          ok: false,
          reason: `prerelease identifier "${identifier}" has a character outside [0-9A-Za-z-]`,
        };
      }
      // SemVer constrains NUMERIC identifiers only: `01a` is a legal alphanumeric identifier,
      // `01` is not a legal numeric one.
      if (ALL_DIGITS.test(identifier) && hasLeadingZero(identifier)) {
        return { ok: false, reason: `numeric prerelease identifier "${identifier}" has a leading zero` };
      }
    }
  }

  return {
    ok: true,
    release: {
      tag: raw,
      version: body,
      core: coreText,
      major: Number(major),
      minor: Number(minor),
      patch: Number(patch),
      prerelease,
      stable: prerelease === null,
    },
  };
}

/**
 * Read `APP_VERSION` out of `packages/web/src/lib/version.ts`.
 *
 * Deliberately anchored to the start of a line: a commented-out or historical mention must not
 * win over the real export, and `null` (rather than a guess) is what makes a moved/renamed
 * constant fail the release instead of skipping the comparison.
 */
export function extractAppVersion(source: string): string | null {
  return /^export const APP_VERSION\s*=\s*"([^"]*)"/m.exec(source)?.[1] ?? null;
}

/**
 * Compare the tag with the version string the application ships to users.
 *
 * POLICY (one deliberate refinement of the §3d wording, see the PR):
 * - a STABLE release must match APP_VERSION byte-for-byte — this is the string users read in
 *   the app, and `latest`/`MAJOR.MINOR` point at it;
 * - a PRERELEASE may carry either the full version (`3.8.0-rc.1`) or its bare core (`3.8.0`),
 *   because `-rc.N` is release-process metadata, not a product version. An rc therefore does
 *   not force two extra APP_VERSION commits (one to add `-rc.1`, one to remove it), while the
 *   MAJOR.MINOR.PATCH the app reports still has to be the one being released.
 *
 * Returns `null` when the tag is acceptable, or a human-readable reason when it is not.
 */
export function checkAppVersion(release: ReleaseTag, appVersion: string | null): string | null {
  if (appVersion === null) {
    return "APP_VERSION could not be read from packages/web/src/lib/version.ts at the tagged commit";
  }
  if (release.stable) {
    return appVersion === release.version
      ? null
      : `APP_VERSION is ${JSON.stringify(appVersion)} at the tagged commit, but the tag is ` +
          `${release.tag} — a stable release must match byte-for-byte (${release.version})`;
  }
  if (appVersion === release.version || appVersion === release.core) return null;
  return (
    `APP_VERSION is ${JSON.stringify(appVersion)} at the tagged commit, but the prerelease tag ` +
    `${release.tag} requires ${JSON.stringify(release.core)} or ${JSON.stringify(release.version)}`
  );
}

/** Parse a bare version string (no leading `v`), e.g. one read from an OCI label. */
export function parseVersion(text: string): ReleaseTag | null {
  const verdict = parseReleaseTag(`v${text}`);
  return verdict.ok ? verdict.release : null;
}

/**
 * SemVer precedence: negative if `a` sorts before `b`, positive if after, 0 if equal.
 *
 * Implements the prerelease rules too, not just the numeric core: a version WITHOUT a prerelease
 * outranks the same core WITH one, numeric identifiers compare numerically and rank below
 * alphanumeric ones, and a shorter identifier list loses when every preceding field is equal.
 * Aliases only ever serve stable versions today, but a comparison that silently mis-ranks
 * `3.8.0-rc.1` against `3.8.0` is the kind of thing that is discovered by a downgrade.
 */
export function compareVersions(a: ReleaseTag, b: ReleaseTag): number {
  for (const [x, y] of [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.patch, b.patch],
  ] as const) {
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;

  const left = a.prerelease.split(".");
  const right = b.prerelease.split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const lNumeric = ALL_DIGITS.test(l);
    const rNumeric = ALL_DIGITS.test(r);
    if (lNumeric && rNumeric) return Number(l) < Number(r) ? -1 : 1;
    if (lNumeric !== rNumeric) return lNumeric ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

/** What an alias currently serves, as read from the registry. */
export type AliasState = Readonly<{
  alias: string;
  /** Whether the alias tag exists at all. */
  present: boolean;
  /** The version the alias currently serves, or `null` when it could not be determined. */
  version: string | null;
}>;

export type AliasDecision = Readonly<{
  alias: string;
  action: "move" | "noop" | "skip";
  reason: string;
}>;

/**
 * Decide, per alias, whether this release may take it over. ALIASES ONLY EVER MOVE FORWARD.
 *
 * The failure this prevents: v3.8.0 stops partway (say at attestation), v3.8.1 is released and
 * correctly takes `latest`, and then somebody re-runs v3.8.0 to finish its missing GitHub
 * Release. Everything about that re-run is legitimate — the tag exists, the image verifies, the
 * resume is exactly the documented recovery path — and without this check it would quietly drag
 * `latest` back to 3.8.0 for every self-hoster who pulls it.
 *
 * A skip is NOT a failure: the rest of the resume is valid work and must still complete. It is
 * reported loudly instead.
 *
 * An alias whose version cannot be determined is also skipped rather than taken over: refusing to
 * move is recoverable by hand, whereas an unnoticed downgrade is not.
 */
export function planAliasMoves(release: ReleaseTag, states: readonly AliasState[]): AliasDecision[] {
  return states.map(({ alias, present, version }): AliasDecision => {
    if (!present) {
      return { alias, action: "move", reason: `${alias} does not exist yet` };
    }
    if (version === null || version === "") {
      return {
        alias,
        action: "skip",
        reason: `${alias} exists but does not say which version it serves — refusing to move it blindly`,
      };
    }
    const current = parseVersion(version);
    if (current === null) {
      return {
        alias,
        action: "skip",
        reason: `${alias} serves an unparseable version ${JSON.stringify(version)} — refusing to move it blindly`,
      };
    }
    const order = compareVersions(release, current);
    if (order > 0) {
      return { alias, action: "move", reason: `${alias} serves ${version}, older than ${release.version}` };
    }
    if (order === 0) {
      return { alias, action: "noop", reason: `${alias} already serves ${release.version}` };
    }
    return {
      alias,
      action: "skip",
      reason:
        `${alias} serves ${version}, which is NEWER than ${release.version} — not moving it backwards ` +
        "(re-running an older tag must not downgrade what self-hosters pull)",
    };
  });
}

/**
 * The MUTABLE tags a release earns, in the order they should be moved.
 *
 * A prerelease earns none: `v3.8.0-rc.1` publishes `3.8.0-rc.1` and nothing else, so a release
 * candidate can be exercised end-to-end without any self-hoster's `latest` moving.
 */
export function aliasImageTags(release: ReleaseTag): string[] {
  return release.stable ? [`${release.major}.${release.minor}`, "latest"] : [];
}
