/**
 * The registration gate and the session cookie (spec §1).
 *
 *  - CONCURRENT REGISTRATION: on a selfhost deployment signups close once one credentialed
 *    user exists, so "the first account" is a one-shot privilege. Two first registrations
 *    racing each other must not BOTH win it. The gate (auth.ts) cannot rely on the advisory
 *    lock alone — the lock is released when the hook's transaction commits, which is BEFORE
 *    better-auth inserts the users/auth_accounts rows, so two overlapping sign-ups would both
 *    read zero accounts and both pass. It therefore commits a TTL'd claim row inside the
 *    locked transaction. This test drives two real sign-ups through the real better-auth
 *    instance and pins the invariant: exactly one 200, one 403 signups_closed, ONE credentialed
 *    user in the database.
 *
 *  - PLAIN-HTTP COOKIE: a self-hoster on a LAN without TLS must be able to log in, so the
 *    session cookie better-auth issues over an http:// base URL must NOT carry Secure (a
 *    Secure cookie is dropped by the browser on plain HTTP → login silently fails).
 *
 * The race is DB-backed (an advisory lock and a committed claim row are Postgres behaviour,
 * not something a mock can show). OPT-IN: set TEST_DATABASE_URL to a THROWAWAY Postgres —
 * this suite migrates and WRITES. CI provides a service container; locally:
 *   docker run -d --rm --name enveotest -e POSTGRES_USER=enveo \
 *     -e POSTGRES_PASSWORD=enveo -e POSTGRES_DB=enveotest \
 *     -p 127.0.0.1:5499:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://enveo:enveo@127.0.0.1:5499/enveotest \
 *     bun test packages/api/src/auth.test.ts
 * There is deliberately NO fallback to DATABASE_URL (that one points at real data).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
// Constant only — this module's app imports are lazy (see the file header), so importing it
// here does NOT pull env/db/client into the test process.
import { SENTINEL, type RaceOutput, type RaceResult } from "./auth.signup-race.test-child";
import * as s from "./db/schema";

/** Must match SIGNUP_GATE_LOCK in auth.ts. It is not exported, and importing auth.ts here
 *  would pin db/client to the ambient DATABASE_URL — see auth.signup-race.test-child.ts. The
 *  drift guard below fails loudly if the two ever diverge. */
const SIGNUP_GATE_LOCK = 815901;

/** Plain HTTP on purpose: this is what a LAN self-hoster runs. Nothing listens on it —
 *  the child calls auth.handler() in-process. */
const BASE_URL = "http://127.0.0.1:8095";

/** `Secure` as a cookie ATTRIBUTE (not the substring — "__Secure-" is a name prefix). */
const SECURE_ATTR = /(?:^|;\s*)secure\s*(?:;|$)/i;

const CHILD = new URL("./auth.signup-race.test-child.ts", import.meta.url).pathname;

/* ── better-auth's rule: Secure tracks the baseURL scheme (no DB needed) ──────
 *
 * Our config never sets `advanced.useSecureCookies`, so better-auth derives it from the
 * baseURL scheme. Pinning both directions keeps the plain-HTTP assertion below honest: it
 * proves "no Secure" is a consequence of the http:// base URL, and would fail if a
 * better-auth upgrade ever started forcing Secure (which would lock LAN self-hosters out). */

const cookieFor = (baseURL: string) =>
  betterAuth({ baseURL, secret: "a".repeat(64), emailAndPassword: { enabled: true } });

describe("session cookie: Secure follows the baseURL scheme", () => {
  it("an http:// base URL yields a cookie with NO Secure and no __Secure- prefix", async () => {
    const ctx = await cookieFor("http://192.168.1.10:8080").$context;
    expect(ctx.authCookies.sessionToken.attributes.secure).toBe(false);
    expect(ctx.authCookies.sessionToken.name).toBe("better-auth.session_token");
  });

  it("an https:// base URL still yields a Secure cookie (the rule is live, not disabled)", async () => {
    const ctx = await cookieFor("https://enveo.example").$context;
    expect(ctx.authCookies.sessionToken.attributes.secure).toBe(true);
    expect(ctx.authCookies.sessionToken.name).toBe("__Secure-better-auth.session_token");
  });
});

describe("the gate's advisory-lock id", () => {
  it("still matches the copy this test holds", async () => {
    const src = await Bun.file(new URL("./auth.ts", import.meta.url).pathname).text();
    expect(src).toContain(`const SIGNUP_GATE_LOCK = ${SIGNUP_GATE_LOCK};`);
  });
});

/* ── The race (DB-backed) ─────────────────────────────────────────────── */

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");
}

