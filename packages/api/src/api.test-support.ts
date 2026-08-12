/**
 * Shared helpers for the DB-backed test CHILD PROCESSES and the suites that drive them.
 *
 * WHY THIS FILE EXISTS. Several DB-backed scenarios must run in a child process, because the
 * app's pooled `db` (db/client.ts) builds its Postgres pool from `env.DATABASE_URL` at IMPORT
 * time and bun's test runner shares ONE module registry per run — whichever suite imports
 * `db/client` first pins that pool for the whole process, and locally `DATABASE_URL` points at
 * a REAL database. Each child therefore carries a fuse (`assertThrowawayDb`) that refuses to
 * run unless the URL it resolved is the throwaway one the test handed it. That fuse is the
 * safety mechanism keeping these writers away from real data, so it lives in ONE place: five
 * diverging copies would mean a future hardening fix lands in some children and not others.
 *
 * NOT a test file (bun's runner only picks up *.test.ts) and deliberately SIDE-EFFECT FREE:
 * no `env`/`db` import at module scope, so a parent suite can import `runChild` without
 * pulling the pool into its own process.
 */
import type postgres from "postgres";

/**
 * The fuse. `resolvedUrl` is what the child's own `env.DATABASE_URL` resolved to; it must equal
 * the EXPECT_DATABASE_URL the test handed over. Throws otherwise — a child that writes rows,
 * takes advisory locks or wipes a budget may only ever do that against throwaway Postgres.
 */
export function assertThrowawayDb(resolvedUrl: string): void {
  const expected = process.env.EXPECT_DATABASE_URL ?? "";
  if (!expected || resolvedUrl !== expected) {
    throw new Error(`refusing to run: env.DATABASE_URL is not the throwaway database given by the test ` + `(EXPECT_DATABASE_URL=${expected || "<unset>"})`);
  }
}

/** Rejects with `timeout after <ms>ms: <label>` — turns a lock-wait bug into a named failure. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    Bun.sleep(ms).then((): never => {
      throw new Error(`timeout after ${ms}ms: ${label}`);
    }),
  ]);
}

/**
 * Poll `probe` until it reports true, at most `attempts` times. Used to OBSERVE a forced
 * interleaving (a waiter actually parked on a lock) instead of hoping for lucky timing.
 * Returns whether the condition was observed.
 */
export async function waitFor(
  probe: () => Promise<boolean>,
  { attempts = 200, intervalMs = 25 }: { attempts?: number; intervalMs?: number } = {},
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await probe()) return true;
    await Bun.sleep(intervalMs);
  }
  return false;
}

/** Advisory-lock observation over an INDEPENDENT connection (never the app's pool). */
export function lockObserver(sql: ReturnType<typeof postgres>) {
  return {
    /** Ungranted advisory waiters, optionally EXCLUDING one 64-bit key (e.g. the changes cursor).
     *  The key may arrive as a string — postgres.js hands back bigint columns as strings. */
    async waiters(exceptKey?: bigint | number | string): Promise<number> {
      const rows =
        exceptKey === undefined
          ? await sql<{ n: number }[]>`
              select count(*)::int as n from pg_locks
               where locktype = 'advisory' and not granted`
          : await sql<{ n: number }[]>`
              select count(*)::int as n from pg_locks
               where locktype = 'advisory' and not granted
                 and not (classid = ((${String(exceptKey)}::bigint >> 32) & 4294967295)::oid
                          and objid = (${String(exceptKey)}::bigint & 4294967295)::oid
                          and objsubid = 1)`;
      return rows[0]?.n ?? 0;
    },
    /** Granted advisory locks held by one backend pid — proves lock and work share a connection. */
    async heldByPid(pid: number): Promise<number> {
      const rows = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_locks
         where locktype = 'advisory' and granted and pid = ${pid}`;
      return rows[0]?.n ?? 0;
    },
  };
}

/** Writes the child's single SENTINEL-prefixed result line to stdout. */
export async function emitChildResult(sentinel: string, out: unknown): Promise<void> {
  await Bun.write(Bun.stdout, `${sentinel}${JSON.stringify(out)}\n`);
}

/**
 * Spawns a child scenario with the throwaway `DATABASE_URL` (+ the matching fuse value) and
 * parses its single SENTINEL line. A non-zero exit or a missing line raises with the child's
 * full stdout/stderr — a silently swallowed child failure would make a suite pass vacuously.
 */
export async function runChild<T>(opts: { path: string; testUrl: string; sentinel: string; cwd: string; env?: Record<string, string> }): Promise<T> {
  const child = Bun.spawn([process.execPath, opts.path], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      ...opts.env,
      DATABASE_URL: opts.testUrl,
      EXPECT_DATABASE_URL: opts.testUrl,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const code = await child.exited;
  const line = stdout.split("\n").find((l) => l.startsWith(opts.sentinel));
  if (code !== 0 || !line) {
    throw new Error(`child ${opts.path} failed (exit ${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return JSON.parse(line.slice(opts.sentinel.length)) as T;
}
