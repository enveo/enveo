/**
 * Dependency-audit policy evaluator (§3a, encoding §0a "Audit policy and exception record").
 *
 * The gate: `bun audit --json` output in, a verdict out. Critical/high advisories have NO
 * exception path. A moderate/low advisory passes only when `security/audit-policy.json`
 * contains an exact, reviewed, unexpired entry for it. Anything the evaluator cannot fully
 * explain — malformed output, an unknown advisory, an expired or stale entry, a changed
 * severity, an installed version it cannot locate — FAILS CLOSED. Never make it advisory-only:
 * a newly published advisory breaking an unrelated PR is the intended behaviour.
 *
 * Everything here is pure. Spawning `bun audit` and reading files lives in ../audit.ts, so
 * every outcome can be covered with fixtures.
 *
 * WHY THE LOCKFILE: Bun's audit JSON reports the package NAME and the vulnerable RANGE, but
 * not which installed version or dependency path is affected — and §0a requires the exception
 * record to name both. So the affected instances are resolved from `bun.lock` and matched
 * against the policy entry: if the graph shifts and the advisory starts reaching a new path,
 * the entry stops matching exactly and the gate fails until a human re-reviews it.
 */

export type Severity = "info" | "low" | "moderate" | "high" | "critical";

const SEVERITIES: readonly Severity[] = ["info", "low", "moderate", "high", "critical"];
const FORBIDDEN: readonly Severity[] = ["high", "critical"];
const MAX_EXCEPTION_DAYS = 90;
const DAY_MS = 86_400_000;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type Advisory = Readonly<{
  package: string;
  advisoryId: string;
  title: string;
  url: string;
  severity: Severity;
  vulnerableVersions: string;
}>;

/** One installed copy of a package: its resolved version and the lockfile dependency path. */
export type InstalledInstance = Readonly<{ version: string; path: string }>;

export type InstalledIndex = ReadonlyMap<string, readonly InstalledInstance[]>;

export type PolicyException = Readonly<{
  advisoryId: string;
  package: string;
  severity: Severity;
  vulnerableVersions: string;
  installed: readonly InstalledInstance[];
  /** Where it lives: builder, final runtime image, browser bundle or test tooling (§0a.3). */
  scope: string;
  reachability: string;
  mitigation: string;
  fixedVersion: string;
  owner: string;
  rationale: string;
  addedOn: string;
  expires: string;
}>;

export type AuditPolicy = Readonly<{
  schemaVersion: 1;
  exceptions: readonly PolicyException[];
}>;

export type ReportEntry = Readonly<{
  advisory: Advisory;
  installed: readonly InstalledInstance[];
  verdict: "accepted" | "rejected";
  reason: string;
  daysUntilExpiry?: number;
  owner?: string;
  expires?: string;
}>;

export type AuditReport = Readonly<{
  ok: boolean;
  entries: readonly ReportEntry[];
  /** Advisory ids the policy still excepts although nothing installed matches them any more. */
  staleExceptions: readonly string[];
  problems: readonly string[];
}>;

/* ── Parsing ─────────────────────────────────────────────────────────────── */

function fail<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const ADVISORY_ID = /^(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|CVE-\d{4}-\d{4,})$/i;

/** Advisory ids are compared case-insensitively; the original spelling is kept for display. */
function idKey(advisoryId: string): string {
  return advisoryId.toUpperCase();
}

/**
 * Parse `bun audit --json`. The observed shape (bun 1.3.x) is an object keyed by package name
 * whose values are advisory arrays; a clean project prints `{}`. An empty body is NOT clean —
 * `bun audit` also exits 1 with empty stdout when it cannot reach the registry.
 */