describe.skipIf(!TEST_URL)("signup gate: two concurrent first registrations", () => {
  let client: ReturnType<typeof postgres>;
  let gate: ReturnType<typeof postgres>;
  let out: RaceOutput;
  let bothParkedAtGate = false;
  let emailA = "";
  let emailB = "";

  const winner = () => out.results.find((r) => r.status === 200) as RaceResult | undefined;
  const loser = () => out.results.find((r) => r.status !== 200) as RaceResult | undefined;

  /** Both sign-ups are blocked inside the gate's locked section (pg_advisory_xact_lock waits
   *  on the session-level lock this test holds). Advisory key 815901 → classid 0, objid
   *  815901, objsubid 1. */
  const gateWaiters = async (): Promise<number> => {
    const rows = await gate<{ n: number }[]>`
      select count(*)::int as n from pg_locks
       where locktype = 'advisory' and classid::bigint = 0
         and objid::bigint = ${SIGNUP_GATE_LOCK} and objsubid = 1 and not granted`;
    return rows[0]?.n ?? 0;
  };

  beforeAll(async () => {
    client = postgres(TEST_URL, { max: 2, onnotice: () => {} });
    await migrate(drizzle(client, { schema: s }), {
      migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
    });

    // First-run state: no credentialed user (auth_accounts empty) and no live claim row.
    // Nothing else in the test suite writes these two tables.
    await client`delete from auth_accounts`;
    await client`delete from auth_verifications`;

    emailA = `race-a-${crypto.randomUUID()}@example.test`;
    emailB = `race-b-${crypto.randomUUID()}@example.test`;

    // Force the race instead of hoping for it. Holding the gate's advisory lock parks BOTH
    // sign-ups inside the gate — past password hashing, before either has inserted an account.
    // That is exactly the interleaving the claim row exists for; without this, one request
    // could simply finish before the other started and the test would pass vacuously.
    gate = postgres(TEST_URL, { max: 1, onnotice: () => {} });
    await gate`select pg_advisory_lock(${SIGNUP_GATE_LOCK})`;

    const child = Bun.spawn([process.execPath, CHILD], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        DATABASE_URL: TEST_URL,
        EXPECT_DATABASE_URL: TEST_URL,
        BETTER_AUTH_URL: BASE_URL,
        BETTER_AUTH_SECRET: crypto.randomUUID().replaceAll("-", "").repeat(2),
        DEPLOYMENT: "selfhost", // pin the scenario: signups close after the first account…
        ALLOW_SIGNUPS: "", // …and the operator has not re-opened them
        ALLOWED_ORIGINS: "",
        WEB_DIST: "",
        RACE_EMAIL_A: emailA,
        RACE_EMAIL_B: emailB,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if ((await gateWaiters()) >= 2) {
          bothParkedAtGate = true;
          break;
        }
        await Bun.sleep(50);
      }
    } finally {
      await gate`select pg_advisory_unlock(${SIGNUP_GATE_LOCK})`;
    }

    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const code = await child.exited;
    const line = stdout.split("\n").find((l) => l.startsWith(SENTINEL));
    if (code !== 0 || !line) {
      throw new Error(`signup-race child failed (exit ${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    out = JSON.parse(line.slice(SENTINEL.length)) as RaceOutput;
  });

  afterAll(async () => {
    await gate?.end();
    await client?.end();
  });

  it("both sign-ups really were in the gate at once (the race is not vacuous)", () => {
    expect(bothParkedAtGate).toBe(true);
  });

  it("exactly one wins; the other is refused with 403 signups_closed", () => {
    expect(out.results.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(loser()?.body).toContain("signups_closed");
  });

  it("only ONE credentialed user exists afterwards", async () => {
    const accounts = await client<{ userId: string }[]>`select user_id as "userId" from auth_accounts`;
    expect(accounts).toHaveLength(1);

    const users = await client<{ id: string; email: string }[]>`
      select id, email from users where email in (${emailA}, ${emailB})`;
    expect(users).toHaveLength(1);
    // …and it is the sign-up that returned 200 — the loser left no user row behind.
    expect(users[0]!.email).toBe(winner()!.email);
    expect(accounts[0]!.userId).toBe(users[0]!.id);
  });

  it("the winner's session cookie carries no Secure attribute (plain-HTTP base URL)", () => {
    expect(out.baseURL.startsWith("http://")).toBe(true);

    const session = winner()!.setCookie.find((c) => c.startsWith("better-auth.session_token="));
    expect(session).toBeDefined();
    expect(session!).toMatch(/HttpOnly/i);
    expect(session!).toMatch(/SameSite=Lax/i);
    // The point of the whole test: a Secure cookie is dropped by the browser over plain HTTP,
    // so a LAN self-hoster without TLS could never hold a session.
    expect(SECURE_ATTR.test(session!)).toBe(false);
    expect(out.sessionCookie.attributes.secure).toBe(false);
    expect(out.sessionCookie.name).toBe("better-auth.session_token");
  });
});
