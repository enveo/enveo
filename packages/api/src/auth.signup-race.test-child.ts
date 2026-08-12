/**
 * Child process for the concurrent-registration test in auth.test.ts — NOT a test file
 * itself (bun's runner only picks up *.test.ts).
 *
 * WHY A SEPARATE PROCESS. `auth.ts` imports `db/client.ts`, which builds its Postgres pool
 * from `env.DATABASE_URL` at IMPORT time, and bun's test runner shares ONE module registry
 * across every test file in a run: whichever suite imports `db/client` first pins that pool
 * for the whole process (`routes/sync.ts` already does, and locally `DATABASE_URL` is the
 * developer's REAL database). Importing the real `auth` instance inside the test process
 * would therefore run the signup gate — which WRITES users — against whatever database was
 * loaded first. A fresh process gets a fresh registry and the DATABASE_URL we hand it; the
 * EXPECT_DATABASE_URL fuse below refuses to run if those two ever disagree, so this can
 * never sign up users into a real database.
 *
 * Contract (all app imports are lazy, so the test can import SENTINEL from here without
 * pulling in env/db/client):
 *   in  — EXPECT_DATABASE_URL, RACE_EMAIL_A, RACE_EMAIL_B (+ the usual auth env)
 *   out — one SENTINEL-prefixed JSON line on stdout: {baseURL, results[], sessionCookie}
 */

export const SENTINEL = "__SIGNUP_RACE__";

export type RaceResult = {
  email: string;
  status: number;
  body: string;
  setCookie: string[];
};

export type RaceOutput = {
  baseURL: string;
  results: RaceResult[];
  /** The REAL auth instance's session-cookie config (better-auth derives it from baseURL). */
  sessionCookie: { name: string; attributes: Record<string, unknown> };
};

async function main(): Promise<void> {
  const expected = process.env.EXPECT_DATABASE_URL ?? "";
  const { env } = await import("./env");
  // The fuse: this process is about to CREATE USERS. It may only ever do that against the
  // throwaway database the test handed it.
  if (!expected || env.DATABASE_URL !== expected) {
    throw new Error(`refusing to run: env.DATABASE_URL is not the throwaway database given by the test ` + `(EXPECT_DATABASE_URL=${expected || "<unset>"})`);
  }

  const emailA = process.env.RACE_EMAIL_A ?? "";
  const emailB = process.env.RACE_EMAIL_B ?? "";
  if (!emailA || !emailB) throw new Error("RACE_EMAIL_A and RACE_EMAIL_B are required");

  const { auth } = await import("./auth");
  const { sql } = await import("./db/client");

  const base = env.BETTER_AUTH_URL;
  const origin = new URL(base).origin;
  const signUp = (email: string) =>
    auth.handler(
      new Request(`${base}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ name: "Race", email, password: "correct-horse-battery-staple" }),
      }),
    );

  // Both requests are started BEFORE either is awaited — two first registrations genuinely
  // in flight at once. The test additionally holds the gate's advisory lock while this runs,
  // so both are guaranteed to be parked INSIDE the gate before either can proceed.
  const inFlightA = signUp(emailA);
  const inFlightB = signUp(emailB);
  const [resA, resB] = await Promise.all([inFlightA, inFlightB]);

  const describe = async (res: Response, email: string): Promise<RaceResult> => ({
    email,
    status: res.status,
    body: await res.text(),
    setCookie: res.headers.getSetCookie(),
  });

  const ctx = await auth.$context;
  const cookie = ctx.authCookies.sessionToken;
  const out: RaceOutput = {
    baseURL: base,
    results: [await describe(resA, emailA), await describe(resB, emailB)],
    sessionCookie: { name: cookie.name, attributes: cookie.attributes as Record<string, unknown> },
  };

  await sql.end({ timeout: 5 });
  await Bun.write(Bun.stdout, `${SENTINEL}${JSON.stringify(out)}\n`);
  process.exit(0);
}

// Only when RUN as a process — importing this module (for SENTINEL) must have no side effects.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