export function parseAuditJson(text: string): ParseResult<Advisory[]> {
  if (!nonEmptyString(text)) {
    return fail("audit produced no output — treated as a tool/registry failure, not as 'clean'");
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    return fail(`audit output is not JSON (${(error as Error).message})`);
  }
  if (!isRecord(root)) return fail("audit output is not a package-keyed JSON object");

  const advisories: Advisory[] = [];
  for (const [packageName, raw] of Object.entries(root)) {
    if (!Array.isArray(raw)) {
      return fail(`audit output for "${packageName}" is not an array — Bun's schema changed`);
    }
    for (const item of raw) {
      if (!isRecord(item)) return fail(`advisory for "${packageName}" is not an object`);
      const { url, title, severity, vulnerable_versions: vulnerableVersions } = item;
      if (!nonEmptyString(url)) return fail(`advisory for "${packageName}" has no url`);
      const advisoryId = url.split("/").pop() ?? "";
      if (!ADVISORY_ID.test(advisoryId)) {
        return fail(`advisory url "${url}" does not carry a recognisable GHSA/CVE id`);
      }
      if (typeof severity !== "string" || !SEVERITIES.includes(severity as Severity)) {
        return fail(`advisory ${advisoryId} has unknown severity ${JSON.stringify(severity)}`);
      }
      if (!nonEmptyString(vulnerableVersions)) {
        return fail(`advisory ${advisoryId} has no vulnerable_versions range`);
      }
      if (!nonEmptyString(title)) return fail(`advisory ${advisoryId} has no title`);
      advisories.push({
        package: packageName,
        advisoryId,
        title,
        url,
        severity: severity as Severity,
        vulnerableVersions,
      });
    }
  }
  return { ok: true, value: advisories };
}

/**
 * Strip JSONC trailing commas so `bun.lock` can be read with JSON.parse. String-aware: a comma
 * inside a string literal is never touched.
 */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j++;
      const next = text[j];
      if (next === "}" || next === "]") continue; // drop the trailing comma
    }
    out += ch;
  }
  return out;
}

/** Split a lockfile descriptor ("esbuild@0.18.20", "@scope/pkg@1.2.3") into name and version. */
function splitDescriptor(descriptor: string): { name: string; version: string } | null {
  const at = descriptor.lastIndexOf("@");
  if (at <= 0) return null;
  const name = descriptor.slice(0, at);
  const version = descriptor.slice(at + 1);
  if (!name || !version) return null;
  return { name, version };
}

/**
 * Index every installed package instance from `bun.lock`. Keys of the `packages` object are the
 * dependency paths ("vite/esbuild"), the first array element is the resolved "name@version".
 */
export function parseBunLock(text: string): ParseResult<InstalledIndex> {
  if (!nonEmptyString(text)) return fail("bun.lock is empty");
  let root: unknown;
  try {
    root = JSON.parse(stripTrailingCommas(text));
  } catch (error) {
    return fail(`bun.lock is not readable (${(error as Error).message})`);
  }
  if (!isRecord(root)) return fail("bun.lock is not a JSON object");
  if (root.lockfileVersion !== 1) {
    return fail(
      `unsupported bun.lock lockfileVersion ${JSON.stringify(root.lockfileVersion)} — ` +
        "review this parser before trusting the audit gate again",
    );
  }
  const packages = root.packages;
  if (!isRecord(packages)) return fail("bun.lock has no `packages` object");

  const index = new Map<string, InstalledInstance[]>();
  for (const [path, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      return fail(`bun.lock entry "${path}" has an unexpected shape`);
    }
    const split = splitDescriptor(entry[0]);
    if (!split) return fail(`bun.lock entry "${path}" has an unreadable descriptor`);
    const list = index.get(split.name) ?? [];
    list.push({ version: split.version, path });
    index.set(split.name, list);
  }
  return { ok: true, value: index };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  // Reject values JS "rolls over" (2026-13-45 → 2027-…): the round trip must be identical.
  return date.toISOString().slice(0, 10) === value ? date : null;
}

/** Clock-skew tolerance for a self-declared `addedOn`, in days. */
const ADDED_ON_SKEW_DAYS = 2;

