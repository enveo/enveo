/**
 * The metered operator transport (backlog §1): check → fetch → parse → best-effort record,
 * with the full failure-path no-charge matrix and fail-open counter semantics. Everything runs
 * against the injectable seams (`operatorAiDeps`) — no network, no database, no OpenAI.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { UpstreamTimeoutError } from "../openaiHttp";
import type { SpendCheck } from "./counter";
import { assertAiSpendEnv, meteredOperatorChat, operatorAiDeps, operatorChatPayload, SpendDenied } from "./transport";

const ORIGINAL = { ...operatorAiDeps };
afterEach(() => Object.assign(operatorAiDeps, ORIGINAL));

const USAGE = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
const USAGE_COST = 1000n * 200n + 100n * 1_200n; // luna standard rates

const okBody = (over: Record<string, unknown> = {}) => ({
  model: "gpt-5.6-luna",
  choices: [{ message: { role: "assistant", content: "hello" } }],
  usage: USAGE,
  ...over,
});

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = { "x-request-id": "req_1" }): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type Calls = { check: number; record: Array<{ policy: string; userId: string; periodKey: string; actualNanoUsd: bigint }>; fetch: number };

/** Wire the seams for one scenario; returns the call log. */
function wire(opts: {
  metering?: boolean;
  check?: SpendCheck | "throws";
  response?: () => Response | Promise<Response>;
  record?: "ok" | "throws" | "hangs";
}): Calls {
  const calls: Calls = { check: 0, record: [], fetch: 0 };
  operatorAiDeps.meteringActive = () => opts.metering ?? true;
  operatorAiDeps.checkSpend = async () => {
    calls.check++;
    if (opts.check === "throws") throw new Error("db down");
    return opts.check ?? { allowed: true, periodKey: "2026-08", recordedNanoUsd: 0n };
  };
  operatorAiDeps.recordSpend = async (i) => {
    calls.record.push(i);
    if (opts.record === "throws") throw new Error("db write failed");
    if (opts.record === "hangs") return new Promise<never>(() => {});
  };
  operatorAiDeps.fetchChat = async () => {
    calls.fetch++;
    return (opts.response ?? (() => jsonRes(okBody())))();
  };
  operatorAiDeps.safetyIdentifier = () => null;
  return calls;
}

const attempt = (userId: string | undefined = "user-1") => meteredOperatorChat({ userId, payload: { model: "gpt-5.6-luna", messages: [] } });

