import { describe, expect, it } from "bun:test";
import { signupsOpen } from "./authPolicy";

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
