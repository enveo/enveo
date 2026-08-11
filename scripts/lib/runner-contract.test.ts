/**
 * End-to-end proof of the test-runner contract (§3a), asserted FROM INSIDE the child.
 *
 * testEnv.test.ts proves the decision; this proves the delivery. When the suite runs under
 * `bun run test` / `bun run test:db`, the environment it actually received must be the one
 * run-tests.ts promised — no matter what an auto-loaded `.env` contained. It self-skips when
 * somebody runs `bun test <path>` directly, because then no contract was promised.
 */
import { describe, expect, it } from "bun:test";
import { describeDbTarget, RUNNER_MARKER, RUNNER_MARKER_VALUE, RUNNER_MODE } from "./testEnv";

const underRunner = process.env[RUNNER_MARKER] === RUNNER_MARKER_VALUE;
const mode = process.env[RUNNER_MODE];

describe.skipIf(!underRunner)("environment delivered by run-tests.ts", () => {
  it("always disables AI, whatever .env held", () => {
    expect(process.env.OPENAI_API_KEY ?? "").toBe("");
  });

  it("declares a known mode", () => {
    expect(["default", "db"]).toContain(mode);
  });

  it.skipIf(mode !== "default")("default mode: no test database is reachable at all", () => {
    expect(process.env.TEST_DATABASE_URL ?? "").toBe("");
  });

  it.skipIf(mode !== "db")("db mode: a valid test database that is not the app's", () => {
    const url = process.env.TEST_DATABASE_URL ?? "";
    expect(url).not.toBe("");
    expect(describeDbTarget(url)).not.toBeNull();
    if (process.env.DATABASE_URL) expect(url).not.toBe(process.env.DATABASE_URL);
  });
});
