import { beforeAll, describe, expect, it } from "bun:test";
import { runChild } from "../api.test-support";
import { SENTINEL, type SpendRoutesChildOutput } from "./routes.spend.test-child";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");
}

const CHILD = new URL("./routes.spend.test-child.ts", import.meta.url).pathname;
const CHILD_TIMEOUT_MS = 120_000;

describe.skipIf(!TEST_URL)("spend budget route contracts (DB-backed, child process)", () => {
  let out: SpendRoutesChildOutput;

  beforeAll(async () => {
    out = await runChild<SpendRoutesChildOutput>({
      path: CHILD,
      testUrl: TEST_URL,
      sentinel: SENTINEL,
      cwd: new URL("../..", import.meta.url).pathname,
    });
  }, CHILD_TIMEOUT_MS);

  it("proxy success: upstream JSON forwarded with usage, exactly one check and one record, exact nano-USD charged", () => {
    expect(out.proxyOk).toEqual({ status: 200, usagePreserved: true, chargedExactCost: true, checks: 1, records: 1 });
  });

  it("proxy denial: 429 {error:'ai_budget_exhausted', retryAfterSeconds} + matching Retry-After, no upstream call, no record", () => {
    expect(out.proxyDenied.status).toBe(429);
    expect(out.proxyDenied.body.error).toBe("ai_budget_exhausted");
    expect(out.proxyDenied.retryAfterIsPositiveInt).toBe(true);
    expect(out.proxyDenied.retryAfterHeaderMatchesBody).toBe(true);
    expect(out.proxyDenied.upstreamNotCalled).toBe(true);
    expect(out.proxyDenied.records).toBe(0);
    // the body reveals ONLY the machine code and the retry hint — never spend or remaining dollars
    expect(Object.keys(out.proxyDenied.body).sort()).toEqual(["error", "retryAfterSeconds"]);
  });

  it("deprecated /ai/chat: same 429 contract while it exists; success still metered and charged", () => {
    expect(out.deprecatedChatDenied).toEqual({ status: 429, error: "ai_budget_exhausted", hasRetryAfterHeader: true });
    expect(out.deprecatedChatOk).toEqual({ status: 200, content: "plain answer", charged: true });
  });

  it("suggest denial: 200 with the LOCAL RULES fallback (warn.aiUnavailable), model never fetched", () => {
    expect(out.suggestDenied).toEqual({ status: 200, source: "rules", warnsAiUnavailable: true, upstreamNotCalled: true });
  });

  it("a STALLED counter fails OPEN: with the spend table exclusively locked, the answer still arrives inside the bounded deadlines", () => {
    expect(out.stalledCounter.status).toBe(200);
    expect(out.stalledCounter.contentOk).toBe(true);
    expect(out.stalledCounter.upstreamCalled).toBe(true);
    expect(out.stalledCounter.withinDeadlines).toBe(true);
  });
});
