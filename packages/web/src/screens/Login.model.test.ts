import { describe, expect, it } from "bun:test";
import { PRIVATE_DEVICE_DISCLOSURE, SHARED_DEVICE_DISCLOSURE } from "./Login";

describe("login device storage disclosure", () => {
  it("keeps the unauthenticated screen behind the existing boot decision boundary", async () => {
    const app = await Bun.file(`${import.meta.dir}/../App.tsx`).text();
    expect(app).not.toContain('import { LoginScreen } from "./screens/Login"');
    expect(app).toContain('lazy(() => import("./screens/Login")');
  });

  it("warns that a persistent local copy is readable through the browser profile", () => {
    expect(PRIVATE_DEVICE_DISCLOSURE).toBe(
      "Keep me signed in and save a local copy so Enveo works without internet. Anyone who can access this browser profile may be able to read that copy.",
    );
  });

  it("promises only that the new session will not create a persistent copy", () => {
    expect(SHARED_DEVICE_DISCLOSURE).toBe("No new local copy will be saved. This browser session ends when you close the app.");
    expect(SHARED_DEVICE_DISCLOSURE).not.toContain("remove");
    expect(SHARED_DEVICE_DISCLOSURE).not.toContain("erase");
  });
});
