/**
 * The per-request OWNER assertion on the demo/reset writes (pure — no DB touched).
 *
 * /budget/reset wipes the session user's ENTIRE budget and /demo/seed fills it —
 * both resolve the target budget from the session cookie alone, and the cookie can be
 * swapped between the client's ownership check and the request (a sign-out+sign-in in
 * another tab). Like /sync/replace, the body therefore names the USER the client just
 * verified, and a mismatch is refused BEFORE anything is written.
 *
 * The tests run the real handlers behind a fake session middleware; the mismatch path
 * must answer 409 without ever opening a database connection (this suite sets no
 * TEST_DATABASE_URL and must stay DB-free).
 */
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { demoRoutes, resetInput, seedInput } from "./demo";

const appAs = (sessionUserId: string) =>
  new Hono<{ Variables: { userId?: string } }>()
    .use(async (c, next) => {
      c.set("userId", sessionUserId);
      await next();
    })
    .route("/", demoRoutes);

const post = (app: ReturnType<typeof appAs>, path: string, body: unknown) =>
  app.fetch(
    new Request(`http://x${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("overwrite routes: /budget/reset carries the per-request owner assertion", () => {
  it("the reset body accepts an optional userId next to the confirm literal", () => {
    expect(resetInput.safeParse({ confirm: "RESET" }).success).toBe(true);
    expect(resetInput.safeParse({ confirm: "RESET", userId: "user-A" }).success).toBe(true);
    expect(resetInput.safeParse({ confirm: "RESET", userId: "" }).success).toBe(false);
  });

  it("a reset naming ANOTHER user than the session's → 409 budget_mismatch, nothing written", async () => {
    const res = await post(appAs("user-B"), "/budget/reset", { confirm: "RESET", userId: "user-A" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("budget_mismatch");
  });
});

describe("overwrite routes: /demo/seed carries the per-request owner assertion", () => {
  it("the seed body accepts an optional userId next to the locale", () => {
    expect(seedInput.safeParse({}).success).toBe(true);
    expect(seedInput.safeParse({ locale: "en", userId: "user-A" }).success).toBe(true);
    expect(seedInput.safeParse({ userId: "" }).success).toBe(false);
  });

  it("a seed naming ANOTHER user than the session's → 409 budget_mismatch, nothing written", async () => {
    const res = await post(appAs("user-B"), "/demo/seed", { locale: "en", userId: "user-A" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("budget_mismatch");
  });
});