export function parsePolicy(text: string, now: Date = new Date()): ParseResult<AuditPolicy> {
  if (!nonEmptyString(text)) return fail("the audit policy file is empty");
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    return fail(`the audit policy file is not JSON (${(error as Error).message})`);
  }
  if (!isRecord(root)) return fail("the audit policy file is not a JSON object");
  if (root.schemaVersion !== 1) {
    return fail(
      `unsupported audit policy schemaVersion ${JSON.stringify(root.schemaVersion)} — ` +
        "the evaluator must be reviewed alongside a format change",
    );
  }
  if (!Array.isArray(root.exceptions)) return fail("the audit policy has no `exceptions` array");

  const exceptions: PolicyException[] = [];
  const seen = new Set<string>();
  for (const raw of root.exceptions) {
    if (!isRecord(raw)) return fail("an audit policy exception is not an object");
    const id = raw.advisoryId;
    if (typeof id !== "string" || !ADVISORY_ID.test(id)) {
      return fail(`audit policy exception has an invalid advisoryId ${JSON.stringify(id)}`);
    }
    const advisoryId = id;
    if (seen.has(idKey(advisoryId))) {
      return fail(`duplicate audit policy exception for ${advisoryId} — keep exactly one`);
    }
    seen.add(idKey(advisoryId));

    if (typeof raw.severity !== "string" || !SEVERITIES.includes(raw.severity as Severity)) {
      return fail(`exception ${advisoryId} has an unknown severity`);
    }
    const severity = raw.severity as Severity;
    if (FORBIDDEN.includes(severity)) {
      return fail(
        `exception ${advisoryId} is ${severity}: critical/high advisories have NO exception path`,
      );
    }
    for (const field of [
      "package",
      "vulnerableVersions",
      "scope",
      "reachability",
      "mitigation",
      "fixedVersion",
      "owner",
      "rationale",
    ] as const) {
      if (!nonEmptyString(raw[field])) {
        return fail(`exception ${advisoryId} is missing the reviewed field "${field}"`);
      }
    }
    if (!Array.isArray(raw.installed) || raw.installed.length === 0) {
      return fail(`exception ${advisoryId} must name the affected installed version(s) and path(s)`);
    }
    const installed: InstalledInstance[] = [];
    for (const item of raw.installed) {
      if (!isRecord(item) || !nonEmptyString(item.version) || !nonEmptyString(item.path)) {
        return fail(`exception ${advisoryId} has an invalid \`installed\` entry`);
      }
      installed.push({ version: item.version, path: item.path });
    }

    const addedOn = parseIsoDate(raw.addedOn);
    const expires = parseIsoDate(raw.expires);
    if (!addedOn) return fail(`exception ${advisoryId} has an invalid \`addedOn\` (want YYYY-MM-DD)`);
    if (!expires) return fail(`exception ${advisoryId} has an invalid \`expires\` (want YYYY-MM-DD)`);
    if (expires.getTime() <= addedOn.getTime()) {
      return fail(`exception ${advisoryId} expires on or before the date it was added`);
    }
    // `addedOn` is self-declared, so it cannot be trusted to bound anything on its own:
    // dating an entry in the future would compute a short window while suppressing the
    // advisory for far longer. Reject a future date, then measure the cap from whichever of
    // (addedOn, today) is LATER — what matters is how long the suppression still has to run.
    if (addedOn.getTime() > now.getTime() + ADDED_ON_SKEW_DAYS * DAY_MS) {
      return fail(
        `exception ${advisoryId} has an \`addedOn\` in the future (${raw.addedOn}) — ` +
          "the expiry window must be measured from a real date",
      );
    }
    // Cap BOTH the declared window (expires - addedOn) and the remaining one (expires - now),
    // i.e. measure from whichever date is EARLIER. Capping only the declared window lets a
    // future addedOn inflate the real suppression; capping only the remaining window lets an
    // over-long entry become acceptable simply by ageing into its last 90 days.
    const from = Math.min(addedOn.getTime(), now.getTime());
    const days = Math.ceil((expires.getTime() - from) / DAY_MS);
    if (days > MAX_EXCEPTION_DAYS) {
      return fail(
        `exception ${advisoryId} spans ${days} days — the limit is 90 days or the next release, ` +
          "whichever is earlier",
      );
    }

    exceptions.push({
      advisoryId,
      package: raw.package as string,
      severity,
      vulnerableVersions: raw.vulnerableVersions as string,
      installed,
      scope: raw.scope as string,
      reachability: raw.reachability as string,
      mitigation: raw.mitigation as string,
      fixedVersion: raw.fixedVersion as string,
      owner: raw.owner as string,
      rationale: raw.rationale as string,
      addedOn: raw.addedOn as string,
      expires: raw.expires as string,
    });
  }
  return { ok: true, value: { schemaVersion: 1, exceptions } };
}

