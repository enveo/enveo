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
  /** `host:port/database` for HUMANS — never a user name, never a password, never the full URL. */
  redacted: string;
  /**
   * The same triple for COMPARISON, with loopback spellings collapsed. `localhost`,
   * `127.0.0.1` and `[::1]` are one machine; comparing raw hostnames would let
   * `localhost:5432/enveo` pass as "different" from `127.0.0.1:5432/enveo`.
   */
  key: string;
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
 * DATABASE_URL for the child, in BOTH modes. Deliberately unroutable (port 1 refuses instantly).
 *
 * Not paranoia: `resolveDatabaseUrl()` falls back to `postgres://enveo:enveo@localhost:5432/enveo`
 * when nothing is configured, and route-level tests exercise real handlers through the POOLED db.
 * On a developer machine that default IS a real, running Enveo database — a `bun test` with no
 * `.env` was observed authenticating against one. DB-backed suites never use this value: they
 * hand their child processes the acknowledged TEST_DATABASE_URL explicitly.
 */
export const DEAD_DB_URL = "postgres://unused:unused@127.0.0.1:1/enveo_no_such_database";

/**
 * The target `packages/api/src/env.ts` `resolveDatabaseUrl()` falls back to when NOTHING is
 * configured — and "nothing configured" is the DOCUMENTED DEFAULT: `.env.example` ships
 * `DATABASE_URL` commented out.
 *
 * It is therefore never a throwaway. On a developer machine it is the docker-compose database;
 * on a self-host machine it is the live application database. `test:db` refuses it outright,
 * independently of whether `DATABASE_URL` happens to be set — see `planTestEnv`.
 */
export const DEFAULT_APP_DB_URL = "postgres://enveo:enveo@localhost:5432/enveo";

/** Spellings of "this machine". Collapsed to one token before any target comparison. */
const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "::ffff:127.0.0.1",
]);

function canonicalHost(host: string): string {
  const bare = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return LOOPBACK_HOSTS.has(bare) ? "localhost" : bare;
}

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
  return {
    host,
    port,
    database,
    redacted: `${host}:${port}/${database}`,
    key: `${canonicalHost(host)}:${port}/${database}`,
  };
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
          DATABASE_URL: DEAD_DB_URL,
          [RUNNER_MARKER]: RUNNER_MARKER_VALUE,
          [RUNNER_MODE]: "default",
        },
        banner:
          'mode=default — AI disabled (OPENAI_API_KEY=""), DB-backed groups skipped ' +
          '(TEST_DATABASE_URL=""), no reachable database. Ambient values from .env are ignored.',
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
  // Separation from the APPLICATION database. Both halves below are deliberately unconditional
  // in their own right: the per-suite fuses inside packages/api ("TEST_URL === DATABASE_URL")
  // can no longer fire, because the child's DATABASE_URL is overwritten with DEAD_DB_URL. This
  // is the only place left that can stop a writing suite from reaching real data.
  if (testTarget) {
    // (a) against an explicitly configured DATABASE_URL, compared on the CANONICAL target so
    //     localhost/127.0.0.1/::1 cannot be used to sneak past the check.
    if (appUrl) {
      if (testUrl === appUrl) {
        errors.push("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to it.");
      } else {
        const appTarget = describeDbTarget(appUrl);
        if (appTarget && appTarget.key === testTarget.key) {
          errors.push(
            `TEST_DATABASE_URL points at the same PostgreSQL target as DATABASE_URL ` +
              `(${testTarget.redacted}) — different credentials, a different host spelling or a ` +
              "different user are not a different database.",
          );
        }
      }
    }
    // (b) and ALWAYS against the built-in fallback, because DATABASE_URL being UNSET is the
    //     documented default — in that case the app silently uses this target, so it is by
    //     definition the live database rather than a throwaway.
    const fallbackTarget = describeDbTarget(DEFAULT_APP_DB_URL);
    if (fallbackTarget && testTarget.key === fallbackTarget.key) {
      errors.push(
        `TEST_DATABASE_URL is the default application database target (${testTarget.redacted}) — ` +
          "that is what the app itself falls back to when DATABASE_URL is unset, so it is never a " +
          "throwaway. Start a fresh PostgreSQL on another port or use another database name.",
      );
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
        DATABASE_URL: DEAD_DB_URL,
        [RUNNER_MARKER]: RUNNER_MARKER_VALUE,
        [RUNNER_MODE]: "db",
      },
      banner:
        `mode=db — AI disabled (OPENAI_API_KEY=""), DB-backed groups REQUIRED against ` +
        `${testTarget.redacted} (acknowledged throwaway).`,
    },
  };
}
