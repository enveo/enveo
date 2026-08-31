import { describe, expect, it } from "bun:test";
import api from "./index";

const GENERAL_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

function oversizedRequest(path: string): Request {
  const body = JSON.stringify({ padding: "x".repeat(GENERAL_BODY_LIMIT_BYTES) });
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("API request body limits", () => {
  it("allows import framing above 16 MiB to reach authentication while rejecting the same body elsewhere", async () => {
    const importResponse = await api.fetch(oversizedRequest("/api/import/jobs"));
    const unrelatedResponse = await api.fetch(oversizedRequest("/api/sync/replace"));

    expect(importResponse.status).toBe(401);
    expect(await importResponse.json()).toEqual({ error: "unauthorized" });
    expect(unrelatedResponse.status).toBe(413);
    expect(await unrelatedResponse.json()).toEqual({ error: "too_large" });
  });
});
