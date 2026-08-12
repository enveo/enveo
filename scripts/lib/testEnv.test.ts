/**
 * Pure tests for the test-runner environment contract (§3a).
 *
 * The point of `scripts/run-tests.ts` is that a local `.env` (bun auto-loads it) must never
 * decide what the test suite talks to. These tests pin that decision as pure logic, so the
 * process layer only has to spawn what `planTestEnv` returns.
 */
import { describe, expect, it } from "bun:test";
import { DEAD_DB_URL, describeDbTarget, planTestEnv } from "./testEnv";

const PROD_LIKE = "postgres://enveo:s3cr3t-password@127.0.0.1:5432/enveo";
const THROWAWAY = "postgres://enveo:enveo@127.0.0.1:5495/enveo";

describe("planTestEnv — default mode", () => {
  it("forces the sensitive variables empty even when the parent supplied them", () => {
    const result = planTestEnv("default", {
      OPENAI_API_KEY: "sk-live-should-never-reach-the-child",
      AI_SAFETY_IDENTIFIER_SECRET: "ambient-secret-from-dotenv",
      TEST_DATABASE_URL: PROD_LIKE,
      DATABASE_URL: PROD_LIKE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.overrides.OPENAI_API_KEY).toBe("");
    expect(result.plan.overrides.AI_SAFETY_IDENTIFIER_SECRET).toBe("");
    expect(result.plan.overrides.TEST_DATABASE_URL).toBe("");
  });

  it("overrides the sensitive variables plus the runner markers, and needs no sentinel", () => {
    const result = planTestEnv("default", {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.plan.overrides).sort()).toEqual([
      "AI_SAFETY_IDENTIFIER_SECRET",
      "DATABASE_URL",
      "ENVEO_TEST_MODE",
      "ENVEO_TEST_RUNNER",
      "OPENAI_API_KEY",
      "TEST_DATABASE_URL",
    ]);
    expect(result.plan.overrides.ENVEO_TEST_MODE).toBe("default");
  });

  it("points DATABASE_URL at an unroutable host, so the pooled db cannot reach a real server", () => {
    // resolveDatabaseUrl() otherwise falls back to postgres://enveo:enveo@localhost:5432/enveo,
    // which on a developer machine is a REAL running database.
    const result = planTestEnv("default", { DATABASE_URL: PROD_LIKE });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.overrides.DATABASE_URL).toBe(DEAD_DB_URL);
    expect(describeDbTarget(DEAD_DB_URL)?.port).toBe("1");
  });

  it("never prints a credential or a full URL in its banner", () => {
    const result = planTestEnv("default", {
      OPENAI_API_KEY: "sk-live-should-never-reach-the-child",
      TEST_DATABASE_URL: PROD_LIKE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.banner).not.toContain("s3cr3t-password");
    expect(result.plan.banner).not.toContain("sk-live");
    expect(result.plan.banner).not.toContain(PROD_LIKE);
  });
});

describe("planTestEnv — db mode", () => {
  const ok = {
    TEST_DATABASE_URL: THROWAWAY,
    ENVEO_TEST_DB_ACK: "throwaway",
    DATABASE_URL: PROD_LIKE,
    OPENAI_API_KEY: "sk-live-should-never-reach-the-child",
    AI_SAFETY_IDENTIFIER_SECRET: "ambient-secret-from-dotenv",
  };

  it("keeps the acknowledged throwaway URL and still disables AI (key AND safety secret)", () => {
    const result = planTestEnv("db", ok);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.overrides.TEST_DATABASE_URL).toBe(THROWAWAY);
    expect(result.plan.overrides.OPENAI_API_KEY).toBe("");
    expect(result.plan.overrides.AI_SAFETY_IDENTIFIER_SECRET).toBe("");
  });

  it("still blanks the app's own DATABASE_URL — only the throwaway may be reached", () => {
    const result = planTestEnv("db", ok);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.overrides.DATABASE_URL).toBe(DEAD_DB_URL);
  });

  it("reports the target as host:port/database only — no user, no password, no full URL", () => {
    const result = planTestEnv("db", ok);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.banner).toContain("127.0.0.1:5495/enveo");
    expect(result.plan.banner).not.toContain("enveo:enveo");
    expect(result.plan.banner).not.toContain(THROWAWAY);
  });

  it("refuses an empty or whitespace-only TEST_DATABASE_URL", () => {
    for (const url of [undefined, "", "   "]) {
      const result = planTestEnv("db", { ...ok, TEST_DATABASE_URL: url });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.join("\n")).toContain("TEST_DATABASE_URL");
    }
  });

  it("refuses a missing or wrong acknowledgement sentinel", () => {
    for (const ack of [undefined, "", "yes", "Throwaway"]) {
      const result = planTestEnv("db", { ...ok, ENVEO_TEST_DB_ACK: ack });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.join("\n")).toContain("ENVEO_TEST_DB_ACK=throwaway");
    }
  });

  it("refuses a test URL identical to DATABASE_URL", () => {
    const result = planTestEnv("db", { ...ok, TEST_DATABASE_URL: PROD_LIKE });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("must differ from DATABASE_URL");
  });

  it("refuses a test URL that only differs by credentials but hits the same database", () => {
    const result = planTestEnv("db", {
      ...ok,
      TEST_DATABASE_URL: "postgres://other:other@127.0.0.1:5432/enveo",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("same PostgreSQL target");
  });

  it("refuses an unparseable URL rather than handing it to the suite", () => {
    const result = planTestEnv("db", { ...ok, TEST_DATABASE_URL: "not a url" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("not a valid PostgreSQL URL");
  });

  it("accepts a genuinely separate database when DATABASE_URL is absent entirely", () => {
    const result = planTestEnv("db", {
      TEST_DATABASE_URL: THROWAWAY,
      ENVEO_TEST_DB_ACK: "throwaway",
    });

    expect(result.ok).toBe(true);
  });

  it("accepts the default host/port with a different database name", () => {
    const result = planTestEnv("db", {
      TEST_DATABASE_URL: "postgres://enveo:enveo@127.0.0.1:5432/enveotest",
      ENVEO_TEST_DB_ACK: "throwaway",
    });

    expect(result.ok).toBe(true);
  });

  // The check below must NOT depend on DATABASE_URL being set: `.env.example` ships it
  // COMMENTED OUT, so "unset" is the documented default, and resolveDatabaseUrl() then falls
  // back to localhost:5432/enveo — a real, running Enveo database on developer and self-host
  // machines. Accepting that as a "throwaway" would point the migrating, WRITING suites at it.
  it("refuses the default application database target even with DATABASE_URL unset", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]) {
      const result = planTestEnv("db", {
        TEST_DATABASE_URL: `postgres://enveo:whatever@${host}:5432/enveo`,
        ENVEO_TEST_DB_ACK: "throwaway",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.join("\n")).toContain("default application database target");
    }
  });

  it("refuses the default target written without an explicit port", () => {
    const result = planTestEnv("db", {
      TEST_DATABASE_URL: "postgres://enveo:whatever@localhost/enveo",
      ENVEO_TEST_DB_ACK: "throwaway",
    });

    expect(result.ok).toBe(false);
  });

  it("treats localhost and 127.0.0.1 as the SAME host when comparing with DATABASE_URL", () => {
    const result = planTestEnv("db", {
      DATABASE_URL: "postgres://app:app@127.0.0.1:5433/enveo",
      TEST_DATABASE_URL: "postgres://test:test@localhost:5433/enveo",
      ENVEO_TEST_DB_ACK: "throwaway",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("same PostgreSQL target");
  });

  it("treats ::1 as the same host as localhost", () => {
    const result = planTestEnv("db", {
      DATABASE_URL: "postgres://app:app@localhost:5433/enveo",
      TEST_DATABASE_URL: "postgres://test:test@[::1]:5433/enveo",
      ENVEO_TEST_DB_ACK: "throwaway",
    });

    expect(result.ok).toBe(false);
  });

  it("still accepts a different port or database on the same host", () => {
    const differentPort = planTestEnv("db", {
      DATABASE_URL: "postgres://app:app@127.0.0.1:5432/enveo",
      TEST_DATABASE_URL: "postgres://test:test@localhost:5499/enveo",
      ENVEO_TEST_DB_ACK: "throwaway",
    });
    const differentDb = planTestEnv("db", {
      DATABASE_URL: "postgres://app:app@127.0.0.1:5433/enveo",
      TEST_DATABASE_URL: "postgres://test:test@127.0.0.1:5433/enveotest",
      ENVEO_TEST_DB_ACK: "throwaway",
    });

    expect(differentPort.ok).toBe(true);
    expect(differentDb.ok).toBe(true);
  });

  it("collects every violation at once instead of failing on the first", () => {
    const result = planTestEnv("db", { TEST_DATABASE_URL: "", ENVEO_TEST_DB_ACK: "" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("describeDbTarget", () => {
  it("drops credentials and defaults the port", () => {
    expect(describeDbTarget("postgres://u:p@db.internal/enveo")).toEqual({
      host: "db.internal",
      port: "5432",
      database: "enveo",
      redacted: "db.internal:5432/enveo",
      key: "db.internal:5432/enveo",
    });
  });

  it("keeps the original host for display but canonicalises loopback in the key", () => {
    const target = describeDbTarget("postgres://u:p@127.0.0.1:5432/enveo");

    expect(target?.redacted).toBe("127.0.0.1:5432/enveo");
    expect(target?.key).toBe("localhost:5432/enveo");
    expect(describeDbTarget("postgres://u:p@[::1]:5432/enveo")?.key).toBe(target?.key);
  });

  it("returns null for a non-postgres or malformed URL", () => {
    expect(describeDbTarget("https://example.com/x")).toBeNull();
    expect(describeDbTarget("nonsense")).toBeNull();
  });
});
