/**
 * The one fetch layer for operator-key OpenAI calls (suggest, proxy, import).
 * The contract under test: a hung upstream ABORTS after timeoutMs (a vision call
 * must not pin the incoming HTTP request forever) and is TYPED as a timeout,
 * a dead upstream is TYPED as a network failure (the two must map to different
 * user-facing codes — a timeout is not "check the key and the model"), and a
 * healthy upstream gets the bearer key + JSON body unchanged.
 */
import { describe, expect, it } from "bun:test";
import { openAiChatFetch, openAiModelFetch, timeoutSignal, transportFailureJson, UpstreamNetworkError, UpstreamTimeoutError } from "./openaiHttp";

describe("timeoutSignal — AbortSignal.timeout built from AbortController + setTimeout (WebKit < 16)", () => {
  /** Fake timers: capture the callback, fire it by hand, record clears. */
  function fakeTimers() {
    let fire: (() => void) | null = null;
    const cleared: unknown[] = [];
    return {
      timers: {
        setTimeout: (fn: () => void, _ms: number) => {
          fire = fn;
          return "handle-1";
        },
        clearTimeout: (h: unknown) => {
          cleared.push(h);
        },
      },
      fireNow: () => fire?.(),
      cleared,
    };
  }

  it("aborts the signal and reports timedOut once the timer fires", () => {
    const { timers, fireNow } = fakeTimers();
    const t = timeoutSignal(120_000, timers);
    expect(t.signal.aborted).toBe(false);
    expect(t.timedOut()).toBe(false);
    fireNow();
    expect(t.signal.aborted).toBe(true);
    expect(t.timedOut()).toBe(true);
  });

  it("clear() cancels the pending timer on settle — no timer retained, no late abort", () => {
    const { timers, cleared } = fakeTimers();
    const t = timeoutSignal(120_000, timers);
    t.clear();
    expect(cleared).toEqual(["handle-1"]); // the exact handle setTimeout returned
    expect(t.signal.aborted).toBe(false);
    expect(t.timedOut()).toBe(false);
  });

  it("an abort from elsewhere is NOT a timeout (timedOut stays false)", () => {
    const { timers } = fakeTimers();
    const t = timeoutSignal(120_000, timers);
    // e.g. the runtime aborting the fetch for its own reasons — must not classify as ai_timeout
    expect(t.timedOut()).toBe(false);
  });
});

describe("transportFailureJson — the ONE mapping /ai proxies and screenshot-recognition routes share", () => {
  it("timeout → 504 {error:'ai_timeout'}", () => {
    expect(transportFailureJson(new UpstreamTimeoutError(120_000))).toEqual({ body: { error: "ai_timeout" }, status: 504 });
  });

  it("network failure → 502 {error:'ai_unreachable'}", () => {
    expect(transportFailureJson(new UpstreamNetworkError(new TypeError("fetch failed")))).toEqual({ body: { error: "ai_unreachable" }, status: 502 });
  });

  it("anything else (an upstream non-2xx, a parse error) is not ours → null", () => {
    expect(transportFailureJson(new Error("openai 401"))).toBeNull();
    expect(transportFailureJson(undefined)).toBeNull();
  });
});

describe("openAiChatFetch", () => {
  it("aborts a hung upstream after timeoutMs and types it UpstreamTimeoutError", async () => {
    const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      await expect(openAiChatFetch({ messages: [] }, { apiKey: "k", url: `http://127.0.0.1:${hang.port}/`, timeoutMs: 60 })).rejects.toBeInstanceOf(
        UpstreamTimeoutError,
      );
    } finally {
      hang.stop(true);
    }
  });

  it("types a dead upstream (connection refused) UpstreamNetworkError, not a timeout", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => Response.json({}) });
    const deadPort = probe.port;
    probe.stop(true); // freed → connection refused
    await expect(openAiChatFetch({ messages: [] }, { apiKey: "k", url: `http://127.0.0.1:${deadPort}/`, timeoutMs: 5_000 })).rejects.toBeInstanceOf(
      UpstreamNetworkError,
    );
  });

  it("passes the bearer key and the JSON payload through to the upstream", async () => {
    let seenAuth = "";
    let seenBody: unknown;
    const echo = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seenAuth = req.headers.get("authorization") ?? "";
        seenBody = await req.json();
        return Response.json({ ok: true });
      },
    });
    try {
      const res = await openAiChatFetch(
        { model: "m", messages: [{ role: "user", content: "hi" }] },
        { apiKey: "sk-test", url: `http://127.0.0.1:${echo.port}/`, timeoutMs: 2000 },
      );
      expect(res.ok).toBe(true);
      expect(seenAuth).toBe("Bearer sk-test");
      expect(seenBody).toEqual({ model: "m", messages: [{ role: "user", content: "hi" }] });
    } finally {
      echo.stop(true);
    }
  });

  it("a non-2xx upstream answer is RETURNED, never thrown — the route judges the status", async () => {
    const nope = Bun.serve({ port: 0, fetch: () => new Response("unauthorized", { status: 401 }) });
    try {
      const res = await openAiChatFetch({ messages: [] }, { apiKey: "bad", url: `http://127.0.0.1:${nope.port}/`, timeoutMs: 2000 });
      expect(res.status).toBe(401);
    } finally {
      nope.stop(true);
    }
  });
});

describe("openAiModelFetch", () => {
  it("tests one model with the user credential without sending a request body", async () => {
    let seen: { method: string; auth: string; path: string; body: string } | undefined;
    const echo = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        seen = { method: req.method, auth: req.headers.get("authorization") ?? "", path: url.pathname, body: await req.text() };
        return Response.json({ id: "gpt-5.6-luna" });
      },
    });
    try {
      const response = await openAiModelFetch("gpt-5.6-luna", { apiKey: "sk-user", baseUrl: `http://127.0.0.1:${echo.port}/v1/models`, timeoutMs: 2_000 });
      expect(response.ok).toBe(true);
      expect(seen).toEqual({ method: "GET", auth: "Bearer sk-user", path: "/v1/models/gpt-5.6-luna", body: "" });
    } finally {
      echo.stop(true);
    }
  });
});
