import { describe, expect, it } from "bun:test";
import { authMetaBody, signupsOpen } from "./authPolicy";

const base = { deployment: "selfhost" as const, allowSignups: "", hasCredentialedUser: true };

describe("signupsOpen", () => {
  it("selfhost: closed once a credentialed user exists", () => {
    expect(signupsOpen(base)).toBe(false);
  });
  it("selfhost first run (no credentialed user): open", () => {
    expect(signupsOpen({ ...base, hasCredentialedUser: false })).toBe(true);
  });
  it("selfhost with ALLOW_SIGNUPS=1: open", () => {
    expect(signupsOpen({ ...base, allowSignups: "1" })).toBe(true);
  });
  it("cloud: always open", () => {
    expect(signupsOpen({ ...base, deployment: "cloud" })).toBe(true);
  });
});

describe("authMetaBody", () => {
  it("exposes exactly signupsOpen/firstRun/providers/deployment and nothing else", () => {
    const b = authMetaBody({ deployment: "selfhost", allowSignups: "", hasCredentialedUser: false }, true);
    expect(b).toEqual({ signupsOpen: true, firstRun: true, providers: { google: true }, deployment: "selfhost" });
    expect(Object.keys(b).sort()).toEqual(["deployment", "firstRun", "providers", "signupsOpen"]);
  });
  it("cloud deployment is named as such (drives the client's device-trust default)", () => {
    const b = authMetaBody({ deployment: "cloud", allowSignups: "", hasCredentialedUser: true }, false);
    expect(b.deployment).toBe("cloud");
  });
});
