/**
 * BYOK model availability check (backlog §1b): `GET /v1/models` with the user's key, matched
 * against the CURATED registry only (never auto-populated — the endpoint has no capability or
 * price metadata). The check is advisory: only a definite 200 verdict may disable an option;
 * an invalid key is its own state (the user should fix the key, not wonder about tiers); every
 * transport or shape surprise degrades to "unknown", which the UI treats as fully selectable.
 * The verdict is transient — nothing from the endpoint is ever persisted.
 */
import { describe, expect, it } from "bun:test";
import { checkModelAvailability } from "./openaiModels";

const CURATED = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.5-mini"] as const;

const jsonResponse = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
const modelsBody = (ids: string[]) => ({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });

describe("checkModelAvailability", () => {
  it("200: keeps ONLY curated ids from the answer (subset available)", async () => {
    const fetchFn = async () => jsonResponse(200, modelsBody(["gpt-5.6-luna", "gpt-5.6-sol", "whisper-1", "gpt-4o"]));
    const res = await checkModelAvailability("sk-test", CURATED, fetchFn);
    expect(res.state).toBe("checked");
    if (res.state !== "checked") throw new Error("unreachable");
    expect([...res.available].sort()).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
  });

  it("200: a full curated match reports every id available, and nothing beyond the curated list", async () => {
    const fetchFn = async () => jsonResponse(200, modelsBody([...CURATED, "o4-mini", "dall-e-3"]));
    const res = await checkModelAvailability("sk-test", CURATED, fetchFn);
    if (res.state !== "checked") throw new Error(`expected checked, got ${res.state}`);
    expect([...res.available].sort()).toEqual([...CURATED].sort());
  });

  it("sends a GET with the Bearer key to the models endpoint", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenMethod = "";
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenMethod = init?.method ?? "GET";
      seenAuth = (init?.headers as Record<string, string>)?.authorization ?? "";
      return jsonResponse(200, modelsBody([]));
    };
    await checkModelAvailability("sk-abc", CURATED, fetchFn);
    expect(seenUrl).toBe("https://api.openai.com/v1/models");
    expect(seenMethod).toBe("GET");
    expect(seenAuth).toBe("Bearer sk-abc");
  });

  it("401/403: the key itself is rejected — its own state, nothing disabled", async () => {
    for (const status of [401, 403]) {
      const fetchFn = async () => jsonResponse(status, { error: { message: "bad key" } });
      expect((await checkModelAvailability("sk-bad", CURATED, fetchFn)).state).toBe("invalid_key");
    }
  });

  it("other upstream errors (429/500) degrade to unknown — never a disabling verdict", async () => {
    for (const status of [429, 500, 503]) {
      const fetchFn = async () => jsonResponse(status, { error: { message: "boom" } });
      expect((await checkModelAvailability("sk-test", CURATED, fetchFn)).state).toBe("unknown");
    }
  });

  it("network failure (fetch rejects) degrades to unknown instead of throwing", async () => {
    const fetchFn = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect((await checkModelAvailability("sk-test", CURATED, fetchFn)).state).toBe("unknown");
  });

  it("a 200 whose body is not the expected list shape degrades to unknown", async () => {
    const bodies = [new Response("<html>captive portal</html>", { status: 200 }), jsonResponse(200, { data: "nope" }), jsonResponse(200, {})];
    for (const body of bodies) {
      const fetchFn = async () => body;
      expect((await checkModelAvailability("sk-test", CURATED, fetchFn)).state).toBe("unknown");
    }
  });

  it("entries without a string id are skipped, not fatal", async () => {
    const fetchFn = async () => jsonResponse(200, { data: [{ id: "gpt-5.6-terra" }, { id: 42 }, "junk", null] });
    const res = await checkModelAvailability("sk-test", CURATED, fetchFn);
    if (res.state !== "checked") throw new Error(`expected checked, got ${res.state}`);
    expect([...res.available]).toEqual(["gpt-5.6-terra"]);
  });
});
