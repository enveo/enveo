/**
 * Pure tests for the test-runner environment contract (§3a).
 *
 * The point of `scripts/run-tests.ts` is that a local `.env` (bun auto-loads it) must never
 * decide what the test suite talks to. These tests pin that decision as pure logic, so the
 * process layer only has to spawn what `planTestEnv` returns.
 */
import { describe, expect, it } from "bun:test";
import { describeDbTarget, planTestEnv } from "./testEnv";

const PROD_LIKE = "postgres://enveo:s3cr3t-password@127.0.0.1:5432/enveo";
const THROWAWAY = "postgres://enveo:enveo@127.0.0.1:5495/enveo";

describe("planTestEnv — default mode", () => {
  it("forces both sensitive variables empty even when the parent supplied them", () => {
    const result = planTestEnv("default", {
      OPENAI_API_KEY: "sk-live-should-never-reach-the-child",
      TEST_DATABASE_URL: PROD_LIKE,
      DATABASE_URL: PROD_LIKE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.overrides.OPENAI_API_KEY).toBe("");
    expect(result.plan.overrides.TEST_DATABASE_URL).toBe("");
  });

  it("overrides only those two variables and never needs a sentinel", () => {
    const result = planTestEnv("default", {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.plan.overrides).sort()).toEqual([
      "OPENAI_API_KEY",
      "TEST_DATABASE_URL",
    ]);
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
  };

  it("keeps the acknowledged throwaway URL and still disables AI", () => {
    const result = planTestEnv("db", ok);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.overrides.TEST_DATABASE_URL).toBe(THROWAWAY);
    expect(result.plan.overrides.OPENAI_API_KEY).toBe("");
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

  it("accepts a throwaway URL when DATABASE_URL is absent entirely", () => {
    const result = planTestEnv("db", {
      TEST_DATABASE_URL: THROWAWAY,
      ENVEO_TEST_DB_ACK: "throwaway",
    });

    expect(result.ok).toBe(true);
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
    });
  });

  it("returns null for a non-postgres or malformed URL", () => {
    expect(describeDbTarget("https://example.com/x")).toBeNull();
    expect(describeDbTarget("nonsense")).toBeNull();
  });
});
