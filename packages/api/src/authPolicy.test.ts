import { describe, expect, it } from "bun:test";
import { authMetaBody, operatorAiSpendLimited, signupsOpen } from "./authPolicy";

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

describe("operatorAiSpendLimited (backlog §1 — cloud operator-key AI spend budget)", () => {
  const cloud = { deployment: "cloud" as const, allowSignups: "", operatorKeyPresent: true };

  it("cloud with open registration and an operator key: limited", () => {
    expect(operatorAiSpendLimited(cloud)).toBe(true);
  });
  it("cloud without an operator key: nothing to protect (byok charges the user's key; off sends nothing)", () => {
    expect(operatorAiSpendLimited({ ...cloud, operatorKeyPresent: false })).toBe(false);
  });
  it("selfhost with closed registration: bypasses all spend reads/writes", () => {
    expect(operatorAiSpendLimited({ deployment: "selfhost", allowSignups: "", operatorKeyPresent: true })).toBe(false);
  });
  it("selfhost with ALLOW_SIGNUPS=1: deliberately NOT limited (decision 6 — the docs warn instead)", () => {
    expect(operatorAiSpendLimited({ deployment: "selfhost", allowSignups: "1", operatorKeyPresent: true })).toBe(false);
  });
  it("follows the authoritative signup policy on cloud (open today under every credentialed state)", () => {
    // signupsOpen(cloud) is true regardless of the other inputs — pin the coupling so a future
    // "closed cloud" policy change automatically turns the limiter off with registration.
    expect(signupsOpen({ deployment: "cloud", allowSignups: "", hasCredentialedUser: true })).toBe(true);
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
