import { describe, expect, it } from "bun:test";
import { assertServerSignOutSucceeded, normalizeServerSignOutFailure, serverSignOutOptions } from "./auth";

async function runChild(scenario: "success" | "error" | "network") {
  const child = Bun.spawn([process.execPath, "packages/web/src/lib/auth.test-child.ts", scenario], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, stderr).toBe(0);
  return JSON.parse(stdout) as {
    observed: { method: string; path: string; cleanupHeader: string | null };
    outcome: string;
    coordinationMarker: string;
  };
}

describe("server sign-out", () => {
  it("never opts into Clear-Site-Data because logout finalization still needs coordination storage", async () => {
    const requests = [serverSignOutOptions(), serverSignOutOptions()];

    expect(requests.map((request) => request.fetchOptions?.headers?.["x-enveo-clear-site-data"] ?? null)).toEqual([null, null]);
  });

  it("rejects a non-successful better-auth response", async () => {
    expect(() => assertServerSignOutSucceeded({ message: "failed" })).toThrow("server_sign_out_failed");
  });

  it("normalizes a transport failure without exposing provider prose", () => {
    expect(() => normalizeServerSignOutFailure(new Error("Failed to fetch"))).toThrow("server_sign_out_failed");
  });

  it("uses the actual better-auth POST without a cleanup header", async () => {
    expect(await runChild("success")).toEqual({
      observed: { method: "POST", path: "/api/auth/sign-out", cleanupHeader: null },
      outcome: "ok",
      coordinationMarker: "live",
    });
  });

  it("normalizes actual non-2xx and network failures", async () => {
    expect((await runChild("error")).outcome).toBe("server_sign_out_failed");
    expect((await runChild("network")).outcome).toBe("server_sign_out_failed");
  });
});