describe("meteredOperatorChat — admission", () => {
  it("selfhost (metering inactive): the counter adapters are NEVER invoked and the call proceeds", async () => {
    const calls = wire({ metering: false });
    const out = await attempt();
    expect(out.kind).toBe("ok");
    expect(calls.check).toBe(0);
    expect(calls.record).toEqual([]);
    expect(calls.fetch).toBe(1);
  });

  it("a non-HTTP caller (no userId) is never metered", async () => {
    const calls = wire({});
    const out = await meteredOperatorChat({ userId: undefined, payload: { model: "gpt-5.6-luna", messages: [] } });
    expect(out.kind).toBe("ok");
    expect(calls.check).toBe(0);
  });

  it("denied: no upstream request is made, no record happens, retryAfterSeconds is surfaced", async () => {
    const calls = wire({ check: { allowed: false, periodKey: "2026-08", retryAfterSeconds: 1234 } });
    const out = await attempt();
    expect(out).toEqual({ kind: "denied", retryAfterSeconds: 1234 });
    expect(calls.fetch).toBe(0);
    expect(calls.record).toEqual([]);
  });

  it("counter READ failure fails OPEN: the attempt proceeds and nothing is recorded", async () => {
    const calls = wire({ check: "throws" });
    const out = await attempt();
    expect(out.kind).toBe("ok");
    expect(calls.fetch).toBe(1);
    expect(calls.record).toEqual([]); // no periodKey without a successful check — no charge
  });

  it("a STALLED counter read is cut by the bounded deadline and fails OPEN (decision 7: no counter problem may degrade the AI path)", async () => {
    const calls = wire({});
    operatorAiDeps.checkSpend = () => {
      calls.check++;
      return new Promise(() => {}); // a degraded-but-up database: the query never settles
    };
    const started = Date.now();
    const out = await attempt();
    expect(out.kind).toBe("ok"); // the upstream attempt happened anyway
    expect(calls.fetch).toBe(1);
    expect(calls.record).toEqual([]); // no checked period → uncharged
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it("each attempt is checked independently (per-attempt, not per-route)", async () => {
    const calls = wire({});
    await attempt();
    await attempt();
    expect(calls.check).toBe(2);
    expect(calls.record.length).toBe(2);
  });
});

describe("meteredOperatorChat — recording actual usage", () => {
  it("a successful response records exactly the usage-derived nano-USD into the CHECKED period", async () => {
    const calls = wire({ check: { allowed: true, periodKey: "2026-07", recordedNanoUsd: 5n } });
    const out = await attempt();
    expect(out.kind).toBe("ok");
    expect(calls.record).toEqual([{ policy: "operator-ai", userId: "user-1", periodKey: "2026-07", actualNanoUsd: USAGE_COST }]);
  });

  it("returns the ORIGINAL upstream JSON (usage preserved) and the extracted content", async () => {
    const calls = wire({ response: () => jsonRes(okBody({ extra: "field" })) });
    const out = await attempt();
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.json.usage).toEqual(USAGE);
    expect(out.json.extra).toBe("field");
    expect(out.content).toBe("hello");
    expect(calls.fetch).toBe(1);
  });

  it("record FAILURE fails open: the answer is returned unchanged", async () => {
    const calls = wire({ record: "throws" });
    const out = await attempt();
    expect(out.kind).toBe("ok");
    expect(calls.record.length).toBe(1);
  });

  it("a HANGING record is cut by the bounded deadline and the answer still returns", async () => {
    wire({ record: "hangs" });
    const started = Date.now();
    const out = await attempt();
    expect(out.kind).toBe("ok");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);
});

describe("meteredOperatorChat — the no-charge matrix (answer never degraded)", () => {
  const cases: Array<[string, () => Response, "ok" | "upstream_error" | "invalid_body"]> = [
    ["missing usage", () => jsonRes(okBody({ usage: undefined })), "ok"],
    ["malformed usage counters", () => jsonRes(okBody({ usage: { prompt_tokens: -1, completion_tokens: 2 } })), "ok"],
    ["unknown response model", () => jsonRes(okBody({ model: "gpt-7-experimental" })), "ok"],
    ["missing response model", () => jsonRes(okBody({ model: undefined })), "ok"],
    ["upstream 401", () => jsonRes({ error: { message: "bad key" } }, 401), "upstream_error"],
    ["upstream 500", () => jsonRes({}, 500), "upstream_error"],
    ["unreadable 2xx body", () => new Response("<html>", { status: 200 }), "invalid_body"],
    ["2xx JSON that is not an object", () => jsonRes([1, 2, 3]), "invalid_body"],
  ];

  for (const [name, response, kind] of cases) {
    it(`${name} → outcome "${kind}", NO charge`, async () => {
      const calls = wire({ response });
      const out = await attempt();
      expect(out.kind).toBe(kind);
      expect(calls.record).toEqual([]);
    });
  }

  it("a transport timeout propagates as the classified error and records nothing", async () => {
    const calls = wire({});
    operatorAiDeps.fetchChat = async () => {
      calls.fetch++;
      throw new UpstreamTimeoutError(120_000);
    };
    await expect(attempt()).rejects.toBeInstanceOf(UpstreamTimeoutError);
    expect(calls.record).toEqual([]);
  });

  it("an upstream error surfaces status, detail (for the server log) and x-request-id", async () => {
    wire({ response: () => jsonRes({ error: { message: "quota" } }, 429, { "x-request-id": "req_err" }) });
    const out = await attempt();
    expect(out).toEqual({ kind: "upstream_error", status: 429, detail: JSON.stringify({ error: { message: "quota" } }), requestId: "req_err" });
  });
});

describe("meteredOperatorChat — payload and safety identifier", () => {
  it("attaches safety_identifier when derivable and never mutates the caller's payload", async () => {
    let sent: Record<string, unknown> | undefined;
    wire({});
    operatorAiDeps.safetyIdentifier = (userId) => (userId ? `sid-${userId}` : null);
    operatorAiDeps.fetchChat = async (payload) => {
      sent = payload as Record<string, unknown>;
      return jsonRes(okBody());
    };
    const mine: Record<string, unknown> & { model: string } = { model: "gpt-5.6-luna", messages: [] };
    await meteredOperatorChat({ userId: "user-9", payload: mine });
    expect(sent?.safety_identifier).toBe("sid-user-9");
    expect(mine.safety_identifier).toBeUndefined();
  });

  it("omits safety_identifier when the deriver yields null (no secret / no user)", async () => {
    let sent: Record<string, unknown> | undefined;
    wire({});
    operatorAiDeps.fetchChat = async (payload) => {
      sent = payload as Record<string, unknown>;
      return jsonRes(okBody());
    };
    await attempt();
    expect("safety_identifier" in (sent ?? {})).toBe(false);
  });

  it("operatorChatPayload uses the OPERATOR model and gates reasoning_effort by support", () => {
    const p = operatorChatPayload({ messages: [{ role: "user", content: "x" }], reasoningEffort: "low" });
    expect(typeof p.model).toBe("string"); // env.OPENAI_MODEL — never client-supplied
    expect(p.messages).toEqual([{ role: "user", content: "x" }]);
  });
});

describe("SpendDenied", () => {
  it("carries the machine code and retryAfterSeconds for the 429 contract", () => {
    const e = new SpendDenied(77);
    expect(e.message).toBe("ai_budget_exhausted");
    expect(e.retryAfterSeconds).toBe(77);
  });
});

describe("assertAiSpendEnv — boot guard", () => {
  const base = {
    deployment: "cloud" as const,
    allowSignups: "",
    openaiApiKey: "sk-x",
    openaiModel: "gpt-5.6-luna",
    aiSafetyIdentifierSecret: "",
    betterAuthSecret: "auth-secret-0123456789-0123456789",
  };

  it("cloud + operator key + priced model boots", () => {
    expect(() => assertAiSpendEnv(base)).not.toThrow();
  });
  it("cloud + operator key + UNPRICED model override refuses to boot (cannot spend at Luna's prices)", () => {
    expect(() => assertAiSpendEnv({ ...base, openaiModel: "gpt-5.5" })).toThrow(/no enabled price entry/);
  });
  it("selfhost keeps OPENAI_MODEL as a free override", () => {
    expect(() => assertAiSpendEnv({ ...base, deployment: "selfhost", openaiModel: "gpt-5.5" })).not.toThrow();
  });
  it("cloud without an operator key does not require a price entry", () => {
    expect(() => assertAiSpendEnv({ ...base, openaiApiKey: "", openaiModel: "gpt-5.5" })).not.toThrow();
  });
  it("a safety-identifier secret equal to the auth secret refuses to boot (dedicated secret rule)", () => {
    expect(() => assertAiSpendEnv({ ...base, aiSafetyIdentifierSecret: base.betterAuthSecret })).toThrow(/DEDICATED/);
  });
  it("a distinct safety-identifier secret is accepted", () => {
    expect(() => assertAiSpendEnv({ ...base, aiSafetyIdentifierSecret: "another-secret-0123456789-01234" })).not.toThrow();
  });
});