/* ── Evaluation ──────────────────────────────────────────────────────────── */

function sameInstances(a: readonly InstalledInstance[], b: readonly InstalledInstance[]): boolean {
  const key = (i: InstalledInstance) => `${i.version} ${i.path}`;
  const left = [...a].map(key).sort();
  const right = [...b].map(key).sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/** Installed copies of the advisory's package whose version falls in the vulnerable range. */
function affectedInstances(advisory: Advisory, installed: InstalledIndex): InstalledInstance[] {
  const candidates = installed.get(advisory.package) ?? [];
  return candidates.filter((instance) => {
    try {
      return Bun.semver.satisfies(instance.version, advisory.vulnerableVersions);
    } catch {
      return false;
    }
  });
}

function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
}

export function evaluateAudit(input: {
  advisories: readonly Advisory[];
  installed: InstalledIndex;
  policy: AuditPolicy;
  now: Date;
}): AuditReport {
  const { advisories, installed, policy, now } = input;
  const entries: ReportEntry[] = [];
  const problems: string[] = [];
  const usedExceptions = new Set<string>();

  for (const advisory of advisories) {
    const matched = affectedInstances(advisory, installed);
    const reject = (reason: string) => {
      entries.push({ advisory, installed: matched, verdict: "rejected", reason });
      problems.push(`${advisory.advisoryId} (${advisory.package}, ${advisory.severity}): ${reason}`);
    };

    if (FORBIDDEN.includes(advisory.severity)) {
      reject(`${advisory.severity} severity — there is no exception path, it must be fixed`);
      continue;
    }
    if (matched.length === 0) {
      reject(
        `no installed version of "${advisory.package}" in bun.lock matches ` +
          `"${advisory.vulnerableVersions}" — the audit output and the lockfile disagree`,
      );
      continue;
    }

    const exception = policy.exceptions.find(
      (e) => idKey(e.advisoryId) === idKey(advisory.advisoryId),
    );
    if (!exception) {
      reject("no reviewed policy entry — triage it, fix it, or add an exact exception");
      continue;
    }
    usedExceptions.add(idKey(exception.advisoryId));

    if (exception.package !== advisory.package) {
      reject(`policy entry names package "${exception.package}", audit says "${advisory.package}"`);
      continue;
    }
    if (exception.severity !== advisory.severity) {
      const increased =
        SEVERITIES.indexOf(advisory.severity) > SEVERITIES.indexOf(exception.severity);
      reject(
        `severity ${increased ? "INCREASED" : "changed"} from ${exception.severity} to ` +
          `${advisory.severity} since the entry was reviewed`,
      );
      continue;
    }
    if (exception.vulnerableVersions !== advisory.vulnerableVersions) {
      reject(
        `affected range changed from "${exception.vulnerableVersions}" to ` +
          `"${advisory.vulnerableVersions}" since the entry was reviewed`,
      );
      continue;
    }
    if (!sameInstances(exception.installed, matched)) {
      reject(
        "the installed version(s)/path(s) no longer match the entry — got " +
          matched.map((i) => `${i.version} via ${i.path}`).join(", "),
      );
      continue;
    }

    const expires = parseIsoDate(exception.expires);
    if (!expires) {
      reject(`policy entry has an invalid expiry ${JSON.stringify(exception.expires)}`);
      continue;
    }
    const remaining = daysBetween(now, expires);
    if (remaining <= 0) {
      reject(`the exception expired on ${exception.expires} — re-review or fix it`);
      continue;
    }

    entries.push({
      advisory,
      installed: matched,
      verdict: "accepted",
      reason: exception.reachability,
      daysUntilExpiry: remaining,
      owner: exception.owner,
      expires: exception.expires,
    });
  }

  const staleExceptions = policy.exceptions
    .filter((e) => !usedExceptions.has(idKey(e.advisoryId)))
    .map((e) => e.advisoryId);
  for (const id of staleExceptions) {
    problems.push(
      `${id}: stale exception — no installed finding matches it any more, remove it from the policy`,
    );
  }

  return { ok: problems.length === 0, entries, staleExceptions, problems };
}
