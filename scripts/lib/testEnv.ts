/**
 * Environment contract for the root test commands (§3a).
 *
 * Bun auto-loads `.env`, so a developer's real OpenAI key and a real `TEST_DATABASE_URL`
 * are ambient in every local `bun test`. A shell prefix (`OPENAI_API_KEY= bun test …`) is
 * not a safety mechanism: it is one forgotten prefix away from a "no AI key" test passing
 * for the wrong reason, or from a DB-backed suite writing to a database somebody cares about.
 *
 * So the decision is made HERE, as pure logic over the parent environment, and
 * `scripts/run-tests.ts` only spawns the child with the overrides this module returns.
 * Nothing in this file does I/O — that is what makes it testable.
 */

export type TestMode = "default" | "db";

export type EnvRecord = Readonly<Record<string, string | undefined>>;

/** Credential-free description of a PostgreSQL URL, safe to print. */
export type DbTarget = Readonly<{
  host: string;
  port: string;
  database: string;
  /** `host:port/database` — never a user name, never a password, never the full URL. */
  redacted: string;
}>;

export type TestEnvPlan = Readonly<{
  mode: TestMode;
  /** Applied ON TOP of the inherited parent environment when spawning the child. */
  overrides: Readonly<Record<string, string>>;
  /** One line printed before the child starts. Contains no credentials. */
  banner: string;
}>;

export type TestEnvResult =
  | { ok: true; plan: TestEnvPlan }
  | { ok: false; mode: TestMode; errors: readonly string[] };

const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

/** The sentinel the caller must set to unlock DB mode. See `planTestEnv`. */
export const TEST_DB_ACK = "throwaway";

/**
 * Markers stamped on every child. They let `runner-contract.test.ts` assert FROM INSIDE the
 * test process that the environment it actually got is the one this module promised — the
 * proof that an ambient `.env` never reaches the suite.
 */
export const RUNNER_MARKER = "ENVEO_TEST_RUNNER";
export const RUNNER_MARKER_VALUE = "run-tests";
export const RUNNER_MODE = "ENVEO_TEST_MODE";

/**
 * Parse a PostgreSQL URL down to the only three parts we are allowed to show a human.
 * Returns null when the value is not a usable PostgreSQL URL — callers must fail closed.
 */
export function describeDbTarget(url: string): DbTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!POSTGRES_PROTOCOLS.has(parsed.protocol)) return null;
  const host = parsed.hostname;
  if (!host) return null;
  const port = parsed.port || "5432";
  const database = parsed.pathname.replace(/^\//, "");
  if (!database) return null;
  return { host, port, database, redacted: `${host}:${port}/${database}` };
}

/**
 * Decide the child environment for a test run.
 *
 * `default` — AI and the DB-backed groups are BOTH switched off by force. Deterministic,
 * offline, and unable to consume whatever the developer's `.env` happens to hold.
 *
 * `db` — the DB-backed groups are required, so the caller must prove intent:
 * a non-empty `TEST_DATABASE_URL`, an explicit `ENVEO_TEST_DB_ACK=throwaway`, and a URL that
 * is not the one the app itself uses. The sentinel does not prove a database is disposable;
 * it proves the value did not arrive by accident from an auto-loaded `.env`.
 */
export function planTestEnv(mode: TestMode, env: EnvRecord): TestEnvResult {
  if (mode === "default") {
    return {
      ok: true,
      plan: {
        mode,
        overrides: {
          OPENAI_API_KEY: "",
          TEST_DATABASE_URL: "",
          [RUNNER_MARKER]: RUNNER_MARKER_VALUE,
          [RUNNER_MODE]: "default",
        },
        banner:
          'mode=default — AI disabled (OPENAI_API_KEY=""), DB-backed groups skipped ' +
          '(TEST_DATABASE_URL=""). Ambient values from .env are ignored.',
      },
    };
  }

  const errors: string[] = [];
  const testUrl = (env.TEST_DATABASE_URL ?? "").trim();
  const appUrl = (env.DATABASE_URL ?? "").trim();
  const ack = env.ENVEO_TEST_DB_ACK ?? "";

  if (!testUrl) {
    errors.push(
      "TEST_DATABASE_URL is empty — DB mode needs an explicit THROWAWAY PostgreSQL URL.",
    );
  }
  if (ack !== TEST_DB_ACK) {
    errors.push(
      `ENVEO_TEST_DB_ACK=${TEST_DB_ACK} is required — DB-backed suites migrate and WRITE, ` +
        "so the intent must be explicit and cannot come from an auto-loaded .env.",
    );
  }

  const testTarget = testUrl ? describeDbTarget(testUrl) : null;
  if (testUrl && !testTarget) {
    errors.push("TEST_DATABASE_URL is not a valid PostgreSQL URL (expected postgres://…).");
  }
  if (testUrl && appUrl) {
    if (testUrl === appUrl) {
      errors.push("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to it.");
    } else {
      const appTarget = describeDbTarget(appUrl);
      if (testTarget && appTarget && testTarget.redacted === appTarget.redacted) {
        errors.push(
          `TEST_DATABASE_URL points at the same PostgreSQL target as DATABASE_URL ` +
            `(${testTarget.redacted}) — different credentials are not a different database.`,
        );
      }
    }
  }

  if (errors.length > 0 || !testTarget) {
    return { ok: false, mode, errors: errors.length > 0 ? errors : ["TEST_DATABASE_URL is unusable."] };
  }

  return {
    ok: true,
    plan: {
      mode,
      overrides: {
        OPENAI_API_KEY: "",
        TEST_DATABASE_URL: testUrl,
        [RUNNER_MARKER]: RUNNER_MARKER_VALUE,
        [RUNNER_MODE]: "db",
      },
      banner:
        `mode=db — AI disabled (OPENAI_API_KEY=""), DB-backed groups REQUIRED against ` +
        `${testTarget.redacted} (acknowledged throwaway).`,
    },
  };
}
