import { describe, expect, it } from "bun:test";
import { assertServerSignOutSucceeded, normalizeServerSignOutFailure, serverSignOutOptions } from "./auth";

describe("server sign-out", () => {
  it("opts into site-data cleanup only for a verified persistent owner", async () => {
    const requests = [serverSignOutOptions(true), serverSignOutOptions(false)];

    expect(requests.map((request) => request.fetchOptions?.headers?.["x-enveo-clear-site-data"] ?? null)).toEqual(["persistent-current-owner", null]);
  });

  it("rejects a non-successful better-auth response", async () => {
    expect(() => assertServerSignOutSucceeded({ message: "failed" })).toThrow("server_sign_out_failed");
  });

  it("normalizes a transport failure without exposing provider prose", () => {
    expect(() => normalizeServerSignOutFailure(new Error("Failed to fetch"))).toThrow("server_sign_out_failed");
  });
});
